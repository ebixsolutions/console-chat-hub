# C3 B12 one-attempt operations executor — activation proposal only

Owner: CONFIRMED_DIRECTOR. Technical executor: WORK. No future engineer dependency.
Control/meta/Manual PASS_FROZEN. No consumer calls are implemented here.
Worker production NOT_RUN; remaining at most one, subject to fresh logs review.

## Selected execution platform and approval boundary

One new, temporary Supabase Edge Function `c3-b12-worker-once` in the EXISTING
project `nrfxhqabwblzxoushgnm`, verify_jwt=true. One private schema
`c3_b12_once` and one non-secret table `c3_b12_once.ledger`, with exactly one row.
There is no new App/backend, proxy with variable targets, RPC, role, extension,
secret, scheduler or workflow. The existing Worker v30 is never redeployed.

These new production objects, the internal Vault read, ops ledger writes and
cleanup deployment REQUIRE the separate exact activation approval. None has
been applied. Source/mock approval does not authorize activation.

Supabase documents default SUPABASE_DB_URL and SUPABASE_SERVICE_ROLE_KEY in
Edge Functions. Actual DB connectivity, certificate trust, permissions and the
Dashboard's built-in service_role caller choice are UNVERIFIED until activation
dry-run. Never fill in a missing capability by installing anything or copying a
credential. A dry-run confirms connection/SELECT/UPDATE privilege checks but
does not read the decrypted credential or issue a Worker HTTP request.

## Credential and access boundary

The management caller must match the platform-provided legacy service_role
key for THIS new operations endpoint. Gateway JWT verification is also enabled.
Use only the Dashboard's normal built-in management authorization mechanism;
no manual secret/key entry, API-key export or custom browser fetch. If that
supported authorization choice is unavailable, STOP activation and retain this
concrete caller dependency. An anon or synthetic Admin token is refused.

This management authorization is NOT forwarded to the Worker. The new Edge
internally connects using its default injected DB URL, reads the singleton's
worker_secret_id, then selects ONLY that Vault id. It verifies the original
credential against the pinned direct-hash semantics locally inside Edge (no extra
SQL token parameter); the actual Worker still invokes its unchanged verifier.
Worker HTTP uses only
X-CE-Worker-Token, established by the frozen Worker source. DB URL, management
key, Worker credential, credential hash and raw private headers never leave the
protected Edge runtime. No SQL tool should ever execute the credential SELECT.

SQL uses a fixed read-only snapshot and parameterized credential/ledger queries.
The default DB credential has broad platform privileges; this executor narrows
its source and input paths, it does not claim to create a new least-privilege DB
role. No grants for anon/authenticated/service_role are added to the private
schema/table. RLS is enabled without public policies; only the existing injected
privileged DB identity may access it. Any missing privilege is STOP, not a grant.

## Exact activation/run sequence — Work prepares; Director only approves/tests

1. Director approves the exact manifest and payload hashes in this package.
   Work checks original repo branch, intervening source, absence of proposed
   objects and remaining Worker allowance. No push: existing branch-wide CI
   would repeat frozen gates. Source stays only under ops/b12-worker-once.
2. Work applies activation.sql once (no IF EXISTS/replacement), then deploys
   deploy-payload.json using Supabase deploy_edge_function. No original Edge or
   SQL function body changes. Database activation only inserts the one ops row.
3. Director uses Supabase Dashboard > nrfx project > Edge Functions >
   c3-b12-worker-once > Test > POST, built-in service_role authorization,
   Request Body = dry-run.json, then Send Request ONCE. Do not copy/reveal a
   key or private header. If no supported management authorization is offered,
   STOP; do not type or retrieve a key. Return only the sanitized response.
4. If dry-run passes, Work fresh-verifies Worker v30 config/ezbr identity from
   worker-identity.json; current dependency MD5, exact full rows/hashes, registry,
   runtime=false, preserved binding, no intervening Worker/unknown send, and sole
   sender/remaining allowance. Only then apply arm.sql. Arming must be followed
   within 60 seconds by the one execution; otherwise zero send/STOP, do not
   renew guards or reset the activation slot without separately reviewed scope.
5. Director uses SAME function Test, SAME built-in management authorization,
   body = execute.json, and Send Request ONCE. The executor reads/prepares the
   credential internally, rechecks guards and atomically commits spent_at before
   returning its private send closure. It does not lock business tables across
   HTTP. Any committed intent or unknown result is permanently spent. There is
   no retry, redirects are manual and NOT followed, TLS validation mandatory,
   outbound response/body timeout 10 seconds and body cap 4096 bytes.
6. Work reads read-ledger.sql (non-secret only) and the same snapshot.sql and
   full original before/after rows. Correlate actual Worker logs/version30 with
   the single HTTP request's UTC/id if available; missing ids NOT_AVAILABLE.
   Actual409/error=realtime_claim_rejected/reason=conversation_not_evaluable/
   fixed job AND full invariants/config unchanged are needed. The receipt's PASS
   is bounded executor evidence, not whole-product acceptance. Unknown/failure
   means no second execution. Preserve original consumers and historical FAIL.
7. Work disables the row using disable.sql and, after checking the new function
   has not been changed by another operator, deploys disable-payload.json to
   ONLY c3-b12-worker-once. It then returns410/no secret access/no HTTP forever.
   Preserve the private ledger, even if unsent: NEVER delete/reset/recreate it.
   Do not delete business data or revert any original backend. If intervening
   changes exist, STOP cleanup mutation and report them rather than overwriting.

The unarmed row expires24h; arming shortens it to5min and requires guards reviewed
within60s. Expiry/disable never refunds an existing spent intent. Persistent
ledger plus transaction row lock implements at-most-one send attempt, NOT
cross-system exactly-once delivery. If the process dies after commit and before
HTTP, allowance still remains spent. No claim RPC is used as a test substitute.

Production effects after approval: one new Edge deployment + schema/table/one
ops row; arming, spent and sanitized receipt updates; internal exact Vault read;
one fixed Worker POST; disable row and tombstone deployment. Authentication
metadata writes=0. Original jobs/model/messages/methodology/state/runtime and
credential binding must remain unchanged. Ops ledger writes are real writes and
will be reported separately; never claim the activated round is entirely readonly.

## Commands and evidence

node --test ops/b12-worker-once/executor.test.mjs
npx --yes deno@2.5.0 check --no-lock --config ops/b12-worker-once/deno.json ops/b12-worker-once/index.mjs

Mocks replace all transport and global fetch denies egress. Only fake credentials
are used. Mock PASS is NOT production Worker PASS. Check tests-and-capabilities.json
for actual results, including initial tooling/config errors and final corrected
check. Local Deno registry egress was refused; the final successful check used
byte-identical runtime copies in b12-ops-validation, the same pinned postgres3.4.5
installed through npm, and nodeModulesDir=manual for local resolution only.
Actual platform bundling with nodeModulesDir=none is still an activation assertion.
deploy-payload.json is the complete structured MCP argument, not a sample.
No new production result => no final-gate run. Actual Worker result => append
evidence and run the unchanged full final-gate once; preserve historical exit1.

Original B12 consumers stay frozen. B12 not accepted until Worker actual evidence
passes. General claim OPTIONAL/PARKED; UATfalse. F13/F14/B27/legal Agent/
Section15/Quality95/full UAT remain separately unfinished.
