"""
Production Vector Store — 真實 embedding + pgvector 寫入 / 查詢 / rollback。

取代前一版 publish_operation_core.write_one_doc_production 的 placeholder。

設計目標（回應 QA CONDITIONAL FAIL gap #1）：
  1. Production vector 為真實寫入，不是只切狀態。
  2. 於 PostgreSQL + pgvector 上使用真實 `vector(N)` 欄位與 `<=>` cosine ANN 查詢。
  3. 無 pgvector（如 sqlite 測試）時，回退到 in-Python cosine over JSONB，
     仍是真實可查詢向量（非 chunk_count×4 捏造）。
  4. Embedding 來源：有 Vertex 憑證用 Vertex text-embedding；否則用
     deterministic local embedder（真實 token-hash → L2-normalized 向量），
     明確標記 vector_store='local_embedding'，不謊稱 production embedding。
  5. Rollback 會真正刪除 production vector 並重置狀態。

安全 / 完整性：
  - production 寫入失敗必拋出 → 上層記為 PRODUCTION_WRITE_FAILED（fail-closed）。
  - RAG 查詢強制 tenant / published / environment filter，no-context 回明確契約。
"""
from __future__ import annotations

from app.core.shared_attempt_guard import AccountingDenied
import hashlib
import math
import re
from typing import Any, Optional

from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import KBDocument, KBDocumentVersion, KBVectorChunk

EMBED_DIMS = settings.embedding_dims  # 768


# ══════════════════════════════════════════════════════════════════════════
# Embedding — 真實向量（Vertex 或 deterministic local fallback）
# ══════════════════════════════════════════════════════════════════════════
_TOKEN_RE = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]", re.IGNORECASE)


def _tokenize(text_in: str) -> list[str]:
    return [t.lower() for t in _TOKEN_RE.findall(text_in or "")]


def _local_embed(text_in: str, dims: int = EMBED_DIMS) -> list[float]:
    """
    Deterministic local embedder。

    非捏造：以 token hashing 建 bag-of-words 向量再 L2-normalize。
    相同/重疊文字會得到高 cosine 相似度，可支撐真實檢索。
    僅在無真實 provider 憑證時使用，並以 vector_store='local_embedding' 標記。
    """
    vec = [0.0] * dims
    toks = _tokenize(text_in)
    if not toks:
        # 空文字 → 穩定非零向量，避免除零
        vec[0] = 1.0
        return vec
    for tok in toks:
        h = hashlib.sha1(tok.encode("utf-8")).digest()
        idx = int.from_bytes(h[:4], "big") % dims
        sign = 1.0 if (h[4] & 1) else -1.0
        vec[idx] += sign
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        vec[0] = 1.0
        return vec
    return [v / norm for v in vec]


def embed_text(text_in: str, model: Optional[str] = None) -> tuple[list[float], str, str]:
    """
    回傳 (vector, embedding_model, vector_store_kind)。

    有 Vertex 憑證 → 真 Vertex embedding。
    否則 → local_embedding，但若 settings.require_production_embedding=True
    （production 預設），則 fail-closed 拋錯，禁止未授權 fallback（回應 QA gap G）。
    """
    if settings.vertex_sa_json:
        try:
            from app.core.llm import generate_embedding
            v = generate_embedding(text_in, model=model)
            if v:
                norm = math.sqrt(sum(x * x for x in v)) or 1.0
                return ([x / norm for x in v],
                        model or settings.embedding_model, "pgvector")
        except AccountingDenied:
            raise
        except Exception as e:
            if settings.require_production_embedding:
                raise RuntimeError(
                    f"PRODUCTION_EMBEDDING_FAILED: provider error, "
                    f"local fallback forbidden in production: {e}")
    if settings.require_production_embedding:
        raise RuntimeError(
            "PRODUCTION_EMBEDDING_FORBIDDEN: no production embedding provider "
            "configured (set GOOGLE_APPLICATION_CREDENTIALS) and "
            "REQUIRE_PRODUCTION_EMBEDDING=true blocks local fallback")
    return _local_embed(text_in), "local_embedding", "local_embedding"


# ══════════════════════════════════════════════════════════════════════════
# pgvector 偵測 + DDL
# ══════════════════════════════════════════════════════════════════════════
_PGVEC_CACHE: dict = {}


