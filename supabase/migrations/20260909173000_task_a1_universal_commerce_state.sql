-- Task A1 — Universal canonical commerce / transaction state.
-- Scope: persistence contract only. No generate-reply integration or industry-specific reducer.

create table public.conversation_commerce_state (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  company_id uuid not null references public.company(id) on delete cascade,
  revision bigint not null default 1 check (revision >= 1),
  source_message_id uuid not null references public.messages(id) on delete restrict,
  state jsonb not null,
  state_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversation_commerce_state_object_check
    check (jsonb_typeof(state) = 'object'),
  constraint conversation_commerce_state_version_check
    check (state->>'version' = 'commerce-state-1.0.0'),
  constraint conversation_commerce_state_hash_check
    check (state_hash ~ '^[0-9a-f]{64}$'),
  constraint conversation_commerce_state_source_message_unique
    unique (source_message_id)
);

create index conversation_commerce_state_company_updated_idx
  on public.conversation_commerce_state(company_id, updated_at desc);

alter table public.conversation_commerce_state enable row level security;

create policy conversation_commerce_state_select_staff
on public.conversation_commerce_state
for select
to authenticated
using (
  company_id is not null
  and public.is_company_member(company_id, auth.uid())
);

-- Browser/authenticated users can inspect only their tenant's state. They cannot
-- mutate it directly; canonical writes are server-side and revision guarded.
revoke all on table public.conversation_commerce_state from anon, authenticated;
grant select on table public.conversation_commerce_state to authenticated;
grant select, insert, update, delete on table public.conversation_commerce_state to service_role;

create or replace function public.enforce_conversation_commerce_state_lineage_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
  v_message_conversation_id uuid;
  v_message_role text;
  v_hash text;
begin
  select c.company_id
    into v_company_id
  from public.conversations c
  where c.id = new.conversation_id;

  if v_company_id is null then
    raise exception 'commerce_state_conversation_company_unresolved';
  end if;

  if new.company_id is distinct from v_company_id then
    raise exception 'commerce_state_tenant_mismatch';
  end if;

  select m.conversation_id, m.role
    into v_message_conversation_id, v_message_role
  from public.messages m
  where m.id = new.source_message_id;

  if v_message_conversation_id is null then
    raise exception 'commerce_state_source_message_not_found';
  end if;

  if v_message_conversation_id is distinct from new.conversation_id then
    raise exception 'commerce_state_source_message_mismatch';
  end if;

  if lower(coalesce(v_message_role, '')) not in ('visitor', 'customer', 'user') then
    raise exception 'commerce_state_source_message_not_customer';
  end if;

  if jsonb_typeof(new.state) is distinct from 'object' then
    raise exception 'commerce_state_invalid_state';
  end if;

  if new.state->>'version' is distinct from 'commerce-state-1.0.0' then
    raise exception 'commerce_state_version_mismatch';
  end if;

  v_hash := encode(extensions.digest(new.state::text, 'sha256'), 'hex');
  new.state_hash := v_hash;
  new.updated_at := now();
  return new;
end
$function$;

revoke all on function public.enforce_conversation_commerce_state_lineage_v1() from public, anon, authenticated;

drop trigger if exists trg_conversation_commerce_state_lineage
  on public.conversation_commerce_state;
create trigger trg_conversation_commerce_state_lineage
before insert or update
on public.conversation_commerce_state
for each row
execute function public.enforce_conversation_commerce_state_lineage_v1();

