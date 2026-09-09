-- Rollback for Task A1 universal commerce state.
-- Safe only before A2/A3 begin depending on this state contract.

begin;

drop function if exists public.upsert_conversation_commerce_state_v1(uuid, uuid, bigint, uuid, jsonb);

drop trigger if exists trg_conversation_commerce_state_lineage
  on public.conversation_commerce_state;

drop function if exists public.enforce_conversation_commerce_state_lineage_v1();

drop table if exists public.conversation_commerce_state;

commit;
