#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const file = "supabase/migrations/20260917062606_c3_deterministic_commerce_fts_governance.sql";
const sql = fs.readFileSync(file, "utf8");
for (const marker of [
  "tsvector",
  "websearch_to_tsquery",
  "c3_deterministic_kb_search",
  "d.company_id=p_company_id",
  "d.tenant_id=p_tenant_id",
  "d.market in (p_market,'GLOBAL')",
  "d.publication_state='published'",
  "d.currentness='current'",
  "d.review_status='approved'",
  "d.active",
  "document_id",
  "version_id",
  "chunk_id",
  "ambiguous_match",
  "security invoker",
  "enable row level security",
  "to service_role",
  "revoked_at",
  "content_sha256",
  "approved_by <> author_id",
])
  assert(sql.includes(marker), `missing:${marker}`);
assert.match(sql, /using\s+gin\s*\(search_vector\)/i);
assert.match(sql, /ORDER BY[\s\S]*rank DESC[\s\S]*document_id ASC[\s\S]*chunk_id ASC/i);
assert.match(
  sql,
  /REVOKE ALL ON FUNCTION public\.c3_deterministic_kb_search[\s\S]*FROM PUBLIC, anon, authenticated/i,
);
const executable = sql.replace(/--.*$/gm, "");
assert.doesNotMatch(executable, /model_endpoint|http_post|net\.http|extensions\.vector/i);
assert(!/ALTER\s+DEFAULT\s+PRIVILEGES/i.test(sql));
console.log("c3 deterministic FTS/governance source tests: PASS");
