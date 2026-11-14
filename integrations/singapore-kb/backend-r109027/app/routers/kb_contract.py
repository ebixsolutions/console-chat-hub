"""
KB API Contract（PM1）— REST 風格跨系統 API

對照 d:/User/桌面/PM1.txt 的 31 支端點，對外提供：
  - api_key header（X-API-Key / api_key，值 = 表 company.api_key）認證，
    company/tenant scope 一律 server-side resolve（不信任 frontend 傳入 scope）。
  - uat_session_id 支援 anonymous/public-session ownership（建立 guest registry）。
  - company_id 綁定：有效 api_key 即通過（admin 門禁已移除）。

實作策略：
  - 大部分端點直接委派到既有 /api/functions/{name} 的實作（同一邏輯，新 URL 面）。
  - 契約 shape 與舊端點不同者，在此層做轉換或新寫（document vectors、
    archive-test-data、migrate-global-document-id、vertex-gemini、
    platform llm/test、agent-registry cleanup、storage-test、firecrawl scrape/test、
    website crawl status / import-items）。
  - POST /api/v1/rag/context-search 已由 rag_ops 提供（AI Chatbot 使用中），不重複註冊。
"""
from __future__ import annotations

import os
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.auth import AuthContext
from app.core.config import settings
from app.core.database import get_db
from app.core import llm as llm_mod
from app.core.tenant_ctx import set_tenant_context
from app.models import (
    Company, CrawledPageResult, KBAgentRegistry, KBDocument,
    KBDocumentVersion, KBGuestImportSession, KBImportBatch, KBImportItem,
    KBVectorChunk, PlatformLLMProviderConfig, WebsiteImportJob,
)

# ── 既有實作（委派目標）──
from app.routers.import_ops import (   # noqa: E402
    kb_import_batch_create, kb_import_start, kb_extract_step, kb_import_finalize,
)
from app.routers.lifecycle_ops import (   # noqa: E402
    kb_rollback_import_batch, kb_restore_archived_batch, kb_archive_document,
    kb_restore_archived_document, kb_permanent_delete_document,
    kb_reset_knowledge_base,
)
from app.routers.publish_ops import (   # noqa: E402
    kb_publish_start, kb_publish_get_status, kb_publish_continue,
    kb_publish_resume, kb_publish_recover_stalled, kb_publish_cancel,
)
from app.routers.website_ops import kb_start_website_crawl   # noqa: E402
from app.routers.platform_ops import (   # noqa: E402
    generate_industry_templates as _platform_generate_industry_templates,
    generate_single_template as _platform_generate_single_template,
)

from app.services.kb_services import hash_content   # noqa: E402

