"""
Website 爬取 Celery 任務

poll_website_crawl     單一 job 輪詢直到完成
website_crawl_poll     celerybeat 每 60 秒掃描 crawling 中的 job
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone

from app.core.database import SessionLocal
from app.worker import celery_app
from app.models import WebsiteImportJob, CrawledPageResult
from app.services.firecrawl_config import resolve_firecrawl_config
from app.services.firecrawl_log import firecrawl_request

logger = logging.getLogger(__name__)


def _now():
    return datetime.now(timezone.utc)


def _new_id():
    import uuid
    return uuid.uuid4().hex


def _sync_one(db, job: WebsiteImportJob) -> bool:
    """回傳是否已完成。"""
    api_key, base_url = resolve_firecrawl_config(db)
    if not job.firecrawl_job_id or not api_key:
        return False
    try:
        r = firecrawl_request(db, "GET",
                              f"{base_url}/v1/crawl/{job.firecrawl_job_id}",
                              api_key, endpoint="/v1/crawl/{job_id}",
                              timeout=20, job_id=job.id,
                              firecrawl_job_id=job.firecrawl_job_id)
        if r.status_code != 200:
            return False
        fc = r.json()
        status = fc.get("status")
        job.total_pages_completed = fc.get("completed", 0)
        if status == "completed":
            # 完成的爬取 → 依 firecrawl_job_id 去重回報一次總用量
            from app.services.firecrawl_log import report_crawl_credit_once
            report_crawl_credit_once(db, firecrawl_job_id=job.firecrawl_job_id,
                                     user_id=job.created_by,
                                     company_id=job.company_id,
                                     resp_text=r.text)
            for pg in fc.get("data", []):
                db.add(CrawledPageResult(
                    id=_new_id(), job_id=job.id,
                    page_url=pg.get("metadata", {}).get("sourceURL", ""),
                    page_title=pg.get("metadata", {}).get("title", ""),
                    markdown_content=pg.get("markdown", ""),
                    status="crawled", created_date=_now(),
                ))
            job.status = "completed"
            job.completed_at = _now()
            db.add(job); db.commit()
            return True
        elif status == "failed":
            job.status = "failed"
            job.error_message = "Firecrawl crawl failed"
            db.add(job); db.commit()
            return True
        db.add(job); db.commit()
        return False
    except Exception:
        logger.exception("website crawl sync failed job=%s", job.id)
        return False


@celery_app.task(name="kb.poll_website_crawl", bind=True, max_retries=0)
def poll_website_crawl(self, job_id: str, batch_id: str, max_polls: int = 60):
    db = SessionLocal()
    try:
        import time
        for _ in range(max_polls):
            job = db.query(WebsiteImportJob).filter(
                WebsiteImportJob.id == job_id).first()
            if not job or job.status in ("completed", "failed"):
                break
            if _sync_one(db, job):
                break
            time.sleep(5)
        return {"ok": True, "job_id": job_id}
    finally:
        db.close()


@celery_app.task(name="kb.website_crawl_poll")
def website_crawl_poll():
    """celerybeat：掃描所有 crawling 中的 job。"""
    db = SessionLocal()
    synced = 0
    try:
        jobs = db.query(WebsiteImportJob).filter(
            WebsiteImportJob.status == "crawling").all()
        for job in jobs:
            if _sync_one(db, job):
                synced += 1
        return {"ok": True, "synced": synced, "scanned": len(jobs)}
    finally:
        db.close()
