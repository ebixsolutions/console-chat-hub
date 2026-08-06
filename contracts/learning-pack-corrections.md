# NexusAI Knowledge Base — Learning Pack Corrections
# Date: 2026-07-30
# Authority: KB Project Memory 2026-07-30 + CE-P1 Project Memory 2026-07-26

## 1. Vector/Embedding status corrections

### CORRECTED: `vector_count 0→4` is NOT a real vector PASS

The 2026-07-15 Learning Pack recorded `vector_count` changing from 0 to 4 as
evidence of a working RAG pipeline. This was INCORRECT.

**True state:**
- `generateEmbeddings` is a stub that returns `"hello"` (not a real embedding)
- `KBVectorChunk` rows are created with `embedding_status = "pending"` and
  `embedding_model = "placeholder"`
- The chunk count increase (`chunk_count × 4`) is a fabricated formula, not
  the result of real embedding generation
- The pipeline then sets `production_vector_status = "indexed"` and
  `available_to_live_console = true` despite no real embedding existing

**Correction:**
```
vector_count 0→4: HISTORICAL DATA-STATE OBSERVATION
Real embedding generation: OPEN — generateEmbeddings is a stub
Add to RAG: HISTORICAL UI/DATA-STATE PASS, not real embedding PASS
```

### CORRECTED: simulated/placeholder embedding must not be marked indexed

Any `KBVectorChunk` with `embedding_model = "placeholder"` or
`embedding_model = "simulated"` must have `embedding_status = "pending"`,
never `"indexed"`. The AI Chatbot grounding adapter (ce-grounding.ts) now
**rejects** chunks with these markers at the retrieval boundary.

## 2. KB005 content_hash root cause

The KB Project Memory 2026-07-30 identified the critical root cause:

```
prepare/reuse KBDocument
→ content_hash empty
→ create KBUserPublishConfirmation with effective_content_hash = ''
→ run Staging RAG
→ Staging writes real KBDocument.content_hash
→ publishDocument / createProductionVectorIndex
→ resolvePublishApproval compares different hashes
→ KB005
```

This explains first-publish failures, mixed batch results, and re-publish
sometimes succeeding. The fix requires computing the canonical hash BEFORE
creating the confirmation record.

## 3. Smart Check re-open

The summary modal depends on volatile React state (`smartDetectSummary`).
Closing it loses the report. Required: clicking the same button must reopen
the latest persisted report, with a `重新檢測` button inside the modal.
Status: OPEN.

## 4. User confirmation publish

User confirmation bypasses KBReview recommendation only. It does NOT bypass:
- auth / publish permission / tenant isolation
- document/version/content integrity
- Staging RAG / embedding / vector generation
- Production Vector
- live verification
- atomicity / idempotency
- content_hash verification

## 5. Three-stage priority (from KB Project Memory 2026-07-30)

### Priority 1 — Authoritative file identity and state
Fix Knowledge Files → Split Results binding so the selected file always loads
the correct title, batch, items, documents, detection state, publish state,
and version state.

### Priority 2 — Publish backend failure
Resolve the 7/7 shared technical failure before Staging RAG and replace
`未知錯誤` with typed, evidence-backed errors.

### Priority 3 — Final active-item publish mapping
Retain targeted regression for: 60 total, 59 deleted, 1 active → 1 publish
target → 1/1 success.

## 6. Architecture distinctions

### Target architecture (design documents and contracts)
- Staging RAG and Production Vector are separate
- Real embeddings required before indexed status
- Publish goes through backend function with RBAC
- content_hash computed before confirmation
- All LLM calls through governed shared router

### Current source state (Base44 export 2026-07-30)
- `generateEmbeddings` returns `"hello"` (stub)
- Frontend `handlePublish` directly updates entity status
- No tenant_id on any KB entity
- Frontend `InvokeLLM` bypasses the governed router
- content_hash drift causes KB005

### Historical UAT results (Learning Pack 2026-07-15)
- UI rendering and navigation: PASS (historical observation)
- Data state changes (vector_count increase): OBSERVATION, not real embedding
- Smart Check trigger and report display: PASS (historical observation)
- Publish flow completion: PARTIAL — KB005 discovered later
