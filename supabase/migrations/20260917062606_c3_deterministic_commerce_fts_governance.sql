-- C3 deterministic commerce support: source-only FTS and governed registry.
-- This migration must not be applied without a new exact HEAD/TREE authorization.

create table if not exists public.c3_deterministic_rule_registry (
  id uuid primary key default gen_random_uuid(),
  company_id uuid null references public.company(id) on delete cascade,
  rule_id text not null,
  version text not null,
  locale text not null check (locale in ('en-US','zh-HK','zh-TW','*')),
  market text not null check (market in ('US','HK','TW','UNKNOWN','*')),
  intent text not null,
  priority integer not null check (priority between 0 and 1000),
  definition jsonb not null check (jsonb_typeof(definition)='object'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from timestamptz not null,
  effective_until timestamptz null,
  author_id uuid not null references auth.users(id),
  approval_status text not null default 'draft' check (approval_status in ('draft','approved','revoked')),
  approved_by uuid null references auth.users(id),
  approved_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  unique(company_id,rule_id,version),
  check (effective_until is null or effective_until > effective_from),
  check (approved_by is null or approved_by <> author_id),
  check ((approval_status='draft' and approved_by is null and approved_at is null and revoked_at is null)
      or (approval_status='approved' and approved_by is not null and approved_at is not null and revoked_at is null)
      or (approval_status='revoked' and approved_by is not null and approved_at is not null and revoked_at is not null))
);

create table if not exists public.c3_deterministic_response_template (
  id uuid primary key default gen_random_uuid(),
  company_id uuid null references public.company(id) on delete cascade,
  template_id text not null,
  version text not null,
  locale text not null check (locale in ('en-US','zh-HK','zh-TW')),
  market text not null check (market in ('US','HK','TW','UNKNOWN','*')),
  intent text not null,
  action text not null check (action in ('clarify','answer','offer_handoff','handoff_pending')),
  required_slots text[] not null default '{}',
  required_facts text[] not null default '{}',
  forbidden_facts text[] not null default '{}',
  prohibited_claims text[] not null default '{}',
  body text not null check (length(trim(body)) between 1 and 4000),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from timestamptz not null,
  effective_until timestamptz null,
  author_id uuid not null references auth.users(id),
  approval_status text not null default 'draft' check (approval_status in ('draft','approved','revoked')),
  approved_by uuid null references auth.users(id),
  approved_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  unique(company_id,template_id,version),
  check (effective_until is null or effective_until > effective_from),
  check (approved_by is null or approved_by <> author_id),
  check ((approval_status='draft' and approved_by is null and approved_at is null and revoked_at is null)
      or (approval_status='approved' and approved_by is not null and approved_at is not null and revoked_at is null)
      or (approval_status='revoked' and approved_by is not null and approved_at is not null and revoked_at is not null))
);

create table if not exists public.c3_deterministic_kb_document (
  document_id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company(id) on delete cascade,
  tenant_id text not null,
  title text not null,
  market text not null check (market in ('US','HK','TW','GLOBAL')),
  locale text not null check (locale in ('en-US','zh-HK','zh-TW')),
  publication_state text not null check (publication_state in ('draft','published','superseded','cancelled')),
  currentness text not null check (currentness in ('current','historical')),
  review_status text not null check (review_status in ('pending','approved','rejected')),
  active boolean not null default false,
  source_priority integer not null default 0,
  effective_at timestamptz not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  unique(company_id,tenant_id,document_id)
);

create table if not exists public.c3_deterministic_kb_chunk (
  chunk_id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.c3_deterministic_kb_document(document_id) on delete cascade,
  version_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (length(trim(content)) between 1 and 20000),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  search_vector tsvector generated always as (to_tsvector('pg_catalog.simple', coalesce(content,''))) stored,
  unique(document_id,version_id,chunk_index)
);

create index if not exists c3_deterministic_kb_scope_idx
  on public.c3_deterministic_kb_document(company_id,tenant_id,market,publication_state,currentness,review_status,active);
create index if not exists c3_deterministic_kb_chunk_fts_idx
  on public.c3_deterministic_kb_chunk using gin(search_vector);

alter table public.c3_deterministic_rule_registry enable row level security;
alter table public.c3_deterministic_response_template enable row level security;
alter table public.c3_deterministic_kb_document enable row level security;
alter table public.c3_deterministic_kb_chunk enable row level security;

create policy c3_rule_staff_read on public.c3_deterministic_rule_registry for select to authenticated
using (exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role::text in ('admin','supervisor','qa')));
create policy c3_rule_staff_draft on public.c3_deterministic_rule_registry for insert to authenticated
with check (author_id=(select auth.uid()) and approval_status='draft' and approved_by is null);
create policy c3_rule_independent_approval on public.c3_deterministic_rule_registry for update to authenticated
using (exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role::text in ('admin','supervisor','qa')) and author_id<>(select auth.uid()))
with check (approved_by=(select auth.uid()) and author_id<>(select auth.uid()) and approval_status in ('approved','revoked'));

