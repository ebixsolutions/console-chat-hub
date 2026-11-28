"""
Website 匯入端點（3 個）— Firecrawl 網站爬取匯入

kbStartWebsiteCrawl        啟動爬取 → single_url 同步 scrape 立即建 items（parsed）；
                           sitemap / selective 非同步 crawl（crawling）
kbGetWebsiteCrawlStatus    查詢爬取進度
kbCreateWebsiteImportItems 爬取完成後，把 CrawledPageResult → KBImportItem

背景輪詢由 Celery website_crawl_poll 驅動（每 60 秒）。
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.auth import AuthContext, get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.models import (
    KBImportBatch, KBImportItem, WebsiteImportJob, CrawledPageResult,
)
from app.services import import_pipeline as pipe
from app.services.firecrawl_config import resolve_firecrawl_config
from app.services.firecrawl_log import firecrawl_request

router = APIRouter(prefix="/api/functions", tags=["kb-website"])
app_router = APIRouter(
    prefix=f"/api/apps/{settings.app_id}/functions", tags=["kb-website"]
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
# 1. kbStartWebsiteCrawl
# ══════════════════════════════════════════════════════════════════════════
@_register_both("/kbStartWebsiteCrawl", methods=["POST"])
def kb_start_website_crawl(payload: dict = Body(default_factory=dict),
                           db: Session = Depends(get_db),
                           user: AuthContext = Depends(get_current_user)):
    crawl_mode = payload.get("crawlMode") or payload.get("import_mode")
    url = payload.get("url")
    batch_meta = payload.get("batch_meta") or {}
    if not crawl_mode or not url:
        return _err(400, "crawlMode and url are required")

    # single_url → 同步 scrape + 立即建 items；sitemap / selective → 非同步 crawl
    sync_mode = crawl_mode in ("single_url", "scrape", "single")

    api_key, base_url = resolve_firecrawl_config(db)
    if not api_key:
        return _err(503, "FIRECRAWL_API_KEY not configured")

    # 建 batch（若無）
    batch_id = payload.get("batchId")
    if not batch_id:
        batch = KBImportBatch(
            id=_new_id(),
            batch_name=batch_meta.get("batch_name") or url,
            source_file_type="website",
            site_type=batch_meta.get("site_type") or "ecommerce",
            status="uploaded",
            extraction_status="pending",
            crawl_status="crawling",
            created_by=user.id,
            created_date=_now(),
        )
        db.add(batch); db.commit(); db.refresh(batch)
        batch_id = batch.id
    else:
        batch = db.query(KBImportBatch).filter(
            KBImportBatch.id == batch_id).first()
        if not batch:
            return _err(404, "Batch not found")
        batch.crawl_status = "crawling"

    batch.crawl_mode = crawl_mode
    batch.import_source = "website_import"
    batch.source_url = url
    db.add(batch); db.commit()

    if sync_mode:
        # ── 同步 scrape → 立即建 KBImportItem，batch 轉 parsed ──
        try:
            r = firecrawl_request(db, "POST", f"{base_url}/v1/scrape", api_key,
                                  endpoint="/v1/scrape",
                                  json_body={"url": url, "formats": ["markdown"]},
                                  timeout=60, batch_id=batch_id)
            r.raise_for_status()
            data = r.json().get("data") or r.json()
        except Exception as e:
            batch.crawl_status = "failed"
            batch.crawl_failure_reason = str(e)[:500]
            db.add(batch); db.commit()
            return _err(502, "firecrawl_error", str(e))

        meta = data.get("metadata") or {}
        content = data.get("markdown") or ""
        title = meta.get("title") or url
        items_created = 0
        if content.strip():
            # ★ 規則式行業識別（同步）：與檔案匯入路徑一致；
            #   LLM 分類稍後由 Celery 任務異步覆寫。
            industry, industries, sub_industries = pipe.classify_industry(
                title, content, db)
            db.add(KBImportItem(
                id=_new_id(),
                batch_id=batch_id,
                item_index=0,
                extracted_title=title,
                original_content=content,
                ai_suggested_content="",
                final_content=content,
                source_type="Other",
                knowledge_type="other",
                industry=industry,
                industries=industries,
                sub_industries=sub_industries,
                status="pending",
                human_decision="pending",
                review_status="not_started",
                source_metadata={
                    "source_format": "website",
                    "source_url": url,
                    "raw_block_content": content,
                },
                created_date=_now(),
            ))
            items_created += 1
        batch.crawl_status = "parsed"
        batch.status = "analyzed"
        batch.total_items = items_created
        batch.pages_crawled = items_created
        batch.review_status = "reviewing"
        db.add(batch); db.commit()

        # ★ 背景 LLM 行業分類（無 broker 時靜默跳過）
        if items_created:
            pipe.schedule_industry_classification(batch_id)

        return {"success": True, "batchId": batch_id,
                "crawl_status": "parsed", "crawler_job_id": None,
                "total_items": items_created, "items_created": items_created}

    # ── 非同步模式：啟動 Firecrawl crawl ──
    try:
        r = firecrawl_request(db, "POST", f"{base_url}/v1/crawl", api_key,
                              endpoint="/v1/crawl",
                              json_body={"url": url, "limit": payload.get("limit", 20),
                                         "scrapeOptions": {"formats": ["markdown"]}},
                              timeout=30, batch_id=batch_id)
        r.raise_for_status()
        fc = r.json()
        firecrawl_job_id = fc.get("id") or fc.get("jobId")
    except Exception as e:
        batch.crawl_status = "failed"
        batch.crawl_failure_reason = str(e)[:500]
        db.add(batch); db.commit()
        return _err(502, "firecrawl_error", str(e))

    # 建 WebsiteImportJob
    job = WebsiteImportJob(
        id=_new_id(),
        job_name=batch_meta.get("batch_name") or url,
        input_url=url,
        import_mode=crawl_mode,
        status="crawling",
        firecrawl_job_id=firecrawl_job_id,
        total_pages_requested=payload.get("limit", 20),
        total_pages_completed=0,
        total_pages_failed=0,
        created_by=user.id,
        created_date=_now(),
    )
    db.add(job); db.commit(); db.refresh(job)

    # 交給 Celery 輪詢（若可用）
    try:
        from app.tasks.website_tasks import poll_website_crawl
        poll_website_crawl.delay(job.id, batch_id)
    except Exception:
        pass

    return {"success": True, "batchId": batch_id,
            "crawl_status": "crawling", "crawler_job_id": firecrawl_job_id,
            "total_items": 0, "items_created": 0}


# ══════════════════════════════════════════════════════════════════════════
# 2. kbGetWebsiteCrawlStatus
# ══════════════════════════════════════════════════════════════════════════
@_register_both("/kbGetWebsiteCrawlStatus", methods=["POST"])
def kb_get_website_crawl_status(payload: dict = Body(default_factory=dict),
                                db: Session = Depends(get_db),
                                user: AuthContext = Depends(get_current_user)):
    job_id = payload.get("job_id")
    batch_id = payload.get("batchId")
    job = None
    if job_id:
        job = db.query(WebsiteImportJob).filter(
            WebsiteImportJob.id == job_id).first()
    if not job:
        return _err(404, "Job not found")

    # 主動查 Firecrawl（若還在爬）
    if job.status == "crawling" and job.firecrawl_job_id:
        api_key, base_url = resolve_firecrawl_config(db)
        if api_key:
            try:
                r = firecrawl_request(
                    db, "GET", f"{base_url}/v1/crawl/{job.firecrawl_job_id}",
                    api_key, endpoint="/v1/crawl/{job_id}",
                    timeout=20, job_id=job.id,
                    firecrawl_job_id=job.firecrawl_job_id)
                if r.status_code == 200:
                    fc = r.json()
                    fc_status = fc.get("status")
                    completed = fc.get("completed", 0)
                    total = fc.get("total", job.total_pages_requested)
                    job.total_pages_completed = completed
                    if fc_status == "completed":
                        # 完成的爬取 → 依 firecrawl_job_id 去重回報一次總用量
                        from app.services.firecrawl_log import report_crawl_credit_once
                        report_crawl_credit_once(db, firecrawl_job_id=job.firecrawl_job_id,
                                                 user_id=user.id,
                                                 company_id=job.company_id,
                                                 resp_text=r.text)
                        job.status = "completed"
                        job.completed_at = _now()
                        # 落地 CrawledPageResult
                        for pg in fc.get("data", []):
                            db.add(CrawledPageResult(
                                id=_new_id(),
                                job_id=job.id,
                                page_url=pg.get("metadata", {}).get("sourceURL", ""),
                                page_title=pg.get("metadata", {}).get("title", ""),
                                markdown_content=pg.get("markdown", ""),
                                status="crawled",
                                created_date=_now(),
                            ))
                    db.add(job); db.commit()
            except Exception:
                pass

    return {"ok": True, "job_id": job.id, "status": job.status,
            "total_requested": job.total_pages_requested,
            "total_completed": job.total_pages_completed,
            "total_failed": job.total_pages_failed}


# ══════════════════════════════════════════════════════════════════════════
# 3. kbCreateWebsiteImportItems
# ══════════════════════════════════════════════════════════════════════════
@_register_both("/kbCreateWebsiteImportItems", methods=["POST"])
def kb_create_website_import_items(payload: dict = Body(default_factory=dict),
                                   db: Session = Depends(get_db),
                                   user: AuthContext = Depends(get_current_user)):
    job_id = payload.get("job_id")
    batch_id = payload.get("batchId")
    if not job_id or not batch_id:
        return _err(400, "job_id and batchId required")

    pages = db.query(CrawledPageResult).filter(
        CrawledPageResult.job_id == job_id,
        CrawledPageResult.status == "crawled",
    ).all()
    if not pages:
        return _err(400, "No crawled pages found")

    created = 0
    for idx, pg in enumerate(pages):
        content = pg.markdown_content or ""
        if not content.strip():
            continue
        title = pg.page_title or pg.page_url or f"Page {idx+1}"
        # ★ 規則式行業識別（同步）：與檔案匯入路徑一致
        industry, industries, sub_industries = pipe.classify_industry(
            title, content, db)
        item = KBImportItem(
            id=_new_id(),
            batch_id=batch_id,
            item_index=idx,
            extracted_title=title,
            original_content=content,
            ai_suggested_content="",              # ★ 保留欄位
            final_content=content,
            source_type="Other",
            knowledge_type="other",
            industry=industry,
            industries=industries,
            sub_industries=sub_industries,
            status="pending",
            human_decision="pending",
            review_status="not_started",
            source_metadata={
                "source_format": "website",
                "source_url": pg.page_url,
                "raw_block_content": content,
            },
            created_date=_now(),
        )
        db.add(item); created += 1
    # 更新 batch
    batch = db.query(KBImportBatch).filter(KBImportBatch.id == batch_id).first()
    if batch:
        batch.total_items = created
        batch.extraction_phase = "done"
        batch.crawl_status = "completed"
        db.add(batch)
    db.commit()

    # ★ 背景 LLM 行業分類（無 broker 時靜默跳過）
    if created:
        pipe.schedule_industry_classification(batch_id)

    return {"ok": True, "batchId": batch_id, "created_items": created}