create or replace function public.upsert_conversation_commerce_state_v1(
  p_conversation_id uuid,
  p_company_id uuid,
  p_expected_revision bigint,
  p_source_message_id uuid,
  p_state jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_conversation_company_id uuid;
  v_message_conversation_id uuid;
  v_message_role text;
  v_existing public.conversation_commerce_state%rowtype;
  v_hash text;
  v_revision bigint;
begin
  if p_conversation_id is null
     or p_company_id is null
     or p_source_message_id is null
     or p_expected_revision is null
     or p_expected_revision < 0
     or p_state is null
     or jsonb_typeof(p_state) is distinct from 'object'
     or p_state->>'version' is distinct from 'commerce-state-1.0.0' then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  -- Lock the parent row first. This serializes first-write and subsequent-write
  -- races for the same conversation, including the case where state does not yet exist.
  select c.company_id
    into v_conversation_company_id
  from public.conversations c
  where c.id = p_conversation_id
  for update;

  if not found then
    return jsonb_build_object('result', 'conversation_not_found');
  end if;

  if v_conversation_company_id is null then
    return jsonb_build_object('result', 'conversation_company_unresolved');
  end if;

  if v_conversation_company_id is distinct from p_company_id then
    return jsonb_build_object('result', 'tenant_mismatch');
  end if;

  select m.conversation_id, m.role
    into v_message_conversation_id, v_message_role
  from public.messages m
  where m.id = p_source_message_id;

  if not found then
    return jsonb_build_object('result', 'source_message_not_found');
  end if;

  if v_message_conversation_id is distinct from p_conversation_id then
    return jsonb_build_object('result', 'source_message_mismatch');
  end if;

  if lower(coalesce(v_message_role, '')) not in ('visitor', 'customer', 'user') then
    return jsonb_build_object('result', 'source_message_not_customer');
  end if;

  v_hash := encode(extensions.digest(p_state::text, 'sha256'), 'hex');

  select *
    into v_existing
  from public.conversation_commerce_state s
  where s.conversation_id = p_conversation_id
  for update;

  if found then
    if v_existing.source_message_id = p_source_message_id then
      if v_existing.state_hash = v_hash then
        return jsonb_build_object(
          'result', 'success',
          'idempotent', true,
          'revision', v_existing.revision,
          'state_hash', v_existing.state_hash
        );
      end if;
      return jsonb_build_object(
        'result', 'source_message_replay_conflict',
        'revision', v_existing.revision
      );
    end if;

    if v_existing.revision <> p_expected_revision then
      return jsonb_build_object(
        'result', 'revision_conflict',
        'expected_revision', p_expected_revision,
        'actual_revision', v_existing.revision
      );
    end if;

    update public.conversation_commerce_state
      set company_id = p_company_id,
          revision = v_existing.revision + 1,
          source_message_id = p_source_message_id,
          state = p_state,
          state_hash = v_hash,
          updated_at = now()
    where conversation_id = p_conversation_id
    returning revision into v_revision;

    return jsonb_build_object(
      'result', 'success',
      'idempotent', false,
      'revision', v_revision,
      'state_hash', v_hash
    );
  end if;

  if p_expected_revision <> 0 then
    return jsonb_build_object(
      'result', 'revision_conflict',
      'expected_revision', p_expected_revision,
      'actual_revision', 0
    );
  end if;

  insert into public.conversation_commerce_state(
    conversation_id,
    company_id,
    revision,
    source_message_id,
    state,
    state_hash
  ) values (
    p_conversation_id,
    p_company_id,
    1,
    p_source_message_id,
    p_state,
    v_hash
  );

  return jsonb_build_object(
    'result', 'success',
    'idempotent', false,
    'revision', 1,
    'state_hash', v_hash
  );
end
$function$;

revoke all on function public.upsert_conversation_commerce_state_v1(uuid, uuid, bigint, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_conversation_commerce_state_v1(uuid, uuid, bigint, uuid, jsonb)
  to service_role;

comment on table public.conversation_commerce_state is
  'Canonical cross-industry commerce/transaction state. One tenant-bound, revisioned row per conversation.';
comment on function public.upsert_conversation_commerce_state_v1(uuid, uuid, bigint, uuid, jsonb) is
  'Atomic idempotent server-side write contract for canonical commerce state. Source-message replay cannot mutate state.';
