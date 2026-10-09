-- PROPOSED ONLY. Needs exact activation approval. Never rerun after a spent row.
begin;
create schema c3_b12_once;
revoke all on schema c3_b12_once from public, anon, authenticated, service_role;
create table c3_b12_once.ledger (
  operation text primary key check(operation='C3-B12-WORKER-ONCE-20261009-42eee3e7'),
  armed boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '24 hours',
  guards_reviewed_at timestamptz,
  spent_at timestamptz,
  receipt jsonb
);
alter table c3_b12_once.ledger enable row level security;
revoke all on c3_b12_once.ledger from public, anon, authenticated, service_role;
insert into c3_b12_once.ledger(operation) values ('C3-B12-WORKER-ONCE-20261009-42eee3e7');
commit;