router = APIRouter(prefix="", tags=["kb-contract"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return uuid.uuid4().hex


def _err(status: int, error: str, detail: Any = None) -> JSONResponse:
    body = {"success": False, "error": {"code": error}}
    if detail is not None:
        body["error"]["detail"] = detail
    return JSONResponse(status_code=status, content=body)


# ══════════════════════════════════════════════════════════════════════════
# Auth：api_key header → company（server-side scope resolve）
# ══════════════════════════════════════════════════════════════════════════
class ApiContext:
    """api_key header → company 解析結果（server-side scope）。"""

    def __init__(self, company: Company, is_admin: bool,
                 uat_session_id: Optional[str]):
        self.company = company
        self.company_id = int(company.id)
        self.is_admin = is_admin
        self.uat_session_id = uat_session_id

    @property
    def tenant_id(self) -> str:
        if self.uat_session_id:
            return f"guest_{self.uat_session_id}"
        return f"company_{self.company_id}"

    @property
    def user_id(self) -> str:
        return self.tenant_id

    def auth_context(self) -> AuthContext:
        """產生可供既有端點函式使用的 AuthContext stub（tenant 隔離主鍵 = user.id）。"""
        return AuthContext(
            user_id=self.user_id,
            tenant_id=self.tenant_id,
            role="admin" if self.is_admin else "user",
            company_id=self.company_id,
            email="",
        )


def resolve_api_ctx(
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
    api_key_header: Optional[str] = Header(default=None, alias="api_key"),
    x_service_role_secret: Optional[str] = Header(default=None, alias="X-Service-Role-Secret"),
    uat_session_id_header: Optional[str] = Header(default=None, alias="X-UAT-Session-Id"),
    db: Session = Depends(get_db),
) -> ApiContext:
    api_key = x_api_key or api_key_header
    if not api_key:
        raise HTTPException(401, "api_key header is required")
    company = db.query(Company).filter(Company.api_key == api_key).first()
    if company is None:
        raise HTTPException(401, "invalid api_key")

    is_admin = bool(settings.service_role_secret) \
        and x_service_role_secret == settings.service_role_secret
    ctx = ApiContext(company, is_admin, uat_session_id_header)
    set_tenant_context(ctx.tenant_id, ctx.user_id, ctx.company_id)
    return ctx


def require_company(ctx: ApiContext = Depends(resolve_api_ctx)) -> ApiContext:
    """company_id 綁定：有效 api_key 即通過（門禁僅要求 company 存在）。"""
    if not ctx.company_id:
        raise HTTPException(403, "company_id required")
    return ctx


def _register_guest_session(db: Session, ctx: ApiContext,
                            batch_id: Optional[str]) -> None:
    """Anonymous flow：建立 guest ownership registry（KBGuestImportSession）。"""
    if not ctx.uat_session_id:
        return
    sess = db.query(KBGuestImportSession).filter(
        KBGuestImportSession.session_id == ctx.uat_session_id).first()
    if sess is None:
        db.add(KBGuestImportSession(
            id=_new_id(), session_id=ctx.uat_session_id,
            batch_id=batch_id or "", purpose="uat_import",
            company_id=ctx.company_id, created_by=ctx.user_id,
        ))
        db.commit()


def _body_batch_id(resp: Any) -> Optional[str]:
    if isinstance(resp, dict):
        return resp.get("batchId") or resp.get("batch_id") or resp.get("id")
    return None


def _embedding_provider() -> dict:
    return {"provider": "vertex" if settings.vertex_sa_json else "vertex_fallback"}


# ══════════════════════════════════════════════════════════════════════════
# A. Import / Parsing（1–5）
# ══════════════════════════════════════════════════════════════════════════
@router.post("/kb/import/batches")
def import_batches(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """建立文件導入 batch，取得穩定 batch_id。"""
    body.setdefault("uat_session_id", ctx.uat_session_id)
    resp = kb_import_batch_create(body, db, ctx.auth_context())
    _register_guest_session(db, ctx, _body_batch_id(resp))
    return resp


@router.post("/kb/import/start")
def import_start(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """將完整文件 enumeration 成 KBImportItem。"""
    body.setdefault("uat_session_id", ctx.uat_session_id)
    resp = kb_import_start(body, db, ctx.auth_context())
    _register_guest_session(db, ctx, _body_batch_id(resp))
    return resp


@router.post("/kb/import/extract-step")
def import_extract_step(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """每次抽取一個 enumerated item，避免 backend timeout。"""
    body.setdefault("uat_session_id", ctx.uat_session_id)
    return kb_extract_step(body, db, ctx.auth_context())


@router.post("/kb/import/finalize")
def import_finalize(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """完成 extraction，統計成功/失敗/需人工檢查項目。"""
    body.setdefault("uat_session_id", ctx.uat_session_id)
    return kb_import_finalize(body, db, ctx.auth_context())


@router.post("/kb/import/rollback")
def import_rollback(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """rollback 一個 import batch，archive 相關 documents / vectors。"""
    return kb_rollback_import_batch(body, db, ctx.auth_context())


# ══════════════════════════════════════════════════════════════════════════
# B. Website Import（6–10）
# ══════════════════════════════════════════════════════════════════════════
@router.post("/kb/websites/crawl")
def websites_crawl(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """啟動 single URL、sitemap 或 selective website import。"""
    body.setdefault("uat_session_id", ctx.uat_session_id)
    resp = kb_start_website_crawl(body, db, ctx.auth_context())
    _register_guest_session(db, ctx, _body_batch_id(resp))
    return resp


@router.post("/kb/websites/crawl/status")
def websites_crawl_status(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """查詢 async Firecrawl job 狀態（以 batch 為準）。"""
    batch_id = body.get("batchId")
    if not batch_id:
        return _err(400, "batchId required")
    batch = db.query(KBImportBatch).filter(KBImportBatch.id == batch_id).first()
    if not batch:
        return _err(404, "Batch not found")

    is_completed = (batch.crawl_status or "") in ("parsed", "completed", "failed")
    resp: dict = {
        "crawl_status": batch.crawl_status or "not_started",
        "pages_found": int(batch.pages_found or 0),
        "pages_crawled": int(batch.pages_crawled or 0),
        "is_completed": is_completed,
        "crawl_mode": batch.crawl_mode,
    }
    if batch.crawl_pages_preview:
        resp["pages_preview"] = batch.crawl_pages_preview
    return resp


@router.post("/kb/websites/import-items")
def websites_import_items(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """將 crawl 結果轉成 canonical Knowledge import items。"""
    batch_id = body.get("batchId")
    if not batch_id:
        return _err(400, "batchId required")
    batch = db.query(KBImportBatch).filter(KBImportBatch.id == batch_id).first()
    if not batch:
        return _err(404, "Batch not found")

    # 以 batch.crawler_job_id 找到 WebsiteImportJob → CrawledPageResult
    pages: list[CrawledPageResult] = []
    job = None
    if batch.crawler_job_id:
        job = db.query(WebsiteImportJob).filter(
            WebsiteImportJob.firecrawl_job_id == batch.crawler_job_id).first()
    if job is not None:
        q = db.query(CrawledPageResult).filter(
            CrawledPageResult.job_id == job.id,
            CrawledPageResult.status == "crawled")
        selected_urls = body.get("selectedUrls")
        if isinstance(selected_urls, list) and selected_urls:
            q = q.filter(CrawledPageResult.source_url.in_(selected_urls))
        pages = q.order_by(CrawledPageResult.id.asc()).all()

    # Canonical path 最多處理 50 pages
    truncation_warning = ""
    if len(pages) > 50:
        truncation_warning = f"TRUNCATED: {len(pages)} pages found, only first 50 processed"
        pages = pages[:50]

    created = 0
    existing_count = db.query(KBImportItem).filter(
        KBImportItem.batch_id == batch_id).count()
    for idx, pg in enumerate(pages):
        content = pg.extracted_markdown or pg.markdown_content or ""
        if not content.strip():
            continue
        db.add(KBImportItem(
            id=_new_id(), batch_id=batch_id, item_index=existing_count + created,
            extracted_title=pg.page_title or pg.source_url or f"Page {idx + 1}",
            original_content=content, ai_suggested_content="", final_content=content,
            source_type="Other", knowledge_type="other", status="pending",
            human_decision="pending", review_status="not_started",
            source_metadata={"source_format": "website", "source_url": pg.source_url,
                             "raw_block_content": content},
            company_id=ctx.company_id, created_by=ctx.user_id,
        ))
        created += 1

    batch.total_items = (batch.total_items or 0) + created
    batch.pages_found = len(pages)
    batch.pages_crawled = len(pages)
    batch.extraction_phase = "extracting"
    batch.crawl_status = "parsed"
    batch.status = "analyzed"
    db.add(batch)
    db.commit()

    resp = {
        "success": True, "items_created": created,
        "batch_status": batch.extraction_phase,
        "pages_found": len(pages),
        "crawl_failure_reason": batch.crawl_failure_reason or "",
    }
    if truncation_warning:
        resp["warning"] = truncation_warning
    return resp


@router.post("/kb/firecrawl/scrape")
def firecrawl_scrape(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """legacy/direct Firecrawl single-page scrape compatibility API。"""
    from app.services.firecrawl_config import resolve_firecrawl_config
    from app.services.firecrawl_log import firecrawl_request

    url = body.get("url")
    if not url:
        return _err(400, "url required")
    api_key, base_url = resolve_firecrawl_config(db)
    if not api_key:
        return _err(503, "firecrawl_not_configured")
    try:
        r = firecrawl_request(db, "POST", f"{base_url}/v1/scrape", api_key,
                              endpoint="/v1/scrape",
                              json_body={"url": url, "formats": ["markdown"]},
                              timeout=60)
        r.raise_for_status()
        data = r.json().get("data") or r.json()
    except Exception as e:
        return _err(502, "firecrawl_error", str(e))

    meta = data.get("metadata") or {}
    content = data.get("markdown") or ""
    batch = KBImportBatch(
        id=_new_id(), batch_name=meta.get("title") or url,
        source_file_type="website", status="uploaded", extraction_status="success",
        extraction_phase="done", total_items=1 if content.strip() else 0,
        crawl_status="parsed", import_source="website_import",
        source_url=url, company_id=ctx.company_id, created_by=ctx.user_id,
    )
    db.add(batch)
    db.flush()
    if content.strip():
        db.add(KBImportItem(
            id=_new_id(), batch_id=batch.id, item_index=0,
            extracted_title=meta.get("title") or url, original_content=content,
            ai_suggested_content="", final_content=content, source_type="Other",
            knowledge_type="other", status="pending", human_decision="pending",
            review_status="not_started",
            source_metadata={"source_format": "website", "source_url": url,
                             "raw_block_content": content},
            company_id=ctx.company_id, created_by=ctx.user_id,
        ))
    db.commit()

    return {
        "success": True,
        "page_result": {
            "id": _new_id(), "source_url": url,
            "page_title": meta.get("title") or "", "crawl_status": "success",
        },
        "import_batch_id": batch.id,
    }


@router.post("/kb/firecrawl/test")
def firecrawl_test(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """測試目前 server-side Firecrawl configuration。"""
    from app.services.firecrawl_config import resolve_firecrawl_config
    from app.services.firecrawl_log import firecrawl_request

    start = time.time()
    try:
        api_key, base_url = resolve_firecrawl_config(db)
        if not api_key:
            return {"success": False,
                    "latency_ms": int((time.time() - start) * 1000),
                    "error_code": "firecrawl_not_configured",
                    "error_message": "FIRECRAWL_API_KEY not configured"}
        r = firecrawl_request(db, "GET", f"{base_url}/v1/team/credit-usage",
                              api_key, endpoint="/v1/team/credit-usage", timeout=15)
        ok = r.status_code == 200
        return {"success": ok,
                "latency_ms": int((time.time() - start) * 1000),
                "error_code": None if ok else f"http_{r.status_code}",
                "error_message": None if ok else (r.text or "")[:200]}
    except Exception as e:
        return {"success": False,
                "latency_ms": int((time.time() - start) * 1000),
                "error_code": "firecrawl_error", "error_message": str(e)}


# ══════════════════════════════════════════════════════════════════════════
# C. Publish Pipeline（11–16）
# ══════════════════════════════════════════════════════════════════════════
@router.post("/kb/publish")
def publish(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """建立可 resumable / idempotent 的 Knowledge publish operation。"""
    return kb_publish_start(body, db, ctx.auth_context())


@router.post("/kb/publish/status")
def publish_status(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """取得 publish operation 最新狀態（兼任 stuck-worker watchdog）。"""
    return kb_publish_get_status(body, db, ctx.auth_context())


@router.post("/kb/publish/continue")
def publish_continue(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """frontend fallback：驅動下一個 bounded publish chunk。"""
    return kb_publish_continue(body, db, ctx.auth_context())


@router.post("/kb/publish/resume")
def publish_resume(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """明確 resume 一個非 terminal publish operation。"""
    return kb_publish_resume(body, db, ctx.auth_context())


@router.post("/kb/publish/recover-stalled")
def publish_recover_stalled(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """主動修復 worker expiry / stale heartbeat。"""
    return kb_publish_recover_stalled(body, db, ctx.auth_context())


@router.post("/kb/publish/cancel")
def publish_cancel(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """idempotent cancel + rollback publish operation。"""
    return kb_publish_cancel(body, db, ctx.auth_context())


# ══════════════════════════════════════════════════════════════════════════
# D. Embedding / RAG（17）
# ══════════════════════════════════════════════════════════════════════════
@router.post("/kb/documents/{document_id}/vectors")
def document_vectors(
    document_id: str,
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """重新生成 staging chunks、RAG summary 或 promote 到 Production Vector。

    action ∈ regenerate_chunks | regenerate_rag_summary | promote
    """
    action = body.get("action")
    if action not in ("regenerate_chunks", "regenerate_rag_summary", "promote"):
        return _err(400, "invalid action",
                    "valid actions: regenerate_chunks, regenerate_rag_summary, promote")

    doc = db.query(KBDocument).filter(KBDocument.id == document_id).first()
    if not doc:
        return _err(404, "Document not found")

    # ★ D-004/D-005 修復：version_id 一律必須對應「此文件既有的 KBDocumentVersion 行」。
    #   先前 `or (doc.version or "") or _new_id()` 會把不存在的隨機 version 綁到 chunk 上，
    #   造成 active_version_id=null 卻 production/indexed/Live 的矛盾狀態。
    #   無版本行的文件（未走 publish/candidate 流程）→ fail-closed 409。
    version_id = body.get("version_id") or doc.active_version_id
    version = None
    if version_id:
        version = (db.query(KBDocumentVersion)
                   .filter(KBDocumentVersion.id == version_id,
                           KBDocumentVersion.document_id == doc.id).first())
    if not version:
        return _err(409, "VERSION_NOT_FOUND_OR_MISMATCH",
                    "document has no authoritative version row; run the publish/candidate "
                    "flow (kbPublishStart) or attach a real KBDocumentVersion first")

    # ── regenerate_chunks：staging chunks 重新 embedding ──
    if action == "regenerate_chunks":
        from app.services.kb_services import chunk_content
        chunks = (db.query(KBVectorChunk)
                  .filter(KBVectorChunk.document_id == document_id,
                          KBVectorChunk.environment == "staging").all())
        content = doc.raw_content or ""
        if not chunks and content.strip():
            for i, ch in enumerate(chunk_content(content, source_type=doc.source_type or "")):
                c = KBVectorChunk(
                    document_id=doc.id, version_id=version_id, chunk_index=i,
                    chunk_text=ch["text"], token_count=ch["tokens"],
                    chunk_type=ch["type"], environment="staging", status="active",
                    embedding_status="pending", company_id=ctx.company_id,
                    created_by=ctx.user_id,
                )
                db.add(c)
                chunks.append(c)
            db.commit()

        vector_count = 0
        for c in chunks:
            vec = llm_mod.generate_embedding(c.chunk_text or "")
            if not vec:
                continue
            c.embedding_vector = vec
            c.embedding_dimensions = len(vec)
            c.embedding_model = settings.embedding_model
            c.embedding_status = "generated"
            c.vector_store = "vertex_embedding" if settings.vertex_sa_json else "local_embedding"
            c.embedded_at = _now()
            db.add(c)
            vector_count += 1
        db.commit()

        doc.staging_vector_status = "indexed"
        doc.vector_count = vector_count
        doc.chunk_count = len(chunks)
        db.add(doc)
        db.commit()

        return {"success": True, "action": "regenerate_chunks",
                "chunk_count": len(chunks), "vector_count": vector_count,
                "embedding_provider": _embedding_provider()}

    # ── regenerate_rag_summary：LLM 產生文件摘要（不篡改原始事實）──
    if action == "regenerate_rag_summary":
        content = doc.raw_content or ""
        if not content.strip():
            return _err(400, "EMPTY_CONTENT", "document has no content")
        try:
            summary = llm_mod.invoke_llm(
                "你是知識庫內容助理。請用繁體中文以 100–200 字摘要以下商業知識文件，"
                "必須涵蓋價格、日期、尺寸、政策、步驟等關鍵事實；"
                "不得臆造文件未提及的事實。\n\n" + content[:12000])
        except Exception as e:
            return _err(502, "llm_error", str(e))
        summary = (summary or "").strip()
        if not summary:
            return _err(502, "llm_error", "LLM returned empty summary")

        rag_summary_hash = hash_content(summary)
        doc.rag_summary = summary
        doc.rag_summary_hash = rag_summary_hash
        db.add(doc)

        # supersede 舊 rag_summary chunk（staging）
        for old in (db.query(KBVectorChunk)
                    .filter(KBVectorChunk.document_id == doc.id,
                            KBVectorChunk.chunk_type == "rag_summary",
                            KBVectorChunk.environment == "staging").all()):
            old.status = "superseded"
            db.add(old)
        db.add(KBVectorChunk(
            document_id=doc.id, version_id=version_id, chunk_index=0,
            chunk_text=summary, chunk_type="rag_summary", environment="staging",
            status="active", embedding_status="pending",
            company_id=ctx.company_id, created_by=ctx.user_id,
        ))
        db.commit()

        return {"success": True, "action": "regenerate_rag_summary",
                "rag_summary": summary, "rag_summary_hash": rag_summary_hash,
                "embedding_provider": _embedding_provider()}

    # ── promote：staging → production（先證明 staging 是 real embeddings）──
    # ★ D-004/D-005 修復：
    #   1) 只有「已 review/已 live」文件才允許被 promote 成 production（fail-closed）；
    #   2) promote 必須與 active_version_id / content_hash / status 原子綁定，
    #      否則會產生 pending_review+production 或 production/Live 但無版本指標的矛盾狀態。
    from app.services.publish_candidate_adapter import canonical_content_hash
    from app.services.vector_store import write_production_vectors
    staging = (db.query(KBVectorChunk)
               .filter(KBVectorChunk.document_id == doc.id,
                       KBVectorChunk.environment == "staging").all())
    real = [c for c in staging
            if c.embedding_status in ("generated", "completed") and c.embedding_vector]
    if not real:
        return _err(400, "NO_REAL_EMBEDDINGS",
                    "staging embeddings must be real before promote")

    if doc.status not in ("published", "approved") and doc.available_to_live_console is not True:
        return _err(409, "DOCUMENT_NOT_REVIEWED",
                    "only reviewed/published documents may be promoted to production; "
                    "run kbPublishStart for candidate activation")

    snapshot = (version.raw_content_snapshot or "").strip()
    if snapshot and canonical_content_hash(snapshot) != canonical_content_hash(
            doc.raw_content or ""):
        return _err(409, "VERSION_CONTENT_MISMATCH",
                    "version snapshot differs from document content; "
                    "activate through the publish/candidate flow instead")

    try:
        res = write_production_vectors(db, doc, version.id)
    except Exception as e:
        return _err(502, "PROMOTE_FAILED", str(e))
    doc.production_vector_status = "indexed"
    doc.production_status = "production"
    doc.available_to_live_console = True
    doc.staging_vector_status = "indexed"
    doc.status = "published"
    doc.active_version_id = version.id
    doc.content_hash = canonical_content_hash(doc.raw_content or "")
    doc.published_at = _now()
    doc.chunk_count = res.get("chunk_count", doc.chunk_count)
    doc.vector_count = res.get("vector_count", doc.vector_count)
    db.add(doc)
    db.commit()

    return {"success": True, "action": "promote",
            "production_chunks": res["chunk_count"], "version_id": version.id}


# ══════════════════════════════════════════════════════════════════════════
# E. Document Lifecycle（18–24）
# ══════════════════════════════════════════════════════════════════════════
@router.post("/kb/documents/{document_id}/archive")
def document_archive(
    document_id: str,
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """archive document，同步停用 live retrieval 及相關 vector chunks。"""
    body.setdefault("documentId", document_id)
    return kb_archive_document(body, db, ctx.auth_context())


@router.post("/kb/documents/{document_id}/restore")
def document_restore(
    document_id: str,
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """將 archived document restore 成 draft。"""
    body.setdefault("documentId", document_id)
    return kb_restore_archived_document(body, db, ctx.auth_context())


@router.delete("/kb/documents/{document_id}")
def document_delete(
    document_id: str,
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(require_company),
    db: Session = Depends(get_db),
):
    """永久刪除 Knowledge document 及其 scoped dependencies（company_id 綁定）。"""
    body.setdefault("documentId", document_id)
    return kb_permanent_delete_document(body, db, ctx.auth_context())


@router.post("/kb/admin/archive-test-data")
def admin_archive_test_data(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(require_company),
    db: Session = Depends(get_db),
):
    """批次 archive test/draft documents（company_id 綁定）。"""
    dry_run = bool(body.get("dryRun", True))
    fp = body.get("filterParams") or {}

    q = db.query(KBDocument)
    status_list = fp.get("status_list")
    if isinstance(status_list, list) and status_list:
        q = q.filter(KBDocument.status.in_(status_list))
    if fp.get("created_after"):
        q = q.filter(KBDocument.created_date >= fp["created_after"])
    if fp.get("created_before"):
        q = q.filter(KBDocument.created_date <= fp["created_before"])
    if fp.get("import_source"):
        q = q.filter(KBDocument.import_source == fp["import_source"])
    if fp.get("source_file_name_contains"):
        q = q.filter(KBDocument.name.ilike(f"%{fp['source_file_name_contains']}%"))
    docs = q.order_by(KBDocument.created_date.asc()).all()

    if dry_run:
        return {"dry_run": True, "total": len(docs), "documents": [{
            "id": d.id, "name": d.name, "status": d.status,
            "created_date": _iso(d.created_date),
            "import_source": d.import_source or "",
        } for d in docs]}

    for d in docs:
        d.status = "archived"
        d.available_to_live_console = False
        d.archived_at = _now()
        d.archived_by = ctx.user_id
        db.add(d)
    db.commit()
    return {"success": True, "dry_run": False, "total": len(docs),
            "archived": len(docs)}


@router.post("/kb/import/batches/{batch_id}/restore")
def import_batch_restore(
    batch_id: str,
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """restore 已 archived / rolled-back batch。"""
    body.setdefault("batchId", batch_id)
    return kb_restore_archived_batch(body, db, ctx.auth_context())


@router.post("/kb/admin/reset")
def admin_reset(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(require_company),
    db: Session = Depends(get_db),
):
    """UAT 用：全量刪除 Knowledge import/runtime test records（company_id 綁定）。"""
    return kb_reset_knowledge_base(body, db, ctx.auth_context())


@router.post("/kb/admin/migrate-global-document-id")
def admin_migrate_global_document_id(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(require_company),
    db: Session = Depends(get_db),
):
    """為 legacy documents 補 global_document_id（company_id 綁定）。"""
    total_scanned = db.query(KBDocument).count()
    docs = db.query(KBDocument).filter(
        (KBDocument.global_document_id.is_(None))
        | (KBDocument.global_document_id == "")).all()
    updated, failed, errors = 0, 0, []
    for d in docs:
        try:
            d.global_document_id = d.id
            db.add(d)
            updated += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            errors.append({"id": d.id, "error": str(e)})
    db.commit()
    return {
        "success": True, "total_scanned": total_scanned,
        "needed_migration": len(docs), "updated": updated, "failed": failed,
        "errors": errors,
        "message": f"Migration complete: {updated} docs updated, {failed} failed",
    }


# ══════════════════════════════════════════════════════════════════════════
# F. Template Generation（25–26）
# ══════════════════════════════════════════════════════════════════════════
@router.post("/kb/templates/generation-jobs/{job_id}/items")
def template_generation_job_items(
    job_id: str,
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """根據 Industry Template Skeleton 建立待生成 template items。"""
    body.setdefault("jobId", job_id)
    return _platform_generate_industry_templates(body, db, ctx.auth_context())


@router.post("/kb/templates/generate")
def template_generate(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """生成單一 business knowledge template。"""
    return _platform_generate_single_template(body, db, ctx.auth_context())


# ══════════════════════════════════════════════════════════════════════════
# G. Platform AI（27–28）
# ══════════════════════════════════════════════════════════════════════════
@router.post("/platform/llm/vertex-gemini")
def platform_llm_vertex_gemini(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(resolve_api_ctx),
    db: Session = Depends(get_db),
):
    """backend-only Vertex Gemini proxy。

    Service Account JSON 一律 server-side env resolve，不可傳 actual secret JSON。
    """
    model_id = body.get("model_id")
    if not model_id:
        return _err(400, "model_id required")
    messages = body.get("messages") or []
    prompt = "\n".join(m.get("content", "") for m in messages) \
        if isinstance(messages, list) else body.get("prompt", "")

    start = time.time()
    try:
        text = llm_mod.invoke_llm(
            prompt, model=model_id, provider="vertex",
            temperature=body.get("temperature", 0.3),
            max_tokens=body.get("max_tokens"),
        )
        latency_ms = int((time.time() - start) * 1000)
        return {
            "success": True, "content": text,
            "input_tokens": max(1, len(prompt or "") // 4),
            "output_tokens": max(1, len(text or "") // 4),
            "latency_ms": latency_ms, "error_code": None, "error_message": None,
        }
    except Exception as e:
        latency_ms = int((time.time() - start) * 1000)
        return {
            "success": False, "content": None, "input_tokens": 0,
            "output_tokens": 0, "latency_ms": latency_ms,
            "error_code": "vertex_error", "error_message": str(e),
        }


@router.post("/platform/llm/test")
def platform_llm_test(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(require_company),
    db: Session = Depends(get_db),
):
    """測試 AI provider/model configuration（company_id 綁定）。

    test_tier ∈ fast | reasoning | both
    """
    test_tier = body.get("test_tier", "both")
    if test_tier not in ("fast", "reasoning", "both"):
        return _err(400, "invalid test_tier", "test_tier must be fast|reasoning|both")

    cfg = None
    if body.get("provider_config_id"):
        cfg = db.query(PlatformLLMProviderConfig).filter(
            PlatformLLMProviderConfig.id == body["provider_config_id"]).first()
    if cfg is None:
        cfg = db.query(PlatformLLMProviderConfig).filter(
            PlatformLLMProviderConfig.is_default.is_(True)).first()
    if cfg is None:
        cfg = db.query(PlatformLLMProviderConfig).filter(
            PlatformLLMProviderConfig.is_active.is_(True)).first()

    fast_model = (cfg.fast_model if cfg else None) or settings.default_llm_model
    reasoning_model = (cfg.reasoning_model if cfg else None) or fast_model
    provider = (cfg.provider_type if cfg else "vertex")
    provider = "vertex" if provider in ("vertex_ai_gemini", "gemini") else provider

    def _probe(model: str) -> dict:
        s = time.time()
        try:
            llm_mod.invoke_llm("ping", model=model, provider=provider, max_tokens=8)
            return {"ok": True, "latency_ms": int((time.time() - s) * 1000),
                    "model_tested": model}
        except Exception as e:
            return {"ok": False, "latency_ms": int((time.time() - s) * 1000),
                    "model_tested": model, "error": str(e)}

    results: dict[str, Any] = {}
    if test_tier in ("fast", "both"):
        results["fast"] = _probe(fast_model)
    if test_tier in ("reasoning", "both"):
        results["reasoning"] = _probe(reasoning_model)

    tested = ", ".join(r.get("model_tested", "") for r in results.values())
    all_ok = all(r.get("ok") for r in results.values())
    return {
        "success": all_ok,
        "latency_ms": int(sum(r["latency_ms"] for r in results.values())),
        "results": results, "model_tested": tested,
        "error_code": None if all_ok else "provider_error",
        "error_message": None if all_ok else
        "; ".join(r.get("error", "") for r in results.values() if not r.get("ok")),
    }


# ══════════════════════════════════════════════════════════════════════════
# H. Registry / Internal（29–30）
# ══════════════════════════════════════════════════════════════════════════
@router.post("/kb/admin/agent-registry/cleanup")
def admin_agent_registry_cleanup(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(require_company),
    db: Session = Depends(get_db),
):
    """cleanup KB Agent Registry duplicates / wrong-scope multi agents（company_id 綁定）。

    資料保留，僅停用（is_active=False），不刪除。
    """
    multi = db.query(KBAgentRegistry).filter(
        KBAgentRegistry.agent_type == "multi_agent",
        KBAgentRegistry.is_active.is_(True)).all()
    deactivated_multi = 0
    for a in multi:
        a.is_active = False
        db.add(a)
        deactivated_multi += 1

    groups: dict[str, list] = defaultdict(list)
    for a in db.query(KBAgentRegistry).filter(
            KBAgentRegistry.agent_key.like("kbr_%"),
            KBAgentRegistry.is_active.is_(True)).all():
        groups[a.agent_key].append(a)

    log: list[dict] = []
    deactivated_kbr_dupes = 0
    for key, agents in groups.items():
        if len(agents) <= 1:
            continue
        keep = agents[0]
        for a in agents[1:]:
            a.is_active = False
            db.add(a)
            deactivated_kbr_dupes += 1
            log.append({"id": a.id, "key": a.agent_key,
                        "action": "deactivated_kbr_dupe", "kept": keep.id})
    db.commit()

    total = deactivated_multi + deactivated_kbr_dupes
    return {
        "success": True, "deactivated_multi": deactivated_multi,
        "deactivated_kbr_dupes": deactivated_kbr_dupes,
        "total_updated": total, "log": log,
        "message": (f"清理完成：停用 {deactivated_multi} 個 multi_agent、"
                    f"{deactivated_kbr_dupes} 個重複 kbr_* 條目（資料保留，未刪除）"),
    }


@router.post("/kb/internal/storage-test")
def internal_storage_test(
    body: dict = Body(default_factory=dict),
    ctx: ApiContext = Depends(require_company),
    db: Session = Depends(get_db),
):
    """測試 Base44 storage text length boundary（company_id 綁定 / dev only）。"""
    from app.core import storage as storage_mod

    results: list[dict] = []
    for target in (20050, 20100):
        payload = ("x" * target).encode("utf-8")
        try:
            r = storage_mod.upload_file("_boundary_probe.txt", payload, "text/plain")
            stored = target
            if settings.storage_backend == "local":
                path = storage_mod.local_path_for(r["key"])
                if os.path.exists(path):
                    with open(path, "rb") as f:
                        stored = len(f.read())
            results.append({"target_chars": target, "stored_chars": stored,
                            "status": "OK_EXACT" if stored == target else "MISMATCH"})
        except Exception as e:  # noqa: BLE001
            results.append({"target_chars": target, "stored_chars": None,
                            "status": "ERROR", "error": str(e)})
    return {"ok": all(r["status"] == "OK_EXACT" for r in results),
            "results": results}
