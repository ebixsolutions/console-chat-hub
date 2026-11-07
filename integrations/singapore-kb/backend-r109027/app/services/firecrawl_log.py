"""
Firecrawl 呼叫日誌 — 每次呼叫寫入 kb_firecrawl_log 表

所有 Firecrawl HTTP 呼叫統一經 firecrawl_request()，自動記錄：
  type / success / status / credits_used / data（request + response + error + 耗時）

schema 對齊舊版 knowledge-base 服務的 KBFirecrawlLog（共用同一張表）：
  id(serial) / webhook_id / success / type / data(jsonb) / company_id /
  created_at(unix) / updated_at(unix) / status / credits_used

日誌寫入失敗不影響主流程（僅 logger.warning）。
"""
from __future__ import annotations
import json
import logging
import time

import requests
from sqlalchemy.orm import Session

from app.models import FirecrawlLog

logger = logging.getLogger(__name__)

MAX_BODY_CHARS = 8000  # response 明細截斷上限

_TYPE_BY_ENDPOINT = {
    "/v1/scrape": "scrape",
    "/v1/crawl": "crawl",
    "/v1/crawl/{job_id}": "crawl_status",
    "/v1/team/credit-usage": "credit_usage",
}

# 不回報扣費的端點：查詢餘額本身不消耗 credits；
# crawl_status 輪詢會重複回傳同一批頁面的 creditsUsed，逐次回報會重複扣費。
_SKIP_CREDIT_ENDPOINTS = {"/v1/team/credit-usage", "/v1/crawl/{job_id}"}


def _endpoint_type(endpoint: str) -> str:
    if not endpoint:
        return "unknown"
    return _TYPE_BY_ENDPOINT.get(endpoint, endpoint.rsplit("/", 1)[-1])[:25]


def _trunc(v) -> str | None:
    if v is None:
        return None
    s = v if isinstance(v, str) else str(v)
    if len(s) <= MAX_BODY_CHARS:
        return s
    return s[:MAX_BODY_CHARS] + f"...(truncated {len(s) - MAX_BODY_CHARS} chars)"


def _parse_response(resp_text: str | None):
    if not resp_text:
        return None
    try:
        return json.loads(resp_text)
    except Exception:
        return _trunc(resp_text)


def _to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _extract_credits(resp_text: str | None) -> int | None:
    """從 Firecrawl 回應取 creditsUsed（metadata / data.metadata / data[0].metadata）。"""
    if not resp_text:
        return None
    try:
        payload = json.loads(resp_text)
    except Exception:
        return None

    for meta in (payload.get("metadata") or {},
                 (payload.get("data") or {}).get("metadata") or {}):
        credits = _to_int(meta.get("creditsUsed"))
        if credits is not None:
            return credits
    data_arr = payload.get("data")
    if isinstance(data_arr, list) and data_arr:
        meta = data_arr[0].get("metadata") or {}
        credits = _to_int(meta.get("creditsUsed"))
        if credits is not None:
            return credits
    return None


def _extract_crawl_credits(resp_text: str | None) -> int | None:
    """總計 crawl 完成回應中所有頁面的 creditsUsed（data[] per-page metadata）。"""
    if not resp_text:
        return None
    try:
        payload = json.loads(resp_text)
    except Exception:
        return None
    data_arr = payload.get("data")
    if not isinstance(data_arr, list) or not data_arr:
        return None
    total = 0
    seen = False
    for pg in data_arr:
        c = _to_int((pg.get("metadata") or {}).get("creditsUsed"))
        if c is None:
            continue
        seen = True
        total += c
    return total if seen else None


def log_firecrawl_call(db: Session, *, endpoint: str, method: str = "POST",
                       request_url: str = "", request_body=None,
                       status_code: int = None, response_body=None,
                       error_message: str = None, duration_ms: float = None,
                       job_id: str = None, batch_id: str = None,
                       firecrawl_job_id: str = None) -> FirecrawlLog:
    """新增一筆 kb_firecrawl_log 並 commit；失敗僅警告不拋出。"""
    success = status_code is not None and status_code < 400
    now_ts = int(time.time())
    data = {
        "endpoint": endpoint,
        "method": method.upper(),
        "url": request_url,
        "request": request_body,
        "response": _parse_response(response_body),
        "error": error_message,
        "duration_ms": round(duration_ms, 3) if duration_ms is not None else None,
    }
    if job_id:
        data["job_id"] = job_id
    if batch_id:
        data["batch_id"] = batch_id
    if firecrawl_job_id:
        data["firecrawl_job_id"] = firecrawl_job_id

    log = FirecrawlLog(
        type=_endpoint_type(endpoint),
        success=success,
        data=data,
        status=1 if success else 0,
        credits_used=_extract_credits(response_body),
        created_at=now_ts,
        updated_at=now_ts,
    )
    try:
        db.add(log)
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("failed to write firecrawl log endpoint=%s", endpoint,
                       exc_info=True)
    return log