create policy c3_template_staff_read on public.c3_deterministic_response_template for select to authenticated
using (exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role::text in ('admin','supervisor','qa')));
create policy c3_template_staff_draft on public.c3_deterministic_response_template for insert to authenticated
with check (author_id=(select auth.uid()) and approval_status='draft' and approved_by is null);
create policy c3_template_independent_approval on public.c3_deterministic_response_template for update to authenticated
using (exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role::text in ('admin','supervisor','qa')) and author_id<>(select auth.uid()))
with check (approved_by=(select auth.uid()) and author_id<>(select auth.uid()) and approval_status in ('approved','revoked'));

revoke all on public.c3_deterministic_rule_registry, public.c3_deterministic_response_template,
  public.c3_deterministic_kb_document, public.c3_deterministic_kb_chunk from public, anon;
grant select, insert on public.c3_deterministic_rule_registry, public.c3_deterministic_response_template to authenticated;
grant update(approval_status,approved_by,approved_at,revoked_at) on public.c3_deterministic_rule_registry, public.c3_deterministic_response_template to authenticated;
grant all on public.c3_deterministic_rule_registry, public.c3_deterministic_response_template,
  public.c3_deterministic_kb_document, public.c3_deterministic_kb_chunk to service_role;

create or replace function public.c3_deterministic_kb_search(
  p_company_id uuid,
  p_tenant_id text,
  p_market text,
  p_locale text,
  p_query text,
  p_limit integer default 5
) returns table(
  document_id uuid, version_id uuid, chunk_id uuid, title text,
  content text, document_sha256 text, chunk_sha256 text,
  rank real, candidate_count bigint, ambiguous_match boolean
)
language sql stable security invoker set search_path=''
as $fn$
  with scoped as (
    select d.document_id,c.version_id,c.chunk_id,d.title,c.content,
      d.content_sha256 as document_sha256,c.content_sha256 as chunk_sha256,
      (ts_rank_cd(c.search_vector,websearch_to_tsquery('pg_catalog.simple',left(trim(p_query),500)),32)
       + case when lower(d.title)=lower(trim(p_query)) then 1 else 0 end
       + greatest(d.source_priority,0)::real/10000) as rank
    from public.c3_deterministic_kb_document d
    join public.c3_deterministic_kb_chunk c on c.document_id=d.document_id
    where p_company_id is not null and d.company_id=p_company_id
      and p_tenant_id is not null and d.tenant_id=p_tenant_id
      and p_market in ('US','HK','TW') and d.market in (p_market,'GLOBAL')
      and p_locale in ('en-US','zh-HK','zh-TW') and d.locale=p_locale
      and d.publication_state='published' and d.currentness='current'
      and d.review_status='approved' and d.active
      and length(trim(p_query)) between 2 and 500
      and c.search_vector @@ websearch_to_tsquery('pg_catalog.simple',left(trim(p_query),500))
  ), ranked as (
    select s.*,count(*) over() as candidate_count,
      lead(rank) over(order by rank desc,document_id asc,version_id asc,chunk_id asc) as next_rank
    from scoped s
  )
  select document_id,version_id,chunk_id,title,content,document_sha256,chunk_sha256,
    rank,candidate_count,(next_rank is not null and abs(rank-next_rank)<0.000001)::boolean
  from ranked
  order by rank desc,document_id asc,version_id asc,chunk_id asc
  limit least(greatest(coalesce(p_limit,5),1),10)
$fn$;

revoke all on function public.c3_deterministic_kb_search(uuid,text,text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.c3_deterministic_kb_search(uuid,text,text,text,text,integer)
  to service_role;

comment on function public.c3_deterministic_kb_search(uuid,text,text,text,text,integer) is
  'Read-only tenant/company/market/locale-bound deterministic FTS. No model, embedding or external fallback.';
