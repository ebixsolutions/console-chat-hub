# AI Chatbot Product-ready Workflow v1

Authoritative repo: `ebixsolutions/console-chat-hub`
Branch: `main`
Planning baseline: `241b5917c1f57ed33ebaa06a58191469a4ef22af`
Base44 Knowledge Base App: `6a12c8b68d8278b4c735e9eb`

## Execution policy

Each workflow has at most 3 functional Tasks. Pre-check, QA, validator, evidence, UAT,
rollback verification, docs and self-QA are internal operations of the same Task and
must not become extra Tasks.

Lovable Chat is prohibited for source implementation, debugging, code generation,
code review, replacement-package work, or routine validation.

Lovable Chat may be used only when strictly necessary for:
1. Lovable-native publish/deploy operations that cannot be performed through direct tools.
2. Supabase migration / Edge Function deploy / runtime operations that cannot be performed
   through direct Supabase/Lovable tools.

For all other work:
- read Lovable source directly;
- read Base44 source/entities directly;
- implement via local replacement package;
- apply through GitHub Desktop / `apply.command`;
- commit and push through GitHub.

No production data writes, schema changes, deployments, or secret changes without the
Task's explicit authorization.

---

# Workflow 1 — Runtime & Knowledge Closure

## Task 1.1 — Canonical Widget / Inbox / Agent runtime closure

Scope:
- Make Widget Live AI Test reuse the same production `generate-reply` answer/escalation pipeline.
- Preserve persistent Live Test history and Inbox visibility as explicitly tagged test data.
- Validate Right CRM Knowledge/Policy payloads at runtime before render.
- Remove any blank-screen path from malformed KB result fields.
- Keep production Widget, Inbox, Assign/Takeover/Transfer/Return-to-AI, attachments,
  new conversation, history, human handoff, and atomic AI reply behavior unchanged.

Production-blocking assertions:
- one answer/escalation implementation only;
- R1 / S0 / required escalation / warm handoff preserved;
- no unvalidated `content.slice`, `score.toFixed`, or `issues.map` on upstream payloads;
- no fake queue position/wait-time metrics;
- Widget test data excluded from training/canonical customer semantics.

## Task 1.2 — Knowledge Base read/write contract closure

Authoritative sources:
- Base44 live app `6a12c8b68d8278b4c735e9eb` for KBDocument, KBDocumentVersion,
  KBVectorChunk, KBPublishOperation and backend functions.
- Singapore server for the external RAG/write runtime contract only.

Already confirmed from Base44:
- `KBDocument`
- `KBDocumentVersion`
- `KBVectorChunk`
- `KBPublishOperation`
- `TrainingKnowledgeProposal`
- `KBSyncLog`

Singapore server information still required:
- production RAG base URL + `/api/v1/rag/context-search`;
- authentication header contract and tenant-bound API key semantics;
- canonical company_id → Singapore tenant_id mapping contract;
- exact RAG request/response/no-context schema;
- document write/version/publish/status/rollback API contract;
- content-hash/version/conflict/idempotency/error/rate-limit/timeout rules.

Implementation outcome:
- one shared KB auth helper for read + training write-back;
- eliminate legacy Bearer/JWT-only assumptions in `training-kb-sync` and
  `training-kb-finalize` if Singapore contract confirms `x-api-key`;
- preserve `full_content` as factual grounding source;
- preserve `rag_summary` / `faq_pair` / `section` as non-authoritative contextual/reference data
  unless the Singapore contract explicitly changes that rule.

## Task 1.3 — Runtime KB + Widget production smoke closure

End-to-end:
`visitor → Widget → receive → Inbox → generate-reply → Singapore KB → Vertex
→ assistant message → poll → explicit human handoff → agent takeover → return-to-AI`.

Also validate:
- history/new conversation;
- attachments;
- Right CRM Knowledge;
- Agent Assist Suggest Reply;
- Policy check;
- KB no-context behavior;
- one real grounded answer;
- tenant/key isolation;
- no duplicate assistant reply.

Exit:
Task is READY only when actual runtime assertions pass. Source presence/import/static checks alone are not PASS.

---

# Workflow 2 — Canonical Tenant, CE & SU CoachAI Activation

## Task 2.1 — Canonical SU Platform company identity activation

Scope:
- Bind the real SU Platform canonical company UUID/integer pair.
- Create/activate canonical `company`, `company_membership`, channel ownership and
  conversation lineage without fabricated IDs.
- Canonical identity always wins over pre-activation.
- Remove production reliance on preview/demo role fallbacks.

Assertions:
- exactly-one canonical company per activated user context;
- RLS/RBAC and cross-tenant denial;
- channel → company and conversation → company lineage;
- no null-company production customer conversation after activation.

## Task 2.2 — Canonical Conversation Evaluation activation

Current live fact:
- canonical `conversation_evaluation` is empty;
- local CE exists and automation is enabled.

Scope:
- rebind local CE into canonical CE without rerunning LLM where frozen score/provenance is valid;
- preserve six-dimension scoring and review semantics;
- activate scheduler/worker on canonical tenant scope;
- keep stale/current methodology behavior and idempotent queueing.

Assertions:
- local→canonical mapping complete;
- no cross-tenant evaluation reads/writes;
- auto-evaluation worker/scheduler/dwell operate on real canonical conversations;
- no duplicate/superseded-current corruption.

## Task 2.3 — AI Chatbot → SU CoachAI → Knowledge Base learning loop

Scope:
- canonical evaluation accepted/reviewed;
- exactly-once `evaluation_training_outbox`;
- SU CoachAI receives bundle;
- result receiver persists final result;
- KB proposal/write-back/version/publish completes through the contract closed in Task 1.2;
- next RAG query can retrieve the updated published knowledge.

Assertions:
- idempotent outbox/result processing;
- correct tenant lineage end-to-end;
- content hash conflict blocks overwrite;
- publish failure leaves prior active knowledge available;
- rollback is safe;
- no training data generated from Widget Live Test rows.

---

# Workflow 3 — Whole-product Product-ready Closure

## Task 3.1 — Product surface truth & legacy/mock retirement

Scope:
- Customer360 shows only authoritative data or explicit unavailable state;
- Feedback/Visitor Analytics/Channel settings use live backend;
- remove production dependency on mock settings modules;
- retire or quarantine unreferenced legacy Widget/KB paths such as `chat-v2.js`
  and obsolete `kb-adapter` only after proving no live caller remains;
- no fake/demo/static metrics on production UI.

Assertions:
- no production route imports mock datasets;
- no duplicate active Widget runtime;
- unavailable integrations remain truthful, not fabricated.

## Task 3.2 — Security, build, rollback & two-tenant closure

Internal to this Task:
- auth/RBAC/RLS;
- tenant isolation;
- atomicity/idempotency;
- production build/typecheck;
- migration/rollback;
- Edge boot/runtime;
- two-tenant read + write denial;
- critical smoke.

No separate validator/UAT/evidence Task is allowed.

## Task 3.3 — Final production activation & whole-product smoke

One final Product-ready flow:
`register/canonical company → Widget → AI/KB → Inbox → handoff → agent actions
→ resolve → feedback → CE → review → SU CoachAI → KB update → next retrieval`.

READY requires:
- all P0 gates PASS;
- no BLOCKED / NOT RUN / nonzero final-gate;
- no unresolved production mock/fake path;
- no unresolved canonical tenant identity;
- no old Singapore KB auth path;
- rollback proven for deployment changes.

Final product status values are mutually exclusive:
- READY
- STOP (external unavoidable blocker)
- FAIL