def _report_credit(endpoint: str, resp_text: str | None) -> None:
    """成功呼叫且有實際用量（creditsUsed>0）→ 回報扣費；排除查詢餘額/輪詢類端點。"""
    if not endpoint or endpoint in _SKIP_CREDIT_ENDPOINTS:
        return
    credits = _extract_credits(resp_text)
    if not credits or credits <= 0:
        return
    try:
        from app.core.credit import report_credit_usage
        from app.core.tenant_ctx import get_company, get_user
        report_credit_usage(
            get_user(), get_company(),
            usage=credits,
            description=f"Firecrawl调用消耗({_endpoint_type(endpoint)})",
        )
    except Exception:
        pass  # 計費回報絕不影響主流程


def report_crawl_credit_once(db: Session, *, firecrawl_job_id: str,
                             user_id: str | None, company_id: int | None,
                             resp_text: str | None,
                             description: str = "Firecrawl网站爬取消耗") -> None:
    """非同步網站爬取完成後，依 firecrawl_job_id 去重回報一次總用量。

    背景輪詢（Celery）與 HTTP 輪詢（kbGetWebsiteCrawlStatus）都可能先看到
    completed，若各自回報會重複扣費。故一律寫一筆標記型 kb_firecrawl_log
    （data.credit_reported='1'）做全域去重；已回報過則直接跳過。

    無 user 時傳入 job.created_by（Celery 無 tenant_ctx，勿依賴 get_user()）。
    """
    credits = _extract_crawl_credits(resp_text)
    if not credits or credits <= 0:
        return
    fcid = str(firecrawl_job_id)
    try:
        already = db.query(FirecrawlLog).filter(
            FirecrawlLog.type == "crawl_status",
            FirecrawlLog.data["firecrawl_job_id"].astext == fcid,
            FirecrawlLog.data["credit_reported"].astext == "1",
        ).first()
        if already is not None:
            return
        mark = FirecrawlLog(
            type="crawl_status",
            success=True,
            status=1,
            credits_used=credits,
            data={
                "endpoint": "/v1/crawl/{job_id}",
                "firecrawl_job_id": fcid,
                "credit_reported": "1",
                "reported_credits": credits,
            },
            created_at=int(time.time()),
            updated_at=int(time.time()),
        )
        db.add(mark)
        db.commit()
    except Exception:
        db.rollback()
    try:
        from app.core.credit import report_credit_usage
        report_credit_usage(user_id, company_id, usage=credits, description=description)
    except Exception:
        pass  # 計費回報絕不影響主流程


def firecrawl_request(db: Session, method: str, url: str, api_key: str, *,
                      endpoint: str = None, json_body=None, timeout: float = 30,
                      job_id: str = None, batch_id: str = None,
                      firecrawl_job_id: str = None) -> requests.Response:
    """執行 Firecrawl HTTP 呼叫並寫入日誌；endpoint 缺省時自動取 URL path。"""
    t0 = time.monotonic()
    headers = {"Authorization": f"Bearer {api_key}",
               "Content-Type": "application/json"}
    status_code = None
    resp_text = None
    error_msg = None
    try:
        r = requests.request(method, url, headers=headers, json=json_body,
                             timeout=timeout)
        status_code = r.status_code
        resp_text = r.text
        return r
    except Exception as e:
        error_msg = str(e)
        raise
    finally:
        log_firecrawl_call(
            db,
            endpoint=endpoint or url.split("?")[0],
            method=method,
            request_url=url,
            request_body=json_body,
            status_code=status_code,
            response_body=resp_text,
            error_message=error_msg,
            duration_ms=(time.monotonic() - t0) * 1000,
            job_id=job_id,
            batch_id=batch_id,
            firecrawl_job_id=firecrawl_job_id,
        )
        if status_code is not None and status_code < 400:
            _report_credit(endpoint or url.split("?")[0], resp_text)
