# Read-only runtime check — results and next steps

## 1. Package baseline (HEAD `9b24ce7`, worktree clean)
React 19.2, TanStack Start 1.167 / Router 1.168, `@supabase/supabase-js` 2.108, Tailwind 4.2, zod 4.4, recharts 2.15, sonner 2.0, lucide 0.575, `@lovable.dev/mcp-js` 0.20, `@lovable.dev/cloud-auth-js` 1.1. No AI SDK packages (model calls live in Edge Functions). Baseline intact — no missing/duplicated router or UI deps.

## 2. Database state (live)
| Metric | Value |
|---|---|
| company | 0 |
| company_membership | 0 |
| conversations | 142 (117 not resolved) |
| ce_evaluation_job | 102 total: 98 `cancelled` (last 2026-08-17 07:21Z), 4 `succeeded` (last 2026-08-17 08:47Z), 0 queued / running / failed |
| conversation_evaluation (canonical) | 0 (also 0 in last 7 days) |
| ce_local_evaluation | 7 |
| evaluation_training_outbox | 0 |
| feedback_request | 12 |

`ce_automation_runtime`: `enabled = true`, debounce 10 min, max age 120 min, batch 100, global concurrency 3, per-company 1, `last_background_sweep_at = 2026-08-26 05:33Z` (current). Scheduler is alive and sweeping, but produces no queued jobs.

Material state facts: the system is fully pre-activation (zero `company` / `company_membership` rows), all evaluations live in the local tables, canonical `conversation_evaluation` is empty, and no training outbox rows exist — so no canonical or training path has ever run end-to-end in this project.

## 3. Recent Edge Function logs
- `ce-evaluation-worker`: continuous boot/shutdown cycle every ~60 s (2026-08-26 05:54Z → 06:04Z), 265–870 ms boots, **zero ERROR lines**. Cron tick is healthy and idle.
- `generate-reply`, `kb-search-proxy`, `agent-assist`, `conversation-evaluate`, `ce-evaluation-control`, `training-outbox-worker`, `training-result-receiver`, `training-kb-sync`, `training-kb-finalize`: **no log entries at all** in the retained window (last hour). No errors, and also no traffic — these paths are currently unexercised.

## 4. Singapore KB context-search probe — BLOCKED
Not performed. Two independent blockers, both environmental, not code:
- Secret values (`KB_RAG_ENDPOINT`, `KB_SINGAPORE_API_KEY_HEADER`, `KB_SINGAPORE_TENANT_API_KEYS_JSON`, `KB_RAG_TOKEN`) are readable only inside the deployed Edge Function runtime, never from this environment, so no direct call to `POST {KB_RAG_ENDPOINT}/api/v1/rag/context-search` is possible.
- The indirect route through the deployed `kb-search-proxy` requires a signed-in console session; the preview session is `signed_out`, so the call returned `401 UNAUTHORIZED_NO_AUTH_HEADER` before reaching the handler. Nothing was printed and nothing was mutated.

To complete this probe, one of these is needed: (a) sign in to the Lovable preview so an authenticated session is injected on the next turn — then `kb-search-proxy` can be probed read-only with `{query, top_k}` and the real response schema reported; or (b) authorization to add a temporary read-only diagnostic path that echoes only the upstream schema shape (no secrets, no content).

## 5. `widget.ebixmall.com/knowledge-base/.../items` — reachable, contract not self-describing
- `GET https://widget.ebixmall.com/knowledge-base/knowledge-files/f54370678af6453299fcb4f4a83d3fba/items` → **200**, `text/html`, 874 bytes. It is an empty SPA shell (`<div id="root">`) that loads `/knowledge-base/assets/index-CLANJaJm.js`; the URL path segment is a client-side route, not a data API.
- The bundle (2.7 MB, fetched read-only) shows this KB console is a **Base44 app**. Data access goes through `https://app.base44.com/api/apps/{APP_ID}/entities/{EntityName}` (plus `/functions/{name}`, `/agents/{name}`, `/ai/openai/v1`, `/analytics/track/batch`, `/api/apps/auth/logout`). Entity names are built dynamically at call time (`entities/${e.name}`), so the specific item/document entity is not statically extractable; only `entities/User` appears as a literal. Two candidate app ids appear as literals: `6a12c8b68d8278b4c735e9eb`, `6a180a9f64b0ddf7b28dbb93`.
- No RAG/context-search route appears in this bundle — the ebixmall KB console and the Singapore RAG API used by this app are separate surfaces. No mutating endpoint was called.

Still needed to bind item/document reads: the exact Base44 entity name for knowledge-file items, the correct `APP_ID`, and a read-scoped API key plus its header name — or a network capture from an authenticated session on that page.

## Proposed next steps (no work started)
1. Sign in to the preview, then re-run the KB context-search probe through `kb-search-proxy` and report the real schema (`context_found`, selected document count, summary/evidence counts, `full_content` presence).
2. Fix the two blocking defects already identified: unvalidated KB item field access in `src/components/console/CRMPanel.tsx` (blank-screen class), and the `Authorization: Bearer` vs `x-api-key` mismatch in `training-kb-sync` / `training-kb-finalize`.
3. Decide whether the canonical CE path (`company` / `company_membership` bootstrap) should be activated, since every evaluation is currently local-only.
