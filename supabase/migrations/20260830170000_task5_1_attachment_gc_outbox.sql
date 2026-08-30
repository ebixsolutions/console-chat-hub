begin;

create table if not exists public.attachment_delete_outbox (
  id uuid primary key default gen_random_uuid(),
  company_id uuid null,
  conversation_id uuid null,
  message_id uuid null,
  storage_bucket text not null,
  storage_path text not null,
  queued_at timestamptz not null default now(),
  processed_at timestamptz null,
  attempts integer not null default 0,
  last_error text null,
  constraint attachment_delete_outbox_bucket_check check (storage_bucket = 'widget-attachments'),
  constraint attachment_delete_outbox_path_check check (length(storage_path) between 1 and 1024),
  constraint attachment_delete_outbox_attempts_check check (attempts between 0 and 1000),
  constraint attachment_delete_outbox_bucket_path_key unique(storage_bucket, storage_path)
);

alter table public.attachment_delete_outbox enable row level security;
revoke all on public.attachment_delete_outbox from public, anon, authenticated;
grant select, insert, update, delete on public.attachment_delete_outbox to service_role;

create or replace function public.enqueue_attachment_delete_before_locator_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.attachment_delete_outbox(
    company_id, conversation_id, message_id, storage_bucket, storage_path, queued_at
  ) values (
    old.company_id, old.conversation_id, old.message_id, old.storage_bucket, old.storage_path, now()
  )
  on conflict (storage_bucket, storage_path) do update
    set company_id = excluded.company_id,
        conversation_id = excluded.conversation_id,
        message_id = excluded.message_id,
        queued_at = least(public.attachment_delete_outbox.queued_at, excluded.queued_at),
        processed_at = null,
        last_error = null;
  return old;
end;
$$;

revoke all on function public.enqueue_attachment_delete_before_locator_delete() from public, anon, authenticated;
grant execute on function public.enqueue_attachment_delete_before_locator_delete() to service_role;

drop trigger if exists trg_enqueue_attachment_delete on public.message_attachment_private;
create trigger trg_enqueue_attachment_delete
before delete on public.message_attachment_private
for each row execute function public.enqueue_attachment_delete_before_locator_delete();

-- Backfill any current storage objects that have already lost their private locator row.
insert into public.attachment_delete_outbox(storage_bucket, storage_path, queued_at)
select o.bucket_id, o.name, coalesce(o.created_at, now())
from storage.objects o
left join public.message_attachment_private p
  on p.storage_bucket = o.bucket_id and p.storage_path = o.name
where o.bucket_id = 'widget-attachments'
  and p.message_id is null
on conflict (storage_bucket, storage_path) do nothing;

-- Keep only recent completion audit rows after GC; pending rows are never auto-dropped.
create index if not exists attachment_delete_outbox_pending_idx
  on public.attachment_delete_outbox(processed_at, queued_at)
  where processed_at is null;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid='public.message_attachment_private'::regclass
      and tgname='trg_enqueue_attachment_delete'
      and not tgisinternal
  ) then raise exception 'attachment delete outbox trigger missing'; end if;
end $$;

commit;