def pgvector_available(db: Session) -> bool:
    key = str(db.bind.url) if db.bind else "default"
    if key in _PGVEC_CACHE:
        return _PGVEC_CACHE[key]
    ok = False
    try:
        if db.bind and db.bind.dialect.name == "postgresql":
            row = db.execute(sa_text(
                "SELECT 1 FROM pg_extension WHERE extname='vector'")).first()
            ok = row is not None
    except Exception:
        ok = False
    _PGVEC_CACHE[key] = ok
    return ok


def ensure_prod_vector_table(db: Session) -> None:
    """建立 pgvector production 向量表 + ANN index（idempotent）。"""
    if not pgvector_available(db):
        return
    db.execute(sa_text(f"""
        CREATE TABLE IF NOT EXISTS kb_prod_vec (
            chunk_id      text PRIMARY KEY,
            document_id   text NOT NULL,
            version_id    text,
            tenant_id     text,
            chunk_index   integer,
            chunk_type    text,
            chunk_text    text,
            embedding     vector({EMBED_DIMS}) NOT NULL,
            created_at    timestamptz DEFAULT now()
        )
    """))
    db.execute(sa_text(
        "CREATE INDEX IF NOT EXISTS kb_prod_vec_doc_idx "
        "ON kb_prod_vec (document_id)"))
    db.execute(sa_text(
        "CREATE INDEX IF NOT EXISTS kb_prod_vec_tenant_idx "
        "ON kb_prod_vec (tenant_id)"))
    # ANN cosine index（ivfflat 需資料後才最佳；建立不阻塞）
    try:
        db.execute(sa_text(
            "CREATE INDEX IF NOT EXISTS kb_prod_vec_ann_idx "
            "ON kb_prod_vec USING ivfflat (embedding vector_cosine_ops) "
            "WITH (lists = 100)"))
    except Exception:
        # ivfflat 需要 analyze / 資料量；失敗不阻塞，查詢仍可用 seq scan cosine
        db.rollback()
        ensure_prod_vector_table_no_ann(db)


def ensure_prod_vector_table_no_ann(db: Session) -> None:
    db.execute(sa_text(f"""
        CREATE TABLE IF NOT EXISTS kb_prod_vec (
            chunk_id text PRIMARY KEY, document_id text NOT NULL,
            version_id text, tenant_id text, chunk_index integer,
            chunk_type text, chunk_text text,
            embedding vector({EMBED_DIMS}) NOT NULL,
            created_at timestamptz DEFAULT now())
    """))


def _vec_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{x:.8f}" for x in vec) + "]"


# ══════════════════════════════════════════════════════════════════════════
# Production 寫入 — 真實 embedding + pgvector upsert
# ══════════════════════════════════════════════════════════════════════════
def write_production_vectors(db: Session, doc: KBDocument,
                             version_id: Optional[str]) -> dict:
    """
    為 doc 的 exact effective content 建立 production chunk + 真實 embedding，
    寫入 KBVectorChunk(environment='production') 與（若可用）pgvector 表。

    回傳 {chunk_count, vector_count, vector_store}。
    失敗必拋出，交由上層記 PRODUCTION_WRITE_FAILED。
    """
    from app.services.kb_services import chunk_content, hash_content

    content = doc.raw_content or ""
    if not content.strip():
        raise RuntimeError("PRODUCTION_WRITE_FAILED: empty effective content")

    vid = version_id or doc.active_version_id or (doc.version or "")
    chunks = chunk_content(content, source_type=doc.source_type or "")

    # supersede 舊 production chunk（同 doc）
    old = (db.query(KBVectorChunk)
           .filter(KBVectorChunk.document_id == doc.id,
                   KBVectorChunk.environment == "production",
                   KBVectorChunk.status == "active").all())
    for o in old:
        o.status = "superseded"

    use_pg = pgvector_available(db)
    if use_pg:
        ensure_prod_vector_table(db)
        # 清掉此 doc 舊 production 向量
        db.execute(sa_text("DELETE FROM kb_prod_vec WHERE document_id=:d"),
                   {"d": doc.id})

    vector_count = 0
    store_kind = "local_embedding"
    content_hash = hash_content(content)

    for i, ch in enumerate(chunks):
        vec, emb_model, store_kind = embed_text(ch["text"])
        if not vec or len(vec) != EMBED_DIMS:
            raise RuntimeError(
                f"PRODUCTION_WRITE_FAILED: bad embedding dims={len(vec) if vec else 0}")
        row = KBVectorChunk(
            document_id=doc.id, version_id=vid or "", chunk_index=i,
            chunk_text=ch["text"], token_count=ch["tokens"],
            chunk_type=ch["type"], environment="production",
            status="active", embedding_status="generated",
            embedding_model=emb_model, embedding_vector=vec,
            embedding_dimensions=EMBED_DIMS,
            vector_store=("pgvector" if use_pg else store_kind),
            created_by=doc.created_by, tenant_id=doc.tenant_id,
            company_id=doc.company_id,
        )
        db.add(row)
        db.flush()  # 取得 row.id
        if use_pg:
            db.execute(sa_text("""
                INSERT INTO kb_prod_vec
                  (chunk_id, document_id, version_id, tenant_id,
                   chunk_index, chunk_type, chunk_text, embedding)
                VALUES (:cid, :did, :vid, :tid, :ix, :ct, :txt,
                        CAST(:emb AS vector))
                ON CONFLICT (chunk_id) DO UPDATE SET embedding=EXCLUDED.embedding
            """), {"cid": row.id, "did": doc.id, "vid": vid or "",
                   "tid": doc.tenant_id, "ix": i, "ct": ch["type"],
                   "txt": ch["text"], "emb": _vec_literal(vec)})
        vector_count += 1

    if vector_count == 0:
        raise RuntimeError("PRODUCTION_WRITE_FAILED: zero vectors produced")

    # 綁定 canonical hash 與計數（stale 偵測 / UI 顯示用真實數字）
    doc.content_hash = content_hash
    doc.chunk_count = len(chunks)
    doc.vector_count = vector_count

    return {"chunk_count": len(chunks), "vector_count": vector_count,
            "vector_store": ("pgvector" if use_pg else store_kind),
            "indexed_content_hash": content_hash}


