"""
外部導入 API（External Import）— POST /api/v1/public/externalImport

供第三方系統以 company api_key 直接導入原始內容，流程沿用既有
functions/kbImportStart 的實作模式：

  1. api_key 認證（X-API-Key / api_key header、api_key query/body）
     → 對照 company.api_key 解析 company_id，後續所有寫入皆綁定該 company。
     再由 system_users.company_id 解析該 company 的 user，
     kb_import_batch / kb_import_item 的 created_by / tenant_id 一律記錄
     system_users.id（與既有前端流程一致）；查無使用者則回 400。
  2. 以既有 LLM 服務（app.core.llm.invoke_llm → Platform LLM Router）
     將 raw_content 拆分為結構化 knowledge items。
  3. 委派 kbImportStart（app.routers.import_ops）列舉 KBImportItem，
     沿用既有 batch / item 落地、規則分類與來源標記。
  4. 以既有 AI 分類（import_pipeline._classify_industry_ai）逐條識別
     industry / sub_industries，結果隨回應回傳。

與既有 API 一致的行為：
  - 統一 JSON 封套：成功 {"success": true, "data": ..., "meta": ...}；
    失敗 {"success": false, "error": {"code", "message", "detail"}}。
  - raw_content 超過上限一律拒絕（不靜默截斷）。
  - company 隔離：batch / item 一律落 company_id，回應僅含本次 company 資料。
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Header, Query
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.auth import AuthContext
from app.core.config import settings
from app.core.database import get_db
from app.core.tenant_ctx import set_tenant_context
from app.models import Company, KBImportBatch, KBImportItem, User
from app.routers.import_ops import kb_import_start
from app.services import import_pipeline as pipe
from app.services.content_types import (
    knowledge_type_for,
    label_for_source_type,
)
from app.services.industry_groups import label_for_industry, label_for_subcategory

logger = logging.getLogger("nexus_kb.external_import")

router = APIRouter(prefix="/api/v1/public", tags=["public-external-import"])

# ── 輸入限制（source_type 對應 kb_import_item.source_type）──
SOURCE_TYPE_MAX_LEN = 50
TITLE_MAX_LEN = 1000
SOURCE_FORMAT = "external"

# ── LLM 拆分 ──
LLM_SPLIT_MAX_ITEMS = 30
LLM_SPLIT_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["title", "content"],
            },
        }
    },
    "required": ["items"],
}
LLM_SPLIT_PROMPT = (
    "你是知識庫內容拆分員。請將以下原始內容拆分為獨立的知識條目。\n\n"
    "【標題】{title}\n"
    "【原始內容】\n{raw}\n\n"
    "要求：\n"
    "1. 每個條目包含 title（條目標題）與 content（該條目對應的原文內容）。\n"
    "2. content 必須逐字取自原文，不得新增、刪除或改寫任何事實、數字與單位。\n"
    "3. 依原文順序拆分；若無法拆分，整份內容作為單一條目回傳。\n"
    "4. 只回傳 JSON，不要任何說明文字。"
)

# 去除控制字元（保留 \n \t \r）— 防止 NUL / 控制序列注入
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class LLMServiceError(RuntimeError):
    """LLM 服務呼叫失敗（認證/配額/連線/回應格式皆屬此類）。"""


# ══════════════════════════════════════════════════════════════════════════
# Rate limit（in-process sliding window）
#   ★ 以 api_key 雜湊為桶；多 worker 部署時每個 process 各自計數。
# ══════════════════════════════════════════════════════════════════════════
_RATE_LOCK = threading.Lock()
_RATE_BUCKETS: dict[str, deque] = {}


def _rate_limit_retry_after(api_key: str) -> int:
    """回傳 0 = 允許；>0 = 被限流，值為建議等待秒數。"""
    limit = max(1, int(settings.external_import_rate_limit))
    window = max(1, int(settings.external_import_rate_window_seconds))
    key = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:32]
    now = time.monotonic()

    with _RATE_LOCK:
        bucket = _RATE_BUCKETS.setdefault(key, deque())
        while bucket and now - bucket[0] >= window:
            bucket.popleft()
        if len(bucket) >= limit:
            return max(1, int(window - (now - bucket[0])) + 1)
        bucket.append(now)

        # 清理過期桶，避免長期運行時無界成長
        if len(_RATE_BUCKETS) > 10_000:
            for k in [k for k, b in _RATE_BUCKETS.items()
                      if not b or now - b[-1] >= window]:
                _RATE_BUCKETS.pop(k, None)
    return 0


# ══════════════════════════════════════════════════════════════════════════
# 內部工具
# ══════════════════════════════════════════════════════════════════════════
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _err(status: int, code: str, message: str, detail: Any = None,
         headers: Optional[dict] = None) -> JSONResponse:
    body: dict[str, Any] = {"success": False,
                            "error": {"code": code, "message": message}}
    if detail is not None:
        body["error"]["detail"] = detail
    return JSONResponse(status_code=status, content=body, headers=headers)


def _sanitize(value: str, *, strip: bool = True) -> str:
    """移除控制字元（保留換行/定位/Tab），避免 NUL 與控制序列注入。"""
    cleaned = _CONTROL_CHARS_RE.sub("", value or "")
    return cleaned.strip() if strip else cleaned


def _split_with_llm(db: Session, title: str, raw_content: str) -> list[dict]:
    """以既有 LLM 服務把 raw_content 拆分為 structured items。

    回傳 structured_items（可為空 → 交由 kbImportStart 走 legacy 規則拆分）。
    LLM 呼叫失敗時拋 LLMServiceError（endpoint 轉為 502）。
    """
    invoke = pipe._invoke_llm          # 由 app.main 啟動時註冊的 LLM 呼叫器
    if invoke is None:
        logger.warning("external import：LLM 未註冊，改用 kbImportStart legacy 拆分")
        return []

    prompt = LLM_SPLIT_PROMPT.format(title=title or "", raw=raw_content)
    try:
        out = invoke(prompt=prompt, response_json_schema=LLM_SPLIT_JSON_SCHEMA,
                     db=db, app_key="knowledge_base", task_type="extraction")
    except Exception as e:                                     # noqa: BLE001
        raise LLMServiceError(str(e)) from e

    raw_items = out.get("items") if isinstance(out, dict) else None
    if not isinstance(raw_items, list):
        return []

    items: list[dict] = []
    for entry in raw_items[:LLM_SPLIT_MAX_ITEMS]:
        if not isinstance(entry, dict):
            continue
        item_title = _sanitize(str(entry.get("title") or ""))
        content = _sanitize(str(entry.get("content") or ""), strip=False).strip()
        if not content:                    # 無內容的條目交由 legacy 路徑處理
            continue
        items.append({
            "text": item_title or title,
            "original_content": content,
            "raw_block_content": content,
            "source_block_type": "atomic_section",
            "source_format": SOURCE_FORMAT,
            "order": len(items),
        })
    return items


def _item_content(item: KBImportItem) -> str:
    sm = item.source_metadata or {}
    return item.original_content or sm.get("raw_block_content") or ""


def _item_view(item: KBImportItem) -> dict:
    industry = item.industry or ""
    subs = item.sub_industries
    if isinstance(subs, dict):                 # 相容舊 {"values": [...]} 格式
        subs = subs.get("values") or []
    if not isinstance(subs, list):
        subs = []
    subs = [s for s in subs if isinstance(s, str) and s.strip()]

    return {
        "item_id": item.id,
        "item_index": int(item.item_index or 0),
        "title": item.extracted_title or "",
        "content": _item_content(item),
        "source_type": item.source_type or "",
        "knowledge_type": item.knowledge_type or "",
        "status": item.status or "",
        "industry": industry,
        "industry_label": label_for_industry(industry) if industry else "",
        "sub_industries": subs,
        "sub_industry_labels": [lab for lab in
                                (label_for_subcategory(industry, s) for s in subs)
                                if lab],
    }


def _industry_summary(items: list[KBImportItem]) -> dict:
    """聚合本次導入的行業分類結果（items 尚未做任何 schema 轉換）。"""
    counts: dict[str, int] = {}
    subs: list[str] = []
    for it in items:
        industry = it.industry or ""
        if industry:
            counts[industry] = counts.get(industry, 0) + 1
        raw_subs = it.sub_industries
        if isinstance(raw_subs, dict):
            raw_subs = raw_subs.get("values") or []
        if isinstance(raw_subs, list):
            for s in raw_subs:
                if isinstance(s, str) and s.strip() and s not in subs:
                    subs.append(s)

    main = max(counts.items(), key=lambda kv: kv[1])[0] if counts else ""
    return {
        "industry": main,
        "industry_label": label_for_industry(main) if main else "",
        "sub_industries": subs,
        "sub_industry_labels": [lab for lab in
                                (label_for_subcategory(main, s) for s in subs)
                                if lab],
        "identified": bool(main),
        "industry_counts": counts,
    }


# ══════════════════════════════════════════════════════════════════════════
# 端點
# ══════════════════════════════════════════════════════════════════════════
@router.post(
    "/externalImport",
    summary="外部系統內容導入（api_key 認證）",
    description=(
        "第三方系統以 company api_key 導入原始內容：先以 LLM 將 `raw_content` 拆分為"
        "知識條目，再委派既有 kbImportStart 流程建立 import batch / items，"
        "並以 AI 識別 `industry` / `sub_industries`。\n\n"
        "認證：`X-API-Key` 或 `api_key` header（亦接受 `api_key` query/body 參數），"
        "值需等於 `company.api_key`；company 資料隔離由 server 端強制。"
        "寫入的 `created_by` / `tenant_id` 記錄該 company 綁定的 `system_users.id`，"
        "company 查無 system_users 記錄時回 400 `user_not_bound`。\n\n"
        "限制：`source_type` ≤ 50 字元、`title` ≤ 1000 字元、"
        "`raw_content` 20–18000 字元（超過一律拒絕，不截斷）。\n"
        "`source_type` 依 `CONTENT_TYPES` 對照出 `knowledge_type` 一併落至"
        " kb_import_item（查無對應時為 `other`）。\n"
        "錯誤碼：unauthorized / user_not_bound / invalid_request / "
        "raw_content_too_large / rate_limited / llm_error / import_start_failed / "
        "internal_error。"
    ),
)
def external_import(
    body: dict = Body(default_factory=dict),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
    api_key_header: Optional[str] = Header(default=None, alias="api_key"),
    api_key_query: Optional[str] = Query(
        default=None, alias="api_key", description="api_key（等同 header 認證）"),
    db: Session = Depends(get_db),
):
    started = time.time()

    # ── 1. 認證：api_key → company（server-side scope resolve）─────────────
    body_key = body.get("api_key")
    api_key = (x_api_key or api_key_header or api_key_query
               or (body_key if isinstance(body_key, str) else None))
    api_key = (api_key or "").strip()
    if not api_key:
        return _err(401, "unauthorized",
                    "api_key is required (X-API-Key header or api_key parameter)")

    company = db.query(Company).filter(Company.api_key == api_key).first()
    if company is None:
        return _err(401, "unauthorized", "invalid api_key")
    company_id = int(company.id)

    # ── 1b. 發起者：created_by / tenant_id 一律記錄 system_users.id ─────────
    #    api_key 為 company 級憑證，對應的 system_users 記錄（company_id 綁定，
    #    至多 1 筆）即為該次寫入的 owner；查無使用者則拒絕（不得寫入非 user id）。
    user = (db.query(User)
            .filter(User.company_id == company_id)
            .order_by(User.id.asc())
            .first())
    if user is None:
        return _err(400, "user_not_bound",
                    "company has no bound system_users record; "
                    "created_by / tenant_id must reference system_users.id")
    user_id = str(user.id)
    set_tenant_context(user_id, user_id, company_id)

    # ── 2. Rate limit ───────────────────────────────────────────────────────
    retry_after = _rate_limit_retry_after(api_key)
    if retry_after:
        return _err(429, "rate_limited",
                    "too many requests, please retry later",
                    {"retry_after_seconds": retry_after},
                    headers={"Retry-After": str(retry_after)})

    # ── 3. 參數驗證 ─────────────────────────────────────────────────────────
    source_type_raw = body.get("source_type")
    title_raw = body.get("title")
    raw_content_raw = body.get("raw_content")

    issues: list[dict] = []
    if not isinstance(source_type_raw, str) or not source_type_raw.strip():
        issues.append({"field": "source_type",
                       "message": "source_type is required and must be a non-empty string"})
    if not isinstance(title_raw, str) or not title_raw.strip():
        issues.append({"field": "title",
                       "message": "title is required and must be a non-empty string"})
    if not isinstance(raw_content_raw, str) or not raw_content_raw.strip():
        issues.append({"field": "raw_content",
                       "message": "raw_content is required and must be a non-empty string"})
    if issues:
        return _err(400, "invalid_request", "request validation failed", issues)

    if len(raw_content_raw) > pipe.RAW_CONTENT_THRESHOLD:
        return _err(400, "raw_content_too_large",
                    f"raw_content exceeds the {pipe.RAW_CONTENT_THRESHOLD} character limit",
                    {"length": len(raw_content_raw),
                     "limit": pipe.RAW_CONTENT_THRESHOLD})

    source_type = _sanitize(source_type_raw)
    title = _sanitize(title_raw)
    raw_content = _sanitize(raw_content_raw, strip=False).strip()

    if len(source_type) > SOURCE_TYPE_MAX_LEN:
        return _err(400, "invalid_request", "request validation failed",
                    [{"field": "source_type",
                      "message": f"source_type must be at most {SOURCE_TYPE_MAX_LEN} characters"}])
    if len(title) > TITLE_MAX_LEN:
        return _err(400, "invalid_request", "request validation failed",
                    [{"field": "title",
                      "message": f"title must be at most {TITLE_MAX_LEN} characters"}])
    if len(raw_content) < pipe.MIN_RAW_CONTENT:
        return _err(400, "invalid_request", "request validation failed",
                    [{"field": "raw_content",
                      "message": f"raw_content must be at least {pipe.MIN_RAW_CONTENT} characters"}])

    # ── 3b. 依 CONTENT_TYPES 對照知識型態（查無對應 → other）───────────────
    knowledge_type = knowledge_type_for(source_type)

    # ── 4. LLM 內容拆分 ─────────────────────────────────────────────────────
    try:
        structured_items = _split_with_llm(db, title, raw_content)
    except LLMServiceError as e:
        logger.warning("external import：LLM 拆分失敗：%s", e)
        return _err(502, "llm_error", "LLM content splitting failed", str(e))

    # ── 5. 委派 kbImportStart（既有 batch / item 落地流程）──────────────────
    auth_ctx = AuthContext(user_id=user_id, tenant_id=user_id, role="user",
                           company_id=company_id, email=user.email or "")
    try:
        result = kb_import_start({
            "batch_meta": {
                "file_name": f"{title or 'external-import'}.txt",
                "file_type": "txt",
                "source_type": source_type,
                "default_source_type": source_type,
                "default_knowledge_type": knowledge_type,
                "structured_items": structured_items,
            },
            "raw_content": raw_content,
        }, db, auth_ctx)
    except Exception as e:                                   # noqa: BLE001
        db.rollback()
        logger.exception("external import：kbImportStart 失敗")
        return _err(500, "internal_error", "failed to start import", str(e))

    if isinstance(result, JSONResponse):
        try:
            info = json.loads(bytes(result.body).decode("utf-8"))
        except Exception:                                     # noqa: BLE001
            info = {}
        return _err(result.status_code, "import_start_failed",
                    str(info.get("error") or "kbImportStart failed"),
                    info.get("detail"))

    batch_id = (result or {}).get("batchId")
    if not batch_id:
        return _err(502, "import_start_failed", "kbImportStart did not return a batchId",
                    result)

    batch = db.query(KBImportBatch).filter(KBImportBatch.id == batch_id).first()
    if batch is None:
        return _err(500, "internal_error", "import batch not found after creation")

    # ── 6. AI 行業分類（industry / sub_industries）+ owner / company 標記 ──
    #    created_by / tenant_id 明確覆寫為 system_users.id，與既有前端流程一致。
    batch.company_id = company_id
    batch.created_by = user_id
    batch.tenant_id = user_id
    items = (db.query(KBImportItem)
             .filter(KBImportItem.batch_id == batch_id)
             .order_by(KBImportItem.item_index.asc())
             .all())
    for it in items:
        it.company_id = company_id
        it.created_by = user_id
        it.tenant_id = user_id
        it.source_type = source_type
        it.knowledge_type = knowledge_type
        content = _item_content(it)
        try:
            industry, industries, sub_industries = pipe._classify_industry_ai(
                db, it.extracted_title or "", content, created_by=user_id)
        except Exception as e:                               # noqa: BLE001
            logger.warning("external import：item %s AI 分類失敗：%s", it.id, e)
            industry = ""
        if industry:                    # 未識別時保留 kbImportStart 的規則分類結果
            it.industry = industry
            it.industries = industries
            it.sub_industries = sub_industries or []
        db.add(it)
    try:
        db.add(batch)
        db.commit()
    except Exception as e:                                   # noqa: BLE001
        db.rollback()
        logger.exception("external import：分類結果寫入失敗")
        return _err(500, "internal_error", "failed to persist import results", str(e))

    item_views = [_item_view(it) for it in items]
    total_items = len(item_views)
    llm_split_used = bool(structured_items)

    return JSONResponse(status_code=200, content={
        "success": True,
        "data": {
            "batch_id": batch_id,
            "source_type": source_type,
            "knowledge_type": knowledge_type,
            "source_type_label": label_for_source_type(source_type),
            "title": title,
            "status": "completed" if total_items else "empty",
            "structured": bool(result.get("structured")),
            "source_format": result.get("source_format") or SOURCE_FORMAT,
            "total_items": total_items,
            "items": item_views,
            "industry_classification": _industry_summary(items),
            "llm_processing": {
                "split_used": llm_split_used,
                "split_item_count": len(structured_items),
                "fallback": None if llm_split_used else "rule_based_split",
            },
        },
        "meta": {
            "company_id": company_id,
            "company_name": company.name or "",
            "user_id": user_id,
            "request_id": uuid.uuid4().hex,
            "processed_at": _now().isoformat(),
            "elapsed_ms": int((time.time() - started) * 1000),
        },
    })
