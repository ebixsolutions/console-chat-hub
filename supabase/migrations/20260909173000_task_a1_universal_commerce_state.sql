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
  constraint conversation_commerce_state_conversation_company_unique
    unique (conversation_id, company_id)
);

-- Durable applied-message ledger. The canonical row stores only the latest
-- source_message_id, so durable replay protection must keep every applied source.
create table public.conversation_commerce_state_event (
  source_message_id uuid primary key references public.messages(id) on delete restrict,
  conversation_id uuid not null,
  company_id uuid not null,
  applied_revision bigint not null check (applied_revision >= 1),
  state_hash text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint conversation_commerce_state_event_revision_unique
    unique (conversation_id, applied_revision),
  constraint conversation_commerce_state_event_parent_fk
    foreign key (conversation_id, company_id)
    references public.conversation_commerce_state(conversation_id, company_id)
    on delete cascade
);

create index conversation_commerce_state_company_updated_idx
  on public.conversation_commerce_state(company_id, updated_at desc);
create index conversation_commerce_state_event_company_created_idx
  on public.conversation_commerce_state_event(company_id, created_at desc);

alter table public.conversation_commerce_state enable row level security;
alter table public.conversation_commerce_state_event enable row level security;

create policy conversation_commerce_state_select_staff
on public.conversation_commerce_state
for select
to authenticated
using (
  company_id is not null
  and public.is_company_member(company_id, auth.uid())
);

create policy conversation_commerce_state_event_select_staff
on public.conversation_commerce_state_event
for select
to authenticated
using (
  company_id is not null
  and public.is_company_member(company_id, auth.uid())
);

-- Browser/authenticated users can inspect only their tenant's state. No caller
-- receives direct table mutation rights; canonical writes go through the RPC.
revoke all on table public.conversation_commerce_state from anon, authenticated, service_role;
revoke all on table public.conversation_commerce_state_event from anon, authenticated, service_role;
grant select on table public.conversation_commerce_state to authenticated, service_role;
grant select on table public.conversation_commerce_state_event to authenticated, service_role;

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

revoke all on function public.enforce_conversation_commerce_state_lineage_v1()
  from public, anon, authenticated, service_role;

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
  v_receipt public.conversation_commerce_state_event%rowtype;
  v_hash text;
  v_revision bigint;
  v_current_revision bigint;
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

  -- Durable idempotency: check the append-only receipt before looking only at
  -- the latest canonical row. A replay of any historical source message is safe.
  select *
    into v_receipt
  from public.conversation_commerce_state_event e
  where e.source_message_id = p_source_message_id;

  if found then
    if v_receipt.conversation_id is distinct from p_conversation_id
       or v_receipt.company_id is distinct from p_company_id
       or v_receipt.state_hash is distinct from v_hash then
      return jsonb_build_object(
        'result', 'source_message_replay_conflict',
        'applied_revision', v_receipt.applied_revision
      );
    end if;

    select s.revision
      into v_current_revision
    from public.conversation_commerce_state s
    where s.conversation_id = p_conversation_id;

    return jsonb_build_object(
      'result', 'success',
      'idempotent', true,
      'applied_revision', v_receipt.applied_revision,
      'current_revision', v_current_revision,
      'state_hash', v_receipt.state_hash
    );
  end if;

  select *
    into v_existing
  from public.conversation_commerce_state s
  where s.conversation_id = p_conversation_id
  for update;

  if found then
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
  else
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
    )
    returning revision into v_revision;
  end if;

  insert into public.conversation_commerce_state_event(
    source_message_id,
    conversation_id,
    company_id,
    applied_revision,
    state_hash
  ) values (
    p_source_message_id,
    p_conversation_id,
    p_company_id,
    v_revision,
    v_hash
  );

  return jsonb_build_object(
    'result', 'success',
    'idempotent', false,
    'applied_revision', v_revision,
    'current_revision', v_revision,
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
comment on table public.conversation_commerce_state_event is
  'Append-only source-message application ledger for durable commerce-state replay idempotency.';
comment on function public.upsert_conversation_commerce_state_v1(uuid, uuid, bigint, uuid, jsonb) is
  'Atomic tenant-bound commerce-state write. Optimistic revision lock plus durable source-message idempotency.';