def remove_production_vectors(db: Session, doc_id: str,
                              version_id: Optional[str] = None) -> int:
    """Rollback：刪除 production 向量並重置狀態。回傳刪除數。"""
    q = (db.query(KBVectorChunk)
         .filter(KBVectorChunk.document_id == doc_id,
                 KBVectorChunk.environment == "production"))
    if version_id:
        q = q.filter(KBVectorChunk.version_id == version_id)
    rows = q.all()
    n = len(rows)
    for r in rows:
        db.delete(r)
    if pgvector_available(db):
        if version_id:
            db.execute(sa_text(
                "DELETE FROM kb_prod_vec WHERE document_id=:d AND version_id=:v"),
                {"d": doc_id, "v": version_id})
        else:
            db.execute(sa_text(
                "DELETE FROM kb_prod_vec WHERE document_id=:d"), {"d": doc_id})
    return n


# ══════════════════════════════════════════════════════════════════════════
# RAG Context Search — MASTER §24 aggregated context 契約
# ══════════════════════════════════════════════════════════════════════════
def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


def rag_context_search(db: Session, query: str, *,
                       tenant_id: Optional[str] = None,
                       top_k: int = 12,
                       score_threshold: float = 0.05,
                       max_documents: int = 1,
                       max_summary: int = 1,
                       max_full_chunks: int = 3) -> dict:
    """
    POST /api/v1/rag/context-search 的核心。

    vector candidate → tenant/published filter → threshold → group by doc
    → doc-level score (highest + 0.2*second) → 選 top doc
    → 0–3 non-duplicative full_content chunks → structured llm_context + citations。

    No qualified context → explicit no-context 契約（safe fallback / handoff）。
    """
    qvec, _, _ = embed_text(query)
    use_pg = pgvector_available(db)
    candidates: list[dict] = []

    if use_pg:
        ensure_prod_vector_table(db)
        params: dict[str, Any] = {"q": _vec_literal(qvec), "k": top_k}
        tenant_clause = ""
        if tenant_id is not None:
            tenant_clause = "WHERE v.tenant_id = :tid"
            params["tid"] = tenant_id
        rows = db.execute(sa_text(f"""
            SELECT v.chunk_id, v.document_id, v.version_id, v.chunk_index,
                   v.chunk_type, v.chunk_text,
                   1 - (v.embedding <=> CAST(:q AS vector)) AS score
            FROM kb_prod_vec v
            {tenant_clause}
            ORDER BY v.embedding <=> CAST(:q AS vector)
            LIMIT :k
        """), params).mappings().all()
        candidates = [dict(r) for r in rows]
    else:
        # portable fallback：in-Python cosine over active production JSONB chunks
        q = (db.query(KBVectorChunk)
             .filter(KBVectorChunk.environment == "production",
                     KBVectorChunk.status == "active"))
        if tenant_id is not None:
            q = q.filter(KBVectorChunk.tenant_id == tenant_id)
        for c in q.all():
            ev = c.embedding_vector
            if isinstance(ev, list):
                vec = ev
            elif isinstance(ev, dict):
                vec = ev.get("values") or ev.get("value")
            else:
                vec = None
            if not vec:
                continue
            candidates.append({
                "chunk_id": c.id, "document_id": c.document_id,
                "version_id": c.version_id, "chunk_index": int(c.chunk_index or 0),
                "chunk_type": c.chunk_type, "chunk_text": c.chunk_text,
                "score": _cosine(qvec, vec)})
        candidates.sort(key=lambda x: x["score"], reverse=True)
        candidates = candidates[:top_k]

    # Candidate Production vectors may coexist with the currently-live set during
    # publish preparation. Never expose an off-live candidate through RAG: only
    # chunks whose version_id equals the document active_version_id are eligible.
    active_doc_ids = {c.get("document_id") for c in candidates if c.get("document_id")}
    active_docs = {}
    if active_doc_ids:
        for d in db.query(KBDocument).filter(KBDocument.id.in_(active_doc_ids)).all():
            active_docs[d.id] = d
    candidates = [
        c for c in candidates
        if (active_docs.get(c.get("document_id"))
            and active_docs[c["document_id"]].status == "published"
            and active_docs[c["document_id"]].available_to_live_console is True
            and active_docs[c["document_id"]].production_vector_status == "indexed"
            and c.get("version_id") == active_docs[c["document_id"]].active_version_id)
    ]

    qualified = [c for c in candidates if c["score"] >= score_threshold]
    if not qualified:
        return {"has_context": False, "reason": "no_qualified_context",
                "llm_context": "", "citations": [], "documents": [],
                "fallback": "safe_handoff"}

    # group by document, doc-level score = highest + 0.2*second
    by_doc: dict[str, list[dict]] = {}
    for c in qualified:
        by_doc.setdefault(c["document_id"], []).append(c)
    doc_scores = []
    for did, chs in by_doc.items():
        chs.sort(key=lambda x: x["score"], reverse=True)
        top = chs[0]["score"]
        second = chs[1]["score"] if len(chs) > 1 else 0.0
        doc_scores.append((did, top + 0.2 * second, chs))
    doc_scores.sort(key=lambda x: x[1], reverse=True)
    doc_scores = doc_scores[:max_documents]

    documents, citations, context_parts = [], [], []
    for did, dscore, chs in doc_scores:
        doc = db.query(KBDocument).filter(KBDocument.id == did).first()
        # rag_summary（若有），最多 max_summary
        summaries = [c for c in chs if c["chunk_type"] == "rag_summary"][:max_summary]
        fulls = [c for c in chs if c["chunk_type"] != "rag_summary"]
        # 去重（相同 text 不重複）
        seen, uniq = set(), []
        for c in fulls:
            key = c["chunk_text"][:120]
            if key in seen:
                continue
            seen.add(key)
            uniq.append(c)
            if len(uniq) >= max_full_chunks:
                break
        for s in summaries:
            context_parts.append(f"[summary] {s['chunk_text']}")
        for c in uniq:
            context_parts.append(f"[evidence] {c['chunk_text']}")
            citations.append({
                "document_id": did,
                "document_title": getattr(doc, "name", None) if doc else None,
                "chunk_id": c["chunk_id"], "chunk_type": c["chunk_type"],
                "score": round(c["score"], 4),
                "label": (getattr(doc, "name", None) if doc else did)})
        documents.append({"document_id": did, "doc_score": round(dscore, 4),
                          "chunk_count": len(chs)})

    return {"has_context": True, "reason": "ok",
            "llm_context": "\n\n".join(context_parts),
            "citations": citations, "documents": documents,
            "meta": {"candidates": len(candidates),
                     "qualified": len(qualified),
                     "vector_store": "pgvector" if use_pg else "local_embedding"}}


