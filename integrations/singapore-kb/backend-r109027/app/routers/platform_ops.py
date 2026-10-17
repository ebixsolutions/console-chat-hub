"""
平台工具端點 — 剩餘 function 中的同步部分

vertexGeminiCall / testPlatformLLMConnection / firecrawlScrape /
testFirecrawlConnection / storageTest / kbRuntimeProbe / kbArchiveTestData /
kbRegistryCleanup / migrateGlobalDocumentId /
generateIndustryTemplates / generateSingleTemplate / generateEmbeddings

（generateEmbeddings 大量文件時走 Celery，見 import_tasks；此處提供同步入口）
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.auth import AuthContext, get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.core import llm as llm_mod
from app.core import storage as storage_mod
from app.models import (
    KBDocument, KBDocumentVersion, KBVectorChunk, KBAgentRegistry, KBSyncLog,
    GeneratedTemplateItem, IndustryTemplateSkeleton, TemplateGenerationJob,
)
from app.services.firecrawl_config import resolve_firecrawl_config
from app.services.firecrawl_log import firecrawl_request
from app.services.publish_candidate_adapter import (
    canonical_content_hash, ensure_candidate_staging,
    verified_vector_set, copy_staging_to_candidate_production,
)

router = APIRouter(prefix="/api/functions", tags=["kb-platform"])
app_router = APIRouter(
    prefix=f"/api/apps/{settings.app_id}/functions", tags=["kb-platform"]
)


def _register_both(path: str, **route_kwargs):
    """同時註冊到 /api/functions 與 /api/apps/{app_id}/functions，避免前端 404。"""

    def decorator(func):
        router.add_api_route(path, func, **route_kwargs)
        app_router.add_api_route(path, func, **route_kwargs)
        return func

    return decorator


def _now():
    return datetime.now(timezone.utc)


def _new_id():
    return uuid.uuid4().hex


def _err(status, error, detail=None):
    body = {"error": error}
    if detail is not None:
        body["detail"] = detail
    return JSONResponse(status_code=status, content=body)


# ══════════════════════════════════════════════════════════════════════════
# vertexGeminiCall
# ══════════════════════════════════════════════════════════════════════════
@_register_both("/vertexGeminiCall", methods=["POST"])
def vertex_gemini_call(payload: dict = Body(default_factory=dict),
                       user: AuthContext = Depends(get_current_user)):
    model_id = payload.get("model_id")
    if not model_id:
        return _err(400, "model_not_found", "model_id is required")
    messages = payload.get("messages") or []
    prompt = "\n".join(m.get("content", "") for m in messages) \
        if messages else payload.get("prompt", "")
    try:
        text = llm_mod.invoke_llm(
            prompt,
            model=model_id,
            provider="vertex",
            temperature=payload.get("temperature", 0.2),
            max_tokens=payload.get("max_tokens"),  # 未指定則不限制輸出 token
        )
        return {"ok": True, "text": text, "model_id": model_id}
    except Exception as e:
        msg = str(e).lower()
        code = ("model_not_found" if "model_not_found" in msg
                else "rate_limited" if "rate" in msg or "429" in msg
                else "vertex_error")
        return _err(502, code, str(e))


# ══════════════════════════════════════════════════════════════════════════
# testPlatformLLMConnection
# ══════════════════════════════════════════════════════════════════════════
@_register_both("/testPlatformLLMConnection", methods=["POST"])
def test_platform_llm_connection(payload: dict = Body(default_factory=dict),
                                 user: AuthContext = Depends(get_current_user)):
    provider = payload.get("provider_type", "vertex")
    model = payload.get("fast_model") or payload.get("reasoning_model") \
        or settings.default_llm_model
    try:
        text = llm_mod.invoke_llm("ping", model=model, provider=provider,
                                  max_tokens=8)
        return {"ok": True, "provider": provider, "model": model,
                "sample": (text or "")[:50]}
    except Exception as e:
        return _err(502, "connection_failed", str(e))


# ══════════════════════════════════════════════════════════════════════════
# firecrawlScrape / testFirecrawlConnection
# ══════════════════════════════════════════════════════════════════════════
@_register_both("/firecrawlScrape", methods=["POST"])
def firecrawl_scrape(payload: dict = Body(default_factory=dict),
                     db: Session = Depends(get_db),
                     user: AuthContext = Depends(get_current_user)):
    url = payload.get("url")
    if not url:
        return _err(400, "url required")
    api_key, base_url = resolve_firecrawl_config(db)
    if not api_key:
        return _err(503, "firecrawl_not_configured")
    try:
        r = firecrawl_request(db, "POST", f"{base_url}/v1/scrape", api_key,
                              endpoint="/v1/scrape",
                              json_body={"url": url, "formats": ["markdown", "html"]},
                              timeout=60)
        r.raise_for_status()
        return {"ok": True, "data": r.json()}
    except Exception as e:
        return _err(502, "firecrawl_error", str(e))


@_register_both("/testFirecrawlConnection", methods=["POST"])
def test_firecrawl_connection(payload: dict = Body(default_factory=dict),
                              db: Session = Depends(get_db),
                              user: AuthContext = Depends(get_current_user)):
    api_key, base_url = resolve_firecrawl_config(db)
    if not api_key:
        return {"ok": False, "configured": False}
    try:
        r = firecrawl_request(db, "GET", f"{base_url}/v1/team/credit-usage",
                              api_key, endpoint="/v1/team/credit-usage", timeout=15)
        return {"ok": r.status_code == 200, "configured": True,
                "status": r.status_code}
    except Exception as e:
        return {"ok": False, "configured": True, "error": str(e)}


# ══════════════════════════════════════════════════════════════════════════
# storageTest
# ══════════════════════════════════════════════════════════════════════════
@_register_both("/storageTest", methods=["POST"])
def storage_test(payload: dict = Body(default_factory=dict),
                 user: AuthContext = Depends(get_current_user)):
    try:
        return storage_mod.storage_test()
    except Exception as e:
        return _err(502, "storage_error", str(e))


# ══════════════════════════════════════════════════════════════════════════
# kbRuntimeProbe — runtime parity 探針（回報 runtime revision + contract 版本）
# ══════════════════════════════════════════════════════════════════════════
# 對外宣告的 runtime revision 與各行為 contract 版本。Base44 前端以此做
# runtime parity 檢查；若實作行為有變更，同步更新對應版本號。
RUNTIME_REVISION = "director-runtime-closure-2026-08-27-v3"
RUNTIME_CONTRACTS: dict[str, str] = {
    "multi_file_independent_persistence": "v2",
    "ai_terminal_state": "v2",
    "publish_fail_closed": "v2",
    "unsupported_format_preflight_reject": "v1",
    "malformed_json_deterministic_reject": "v1",
    "english_ui_fail_closed": "v2",
    "runtime_parity_observability": "v2",
    "count_predicate_contract": "v1",
    "publish_review_content_binding": "v1",
    "atomic_live_activation": "v3",
    "version_restore_identity": "v2",
    "archive_restore_atomicity": "v2",
    "uat_session_cleanup": "v2",
}


@_register_both("/kbRuntimeProbe", methods=["POST"])
def kb_runtime_probe(user: AuthContext = Depends(get_current_user)):
    """Runtime parity 探針：回報 backend runtime revision 與實作之 contract 版本。

    對照 Base44 前端 kbRuntimeProbe 預期格式：
      runtime_revision — backend runtime 版本識別
      contracts        — 各行為 contract 的實作版本
      server_time      — server UTC 時間（ISO-8601, ms, Z 尾碼）
    """
    return {
        "runtime_revision": RUNTIME_REVISION,
        "contracts": dict(RUNTIME_CONTRACTS),
        "server_time": _now().isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }


# ══════════════════════════════════════════════════════════════════════════
# generateEmbeddings（同步入口；大量走 Celery）
# ══════════════════════════════════════════════════════════════════════════
@_register_both("/generateEmbeddings", methods=["POST"])
def generate_embeddings(payload: dict = Body(default_factory=dict),
                        db: Session = Depends(get_db),
                        user: AuthContext = Depends(get_current_user)):
    """
    Base44 2026-08-24 generateEmbeddings contract.

    Required:
      action ∈ regenerate_chunks | regenerate_rag_summary | promote
      document_id
    Optional:
      version_id
      candidate_mode=true  -> version may differ from active_version_id and the
                              current Live KBDocument is not mutated while
                              preparing Staging/RAG.
    """
    action = payload.get("action")
    if action not in {"regenerate_chunks", "regenerate_rag_summary", "promote"}:
        return _err(400, "INVALID_ACTION")
    document_id = payload.get("document_id")
    if not document_id:
        return _err(400, "DOCUMENT_ID_REQUIRED")

    # Mirrors Base44: authenticated callers without company_id cannot invoke the
    # low-level embedding mutation endpoint directly. Normal UI flows call
    # higher-level publish/quick-edit orchestration.
    if not user.company_id and not user.is_service_role:
        return _err(403, "COMPANY_ID_REQUIRED")

    doc = db.query(KBDocument).filter(
        KBDocument.id == document_id,
        KBDocument.tenant_id == user.tenant_id,
    ).first()
    if not doc:
        return _err(404, "DOCUMENT_NOT_FOUND")

    candidate_mode = payload.get("candidate_mode") is True
    version_id = payload.get("version_id") or doc.active_version_id
    if not version_id:
        return _err(409, "ACTIVE_VERSION_MISMATCH")
    if not candidate_mode and version_id != doc.active_version_id:
        return _err(409, "ACTIVE_VERSION_MISMATCH")

    version = db.query(KBDocumentVersion).filter(
        KBDocumentVersion.id == version_id,
        KBDocumentVersion.document_id == doc.id,
    ).first()
    if not version:
        return _err(409, "VERSION_NOT_FOUND_OR_MISMATCH")
    content = (version.raw_content_snapshot or doc.raw_content or "").strip()
    if not content:
        return _err(422, "EMPTY_ACTIVE_VERSION_CONTENT")

    try:
        currently_live = (
            doc.status == "published"
            and doc.available_to_live_console is True
            and doc.production_vector_status == "indexed"
        )

        if action in {"regenerate_chunks", "regenerate_rag_summary"}:
            if not candidate_mode:
                doc.staging_vector_status = "indexing"
                doc.content_hash = canonical_content_hash(content)
                db.add(doc)
                db.commit()

            result = ensure_candidate_staging(
                db, doc, version, mutate_doc=not candidate_mode
            )
            rows = result["rows"]
            if action == "regenerate_chunks":
                return {
                    "success": True,
                    "action": action,
                    "chunk_count": len([r for r in rows if r.chunk_type != "rag_summary"]),
                    "vector_count": len(rows),
                    "embedding_provider": "fastapi_vector_store",
                }
            return {
                "success": True,
                "action": action,
                "rag_summary": result["summary"],
                "rag_summary_hash": version.rag_summary_hash or "",
                "embedding_provider": "fastapi_vector_store",
            }

        # promote: copy only verified real Staging vectors. Candidate versions are
        # not allowed to silently switch document content/version here; the
        # canonical publish state machine owns candidate activation.
        staging = verified_vector_set(db, doc.id, version.id, "staging")
        if not staging:
            return _err(409, "STAGING_NOT_READY")
        production = copy_staging_to_candidate_production(db, doc, version.id)
        if candidate_mode and version.id != doc.active_version_id:
            return {
                "success": True,
                "action": action,
                "production_chunks": len(production),
                "version_id": version.id,
                "candidate_prepared": True,
                "live_preserved": currently_live,
            }

        # Active-version legacy promote remains supported.
        # ★ D-004/D-005 修復：只有在文件本身已是 reviewed/published/Live 時才允許，
        #   並把 content_hash / active_version_id 一併綁定（不可只亮 production 旗標）。
        if not (currently_live or doc.status in ("published", "approved")):
            return _err(409, "DOCUMENT_NOT_REVIEWED",
                        "legacy promote requires a reviewed/published document; "
                        "run kbPublishStart for candidate activation")
        old = db.query(KBVectorChunk).filter(
            KBVectorChunk.document_id == doc.id,
            KBVectorChunk.environment == "production",
            KBVectorChunk.status == "active",
            KBVectorChunk.version_id != version.id,
        ).all()
        for row in old:
            row.status = "superseded"
        doc.production_vector_status = "indexed"
        doc.production_status = "production"
        doc.available_to_live_console = True
        doc.status = "published"
        doc.chunk_count = len(production)
        doc.vector_count = len(production)
        doc.content_hash = canonical_content_hash(content)
        doc.active_version_id = version.id
        doc.published_at = _now()
        version.vector_status = "generated"
        db.add(doc)
        db.add(version)
        db.commit()
        return {
            "success": True,
            "action": action,
            "production_chunks": len(production),
            "version_id": version.id,
        }
    except Exception as e:
        db.rollback()
        code = str(e) or "INTERNAL_ERROR"
        status = 502 if "EMBEDDING" in code or "STAGING" in code else 500
        return _err(status, code)

# ══════════════════════════════════════════════════════════════════════════
# generateIndustryTemplates / generateSingleTemplate
# ══════════════════════════════════════════════════════════════════════════
@_register_both("/generateIndustryTemplates", methods=["POST"])
def generate_industry_templates(payload: dict = Body(default_factory=dict),
                                db: Session = Depends(get_db),
                                user: AuthContext = Depends(get_current_user)):
    industry_key = payload.get("industry_key")
    job = None
    # 前端已先經 entities/TemplateGenerationJob 建 job（內含 industry_key），
    # 此處僅傳 job_id 時直接由 job 取得，不必重複傳 industry_key
    job_id = (payload.get("job_id") or payload.get("jobId")
              or payload.get("id"))
    if not industry_key and job_id:
        job = db.query(TemplateGenerationJob).filter(
            TemplateGenerationJob.id == job_id).first()
        if job is None:
            return _err(404, "job_not_found", f"job {job_id} not found")
        industry_key = job.industry_key
    if not industry_key:
        return _err(400, "industry_key required")
    # 解析 skeleton：payload skeletonId → job.skeleton_id → 該 industry 第一筆
    skeleton_id = (payload.get("skeleton_id") or payload.get("skeletonId")
                   or (job.skeleton_id if job else None))
    skeleton = None
    if skeleton_id:
        skeleton = db.query(IndustryTemplateSkeleton).filter(
            IndustryTemplateSkeleton.id == skeleton_id).first()
    if skeleton is None:
        skeleton = db.query(IndustryTemplateSkeleton).filter(
            IndustryTemplateSkeleton.industry_key == industry_key).first()
    if skeleton is None:
        return _err(404, "skeleton_not_found",
                    f"no skeleton for industry {industry_key}")
    # industry_label 為 NOT NULL：取 payload → job → skeleton → industry_key fallback
    industry_label = (payload.get("industry_label")
                      or (job.industry_label if job else None)
                      or skeleton.industry_label_zh
                      or industry_key)
    if job is None:
        job = TemplateGenerationJob(
            id=_new_id(), industry_key=industry_key, industry_label=industry_label,
            skeleton_id=skeleton.id,
            market_region=payload.get("market_region", "general"),
            language=payload.get("language", "zh"), status="pending",
            created_by=user.id, created_date=_now(),
        )
        db.add(job); db.commit(); db.refresh(job)
    else:
        # 沿用既有 job，僅以 payload 補充（job 已在 entities API 建立）
        if payload.get("market_region"):
            job.market_region = payload["market_region"]
        if payload.get("language"):
            job.language = payload["language"]
        if not job.skeleton_id:
            job.skeleton_id = skeleton.id
        db.add(job); db.commit()
    # 由 skeleton.template_items 展開 GeneratedTemplateItem（與舊 knowledge-base 行為一致）
    lang = job.language or "zh"
    title_field = "title_template_en" if lang == "en" else "title_template_zh"
    selected_keys = (payload.get("selectedItemKeys")
                     or payload.get("selected_item_keys") or [])
    existing_keys = {it.item_key for it in db.query(GeneratedTemplateItem).filter(
        GeneratedTemplateItem.job_id == job.id).all()}
    created = []
    for idx, it in enumerate(((skeleton.template_items or {}).get("items")) or []):
        if selected_keys and it.get("item_key") not in selected_keys:
            continue
        if it.get("item_key") in existing_keys:
            continue
        obj = GeneratedTemplateItem(
            id=_new_id(), job_id=job.id, industry_key=industry_key,
            item_key=it.get("item_key"),
            document_type=it.get("document_type") or "Other",
            title=it.get(title_field) or it.get("title_template_zh") or it.get("item_key"),
            language=lang, is_required=bool(it.get("is_required", False)),
            sort_order=it.get("sort_order", idx + 1),
            template_version=skeleton.version or "1.0",
            review_status="draft", created_by=user.id, created_date=_now(),
        )
        db.add(obj); created.append(obj)
    if created:
        db.commit()
    # 回寫 job 進度：items 就緒即進入 generating
    job.status = "generating"
    job.total_templates = db.query(GeneratedTemplateItem).filter(
        GeneratedTemplateItem.job_id == job.id).count()
    db.add(job); db.commit()
    rows = db.query(GeneratedTemplateItem).filter(
        GeneratedTemplateItem.job_id == job.id).order_by(
        GeneratedTemplateItem.sort_order).all()
    return {
        "success": True,
        "jobId": job.id,
        "totalItems": len(rows),
        "items": [{
            "id": o.id,
            "item_key": o.item_key,
            "title": o.title,
            "document_type": o.document_type,
            "is_required": bool(o.is_required),
            "sort_order": int(o.sort_order or 0),
        } for o in rows],
    }


@_register_both("/generateSingleTemplate", methods=["POST"])
def generate_single_template(payload: dict = Body(default_factory=dict),
                             db: Session = Depends(get_db),
                             user: AuthContext = Depends(get_current_user)):
    item_id = payload.get("item_id")
    skeleton_id = payload.get("skeleton_id")
    if not (item_id or skeleton_id):
        return _err(400, "item_id or skeleton_id required")
    job_id = payload.get("job_id")
    item = None
    if item_id:
        item = db.query(GeneratedTemplateItem).filter(
            GeneratedTemplateItem.id == item_id).first()
        if item is None:
            return _err(404, "item_not_found", f"item {item_id} not found")
    try:
        # 依業務資訊組裝 prompt（與 knowledge-base 行為一致）
        is_us = payload.get("market_region") == "united_states"
        lang = "English" if (payload.get("language") == "en" or is_us) else "繁體中文"
        region = {"hong_kong": "香港", "taiwan": "台灣", "macau": "澳門",
                  "singapore": "Singapore", "united_states": "United States (California standard)"}.get(
            payload.get("market_region"), "通用市場")
        sep = ", " if is_us else "、"
        sk = payload.get("section_keys")
        sections = sep.join(sk) if sk else ("(determine by document type)" if is_us else "（依文件類型自行判斷）")
        hint = payload.get("ai_prompt_hint")
        if is_us:
            comp = ("\nUS Market Compliance Notes:\n- Privacy policy should reference CCPA/CPRA\n"
                    "- California standards as baseline — verify your state\n"
                    "- Marketing emails must comply with CAN-SPAM\n"
                    "- Return/refund varies by state\n- Reference only, not legal advice\n\n"
                    'For legally sensitive sections add: "★ Compliance Note: US laws vary by state. Verify with counsel."\n')
            prompt = (f"You are a professional business document writer specializing in US market compliance for SMBs.\n\n"
                      f'Generate a complete "{payload.get("title")}" document in English.\n\nBusiness:\n'
                      f"- Name: {payload.get('business_name') or '(Your Brand Name)'}\n"
                      f"- Desc: {payload.get('business_description') or '(General e-commerce)'}\n"
                      f"- Industry: {payload.get('industry_key') or 'E-commerce'}\n- Market: US (California/CCPA baseline)\n\n"
                      f"Document Type: {payload.get('document_type')}\nRequired Sections: {sections}\n"
                      f"{('- Special Note: ' + hint + chr(10)) if hint else ''}{comp}\n"
                      "Markdown, plain English, CCPA baseline, 2-4 points/section, 400-800 words. Output content directly.")
        else:
            prompt = (f"你是一位專業的電商業務文件撰寫專家。\n\n請用{lang}撰寫一份完整的「{payload.get('title')}」文件。\n\n業務資訊：\n"
                      f"- 業務名稱：{payload.get('business_name') or '（你的品牌名稱）'}\n"
                      f"- 業務簡介：{payload.get('business_description') or '（一般電商業務）'}\n"
                      f"- 行業：{payload.get('industry_key') or '電商'}\n- 市場地區：{region}\n\n文件要求：\n"
                      f"- 文件類型：{payload.get('document_type')}\n- 必須涵蓋章節：{sections}\n"
                      f"{('- 特別注意：' + hint + chr(10)) if hint else ''}\n"
                      "Markdown 標題階層、具體實用、每章 2-4 要點、法律文件加免責聲明、400-800 字。直接輸出內容。")
        content = llm_mod.invoke_llm(prompt)  # 不限制輸出 token
        if not content or not content.strip():
            raise ValueError("LLM returned empty content")
    except Exception as e:
        try:
            if item is not None:
                item.review_status = "rejected"
                item.generated_by = "failed"
                db.add(item)
            if job_id:
                job = db.query(TemplateGenerationJob).filter(
                    TemplateGenerationJob.id == job_id).first()
                if job:
                    job.failed_templates = (job.failed_templates or 0) + 1
                    db.add(job)
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        return _err(500, "llm_error", str(e))
    if item is not None:
        item.original_generated_content = content
        item.edited_content = content
        item.review_status = "draft"
        item.generated_by = "llm"
        item.regenerate_count = (item.regenerate_count or 0) + 1
        db.add(item)
    # 更新 job 進度
    if job_id:
        job = db.query(TemplateGenerationJob).filter(
            TemplateGenerationJob.id == job_id).first()
        if job:
            done_n = (job.completed_templates or 0) + 1
            total = job.total_templates or 0
            job.completed_templates = done_n
            if total > 0 and done_n >= total:
                job.status = "completed"
                job.completed_at = _now()
            else:
                job.status = "generating"
            db.add(job)
    db.commit()
    if item is not None:
        db.refresh(item)
    return {"success": True, "item_id": item.id if item else None,
            "content_length": len(content)}


# ══════════════════════════════════════════════════════════════════════════
# 維護類（company_id 綁定）
# ══════════════════════════════════════════════════════════════════════════
@_register_both("/kbArchiveTestData", methods=["POST"])
def kb_archive_test_data(payload: dict = Body(default_factory=dict),
                         db: Session = Depends(get_db),
                         user: AuthContext = Depends(get_current_user)):
    """Current Base44 kbArchiveTestData contract (company_id 綁定)."""
    if not user.company_id and not user.is_service_role:
        return _err(403, "Permission denied: company_id required for archive")

    fp = payload.get("filterParams") or {}
    dry_run = bool(payload.get("dryRun", False))
    status_list = fp.get("status_list") if isinstance(fp.get("status_list"), list) and fp.get("status_list") else ["draft", "pending_review", "reviewing"]

    q = db.query(KBDocument).filter(KBDocument.status.in_(status_list))
    if fp.get("created_after"):
        q = q.filter(KBDocument.created_date >= fp["created_after"])
    if fp.get("created_before"):
        q = q.filter(KBDocument.created_date <= fp["created_before"])
    if fp.get("import_source") and fp.get("import_source") != "all":
        q = q.filter(KBDocument.import_source == fp["import_source"])
    if fp.get("source_file_name_contains") and str(fp.get("source_file_name_contains")).strip():
        q = q.filter(KBDocument.name.ilike(f"%{str(fp['source_file_name_contains']).strip()}%"))
    docs = q.order_by(KBDocument.created_date.desc()).all()

    if dry_run:
        return {"dry_run": True, "total": len(docs), "documents": [
            {"id": d.id, "name": d.name, "status": d.status,
             "created_date": d.created_date.isoformat() if d.created_date else None,
             "import_source": d.import_source}
            for d in docs[:50]
        ]}

    total_archived = 0
    total_archived_chunks = 0
    for d in docs:
        try:
            d.status = "archived"
            d.available_to_live_console = False
            d.staging_vector_status = "not_indexed"
            d.production_vector_status = "not_indexed"
            d.production_status = "not_published"
            db.add(d)
            for c in db.query(KBVectorChunk).filter(KBVectorChunk.document_id == d.id).all():
                c.status = "archived"
                db.add(c)
                total_archived_chunks += 1
            db.commit()
            total_archived += 1
        except Exception:
            db.rollback()
            continue

    audit_id = f"batch_archive_{int(_now().timestamp() * 1000)}"
    db.add(KBSyncLog(
        id=_new_id(), global_document_id=audit_id, document_id=audit_id,
        from_app="knowledge_base", to_app="knowledge_base",
        sync_type="manual_sync", sync_status="completed",
        error_message=json.dumps({
            "operation": "archive_test_data",
            "operator_user_id": user.id,
            "filter_summary": json.dumps(fp, ensure_ascii=False),
            "archived_count": total_archived,
            "archived_chunks": total_archived_chunks,
            "timestamp": _now().isoformat(),
        }, ensure_ascii=False),
    ))
    db.commit()
    return {"success": True, "archived_count": total_archived,
            "archived_chunks": total_archived_chunks,
            "skipped_count": 0, "dry_run": False}


@_register_both("/kbRegistryCleanup", methods=["POST"])
def kb_registry_cleanup(payload: dict = Body(default_factory=dict),
                        db: Session = Depends(get_db),
                        user: AuthContext = Depends(get_current_user)):
    """Registry cleanup matching Base44 behavior; never deletes registry rows."""
    if not user.company_id and not user.is_service_role:
        return _err(403, "Forbidden: company_id required")
    agents = db.query(KBAgentRegistry).filter(
        KBAgentRegistry.agent_usage_scope == "document_review",
        KBAgentRegistry.is_active == True,  # noqa: E712
    ).all()
    deactivated_multi = 0
    deactivated_kbr_dupes = 0
    log = []
    for a in agents:
        if a.agent_type == "multi_agent" or str(a.agent_key or "").startswith("multi_"):
            a.is_active = False; a.agent_usage_scope = "routing"; db.add(a)
            deactivated_multi += 1; log.append({"id": a.id, "key": a.agent_key, "action": "deactivated_multi_agent"})
    kbr = [a for a in agents if str(a.agent_key or "").startswith("kbr_") and a.agent_type != "multi_agent" and not str(a.agent_key or "").startswith("multi_")]
    groups = {}
    for a in kbr: groups.setdefault(a.agent_key, []).append(a)
    for key, entries in groups.items():
        if len(entries) <= 1: continue
        def score(a):
            richness = int(bool(a.risk_level_routing)) + int(bool(a.default_model_tier)) + int(bool(a.credit_cost_weight))
            updated = getattr(a, "updated_date", None) or datetime.min.replace(tzinfo=timezone.utc)
            return (richness, updated)
        entries = sorted(entries, key=score, reverse=True)
        keep = entries[0]
        for a in entries[1:]:
            a.is_active = False; db.add(a); deactivated_kbr_dupes += 1
            log.append({"id": a.id, "key": key, "action": "deactivated_kbr_dupe", "kept": keep.id})
    db.commit()
    return {
        "success": True, "deactivated_multi": deactivated_multi,
        "deactivated_kbr_dupes": deactivated_kbr_dupes,
        "total_updated": deactivated_multi + deactivated_kbr_dupes, "log": log,
    }


@_register_both("/migrateGlobalDocumentId", methods=["POST"])
def migrate_global_document_id(payload: dict = Body(default_factory=dict),
                               db: Session = Depends(get_db),
                               user: AuthContext = Depends(get_current_user)):
    """global_document_id migration（company_id 綁定）；assigns UUIDv4, never reuses app document id."""
    if not user.company_id and not user.is_service_role:
        return _err(403, "Forbidden: company_id required")
    q = db.query(KBDocument).filter((KBDocument.global_document_id.is_(None)) | (KBDocument.global_document_id == ""))
    if not user.is_service_role:
        q = q.filter(KBDocument.tenant_id == user.tenant_id)
    docs = q.all()
    updated = 0; errors = []
    for d in docs:
        try:
            d.global_document_id = str(uuid.uuid4())
            if not isinstance(d.industries, dict): d.industries = {}
            db.add(d); db.commit(); updated += 1
        except Exception as e:
            db.rollback(); errors.append({"id": d.id, "error": str(e)})
    return {
        "success": len(errors) == 0, "total_scanned": len(docs),
        "needed_migration": len(docs), "updated": updated, "failed": len(errors),
        "errors": errors,
    }
