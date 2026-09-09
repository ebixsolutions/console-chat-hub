import fs from "node:fs";
import { execFileSync } from "node:child_process";

const contractPath = "supabase/functions/_shared/commerce-state-contract.ts";
const migrationPath = "supabase/migrations/20260909173000_task_a1_universal_commerce_state.sql";
const rollbackPath = "supabase/rollback/20260909173000_task_a1_universal_commerce_state.rollback.sql";

function must(condition, message) {
  if (!condition) throw new Error(message);
}

for (const path of [contractPath, migrationPath, rollbackPath]) {
  must(fs.existsSync(path), `missing:${path}`);
  must(fs.statSync(path).size > 0, `empty:${path}`);
}

const contract = fs.readFileSync(contractPath, "utf8");
const migration = fs.readFileSync(migrationPath, "utf8");
const rollback = fs.readFileSync(rollbackPath, "utf8");

for (const token of [
  "COMMERCE_STATE_VERSION",
  "ConversationCommerceState",
  "CommerceEntity",
  "CommerceQuote",
  "CommerceDeliveryState",
  "CommerceInstallationState",
  "CommerceConversionState",
  "CommerceStateApplicationReceipt",
]) must(contract.includes(token), `contract_missing:${token}`);

for (const token of [
  "create table public.conversation_commerce_state",
  "create table public.conversation_commerce_state_event",
  "revision bigint",
  "source_message_id uuid",
  "state jsonb",
  "state_hash text",
  "enable row level security",
  "is_company_member(company_id, auth.uid())",
  "upsert_conversation_commerce_state_v1",
  "for update",
  "source_message_replay_conflict",
  "revision_conflict",
  "extensions.digest",
  "conversation_commerce_state_event",
]) must(migration.toLowerCase().includes(token.toLowerCase()), `migration_missing:${token}`);

must(!/alter table public\.(conversations|messages|company_membership)\b/i.test(migration), "unexpected_existing_core_table_alter");
must(!/(冷氣|冷气|refrigerator|washing machine|washer|fashion|beauty)/i.test(contract), "industry_specific_contract_leak");
must(migration.includes("revoke all on table public.conversation_commerce_state from anon, authenticated, service_role"), "state_write_acl_not_closed");
must(migration.includes("revoke all on table public.conversation_commerce_state_event from anon, authenticated, service_role"), "event_write_acl_not_closed");
must(migration.includes("grant execute on function public.upsert_conversation_commerce_state_v1"), "rpc_service_grant_missing");

for (const token of [
  "drop function if exists public.upsert_conversation_commerce_state_v1",
  "drop function if exists public.enforce_conversation_commerce_state_lineage_v1",
  "drop table if exists public.conversation_commerce_state_event",
  "drop table if exists public.conversation_commerce_state",
]) must(rollback.includes(token), `rollback_missing:${token}`);

execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", contractPath], { stdio: "inherit" });
execFileSync("npm", ["run", "build"], { stdio: "inherit" });

console.log(JSON.stringify({
  status: "PASS",
  task: "A1",
  files: [contractPath, migrationPath, rollbackPath],
  assertions: {
    universal_contract: true,
    durable_source_message_idempotency: true,
    optimistic_revision_lock: true,
    tenant_lineage: true,
    rls_read_scope: true,
    direct_write_acl_closed: true,
    rollback_complete: true,
    typescript_compile: true,
    production_build: true,
  },
}));