# ══════════════════════════════════════════════════════════════════════════
# RAG Context Search — knowledge-base 移植版（company_id 由 api_key header 解析）
# 對應 knowledge-base/app/main.py 的 POST /api/v1/rag/context-search
# ══════════════════════════════════════════════════════════════════════════
def _normalize_text(text: str) -> str:
    """Collapse all whitespace sequences into single spaces. 對齊 chunk_text 可能包含的換行和多餘空格。"""
    return " ".join((text or "").strip().split())


def _json_int(v) -> int | None:
    """chunk_index 在 nexus 模型為 Numeric（共享 DB 回傳 Decimal），
    直接進 JSON 會 TypeError，故統一轉 int。"""
    return int(v) if v is not None else None


def kb_context_search(db: Session, query: str, *,
                      company_id: int,
                      candidate_top_k: int = 10,
                      max_documents: int = 1,
                      max_summary_chunks: int = 1,
                      max_full_content_chunks: int = 3,
                      score_threshold: float = 0.7) -> dict:
    """
    knowledge-base context-search 邏輯移植：

    candidate chunk（production env + company 隔離 + 已 embedding + 文件未刪除）
    → in-Python cosine → top candidate_top_k → threshold + doc.status==published
    → group by doc（doc score = highest + 0.2×second）→ 選 top max_documents
    → 每份文件最多 max_summary_chunks 條 rag_summary + max_full_content_chunks 條
      full_content → structured llm_context（[SUMMARY]/[EVIDENCE n]）+ citations。

    No qualified context → 明確 no-context 契約（fallback.safe handoff）。
    回傳 dict 即 knowledge-base 的 JSON body（router 直接包 JSONResponse）。
    """
    qvec, _, _ = embed_text(_normalize_text(query))
    if not qvec:
        raise RuntimeError("empty embedding result")

    # 4. Fetch candidate chunks：production env、已 embedding、company 隔離。
    #    ★ embedding_status 兼容兩種 pipeline：knowledge-base 寫 "completed"、
    #      nexus 寫 "generated"（共用同一張 kb_vector_chunk 表）。
    #    文件刪除/下架由下方 doc.status == "published" 過濾（nexus KBDocument 無 is_deleted 欄位）。
    rows = (
        db.query(KBVectorChunk)
        .join(KBDocument, KBVectorChunk.document_id == KBDocument.id)
        .filter(
            KBVectorChunk.embedding_status.in_(["completed", "generated"]),
            KBVectorChunk.embedding_vector.isnot(None),
            KBVectorChunk.company_id == company_id,
            KBVectorChunk.environment == "production",
            KBVectorChunk.status == "active",
            KBVectorChunk.version_id == KBDocument.active_version_id,
            KBDocument.status == "published",
            KBDocument.available_to_live_console.is_(True),
            KBDocument.production_vector_status == "indexed",
        )
        .all()
    )

    # 5. Cosine similarity scoring（in-Python，與 knowledge-base 相同）
    scored_chunks: list[dict] = []
    doc_ids_set: set[str] = set()
    for chunk in rows:
        ev = chunk.embedding_vector
        if isinstance(ev, dict):
            ev = ev.get("values") or ev.get("value")
        if not isinstance(ev, list) or not ev or not chunk.document_id:
            continue
        score = _cosine(qvec, ev)
        scored_chunks.append({"chunk": chunk, "score": score,
                              "document_id": chunk.document_id})
        doc_ids_set.add(chunk.document_id)

    # candidate_top_k：依分數排序後截取候選 chunks
    scored_chunks.sort(key=lambda x: x["score"], reverse=True)
    candidates = scored_chunks[:candidate_top_k]

    # 6. Load related documents
    docs_map: dict[str, Any] = {}
    if doc_ids_set:
        for d in (db.query(KBDocument)
                  .filter(KBDocument.id.in_(doc_ids_set)).all()):
            docs_map[d.id] = d

    # 7. Filter by score threshold and document status
    qualified_chunks: list[dict] = []
    for sc in candidates:
        doc = docs_map.get(sc["document_id"])
        if not doc:
            continue
        if sc["score"] < score_threshold:
            continue
        if doc.status != "published":
            continue
        sc["doc"] = doc
        qualified_chunks.append(sc)

    # 8. If no qualified chunks, return fallback（no-context 契約）
    if not qualified_chunks:
        return {
            "success": True,
            "query": query,
            "context_found": False,
            "selected_documents": [],
            "llm_context": {"summary_count": 0, "evidence_count": 0,
                            "combined_text": ""},
            "citations": [],
            "fallback": {"required": True, "reason": "no_qualified_context"},
        }

    # 9. Group by document_id and compute document scores
    doc_groups: dict[str, list[dict]] = {}
    for qc in qualified_chunks:
        doc_groups.setdefault(qc["document_id"], []).append(qc)

    doc_scores: list[dict] = []
    for did, group in doc_groups.items():
        scores = sorted((g["score"] for g in group), reverse=True)
        max_s = scores[0]
        second_s = scores[1] if len(scores) > 1 else 0.0
        doc_scores.append({
            "document_id": did,
            "document_score": round(max_s + second_s * 0.2, 4),
            "chunks": group,
            "doc": docs_map.get(did),
        })

    # 10. Sort by document_score desc and select top documents
    doc_scores.sort(key=lambda x: x["document_score"], reverse=True)
    selected_docs = doc_scores[:max_documents]

    # 11. Build response per document
    selected_documents: list[dict] = []
    citations: list[dict] = []
    all_summaries: list[str] = []
    all_evidences: list[str] = []

    for ds in selected_docs:
        doc = ds["doc"]
        group = ds["chunks"]

        # Separate summary and full_content chunks
        summary_chunks = [c for c in group if c["chunk"].chunk_type == "rag_summary"]
        content_chunks = [c for c in group if c["chunk"].chunk_type != "rag_summary"]

        # Sort each group by score desc
        summary_chunks.sort(key=lambda x: x["score"], reverse=True)
        content_chunks.sort(key=lambda x: x["score"], reverse=True)

        # Get top summaries（max max_summary_chunks）
        top_summaries = summary_chunks[:max_summary_chunks]

        # Get top content chunks（0–max_full_content_chunks）
        top_evidences = content_chunks[:max_full_content_chunks]

        # Build summary object
        summary_obj = None
        if top_summaries:
            best_summary = top_summaries[0]
            summary_obj = {
                "chunk_id": best_summary["chunk"].id or "",
                "chunk_index": _json_int(best_summary["chunk"].chunk_index),
                "chunk_type": best_summary["chunk"].chunk_type or "",
                "content": _normalize_text(best_summary["chunk"].chunk_text),
                "score": round(best_summary["score"], 4),
            }
            all_summaries.append(_normalize_text(best_summary["chunk"].chunk_text))

        # Build evidence list
        evidence_list: list[dict] = []
        for ev in top_evidences:
            evidence_list.append({
                "chunk_id": ev["chunk"].id or "",
                "chunk_index": _json_int(ev["chunk"].chunk_index),
                "chunk_type": ev["chunk"].chunk_type or "",
                "content": _normalize_text(ev["chunk"].chunk_text),
                "score": round(ev["score"], 4),
            })
            all_evidences.append(_normalize_text(ev["chunk"].chunk_text))

        # Determine relevance label
        ds_doc_score = ds["document_score"]
        relevance = "low"
        if ds_doc_score >= 0.85:
            relevance = "high"
        elif ds_doc_score >= 0.75:
            relevance = "medium"

        doc_entry: dict = {
            "document_id": ds["document_id"],
            "title": doc.name or "",
            "source_type": doc.source_type or "",
            "document_score": ds["document_score"],
        }
        if summary_obj:
            doc_entry["summary"] = summary_obj
        doc_entry["evidence"] = evidence_list

        selected_documents.append(doc_entry)

        citations.append({
            "document_id": ds["document_id"],
            "label": doc.name or "",
            "source_type": doc.source_type or "",
            "relevance": relevance,
        })

    # 12. Build combined_text for LLM
    combined_parts: list[str] = []
    if all_summaries:
        for i, s in enumerate(all_summaries):
            label = "[SUMMARY]" if len(all_summaries) == 1 else f"[SUMMARY {i + 1}]"
            combined_parts.append(f"{label}\n{s}")
    for i, e in enumerate(all_evidences):
        combined_parts.append(f"[EVIDENCE {i + 1}]\n{e}")

    combined_text = "\n\n".join(combined_parts)

    return {
        "success": True,
        "query": query,
        "context_found": True,
        "selected_documents": selected_documents,
        "llm_context": {"summary_count": len(all_summaries),
                        "evidence_count": len(all_evidences),
                        "combined_text": combined_text},
        "citations": citations,
        "meta": {"candidate_chunks": len(candidates),
                 "qualified_chunks": len(qualified_chunks),
                 "selected_documents": len(selected_documents),
                 "score_threshold": score_threshold},
    }
