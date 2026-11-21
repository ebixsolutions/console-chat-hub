"""
前端相容端點 — 補齊 Base44 平台原路由，避免 404：

  POST /api/apps/{app_id}/analytics/track/batch
       前端 analytics 埋點（fire-and-forget，不阻塞業務、不需登入）。
  GET  /api/apps/public/prod/public-settings/by-id/{app_id}
       公開 app 設定（public 路由，不需 auth）。

行為對齊 knowledge-base 舊版實作（same app），僅改為 sync SQLAlchemy + tenant context。
"""
from __future__ import annotations
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import AuthContext, get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.core.llm import _parse_json, invoke_llm
from app.models import AnalyticsEvent, KBAgentRegistry, KBCategorySchema

logger = logging.getLogger(__name__)

router = APIRouter(tags=["app-compat"])


def _parse_ts(value):
    """解析前端 timestamp（ISO 8601，可能含 Z），失敗回退 now()。"""
    if not value:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


# ══════════════════════════════════════════════════════════════════════════
# POST /api/apps/{app_id}/analytics/track/batch
# ══════════════════════════════════════════════════════════════════════════
@router.post(f"/api/apps/{settings.app_id}/analytics/track/batch")
def track_batch_events(payload: dict = Body(default_factory=dict),
                       db: Session = Depends(get_db)):
    """Batch track analytics events — 前端埋點必須永遠 200，不可影響頁面效能。"""
    events = payload.get("events") or []
    tracked = 0
    for event_data in events:
        try:
            props = event_data.get("properties") or {}
            ev = AnalyticsEvent(
                app_id=settings.app_id,
                event_name=event_data.get("event_name"),
                event_type=event_data.get("event_type", "custom"),
                user_id=str(event_data["user_id"]) if event_data.get("user_id") is not None else None,
                session_id=event_data.get("session_id"),
                page_url=event_data.get("page_url"),
                referrer=props.get("referrer"),
                properties=props,
                timestamp=_parse_ts(event_data.get("timestamp")),
            )
            db.add(ev)
            tracked += 1
        except Exception:
            continue
    try:
        db.commit()
    except Exception:
        db.rollback()
    return {"success": True, "accepted": tracked,
            "message": f"Successfully tracked {tracked} events"}


# ══════════════════════════════════════════════════════════════════════════
# GET /api/apps/public/prod/public-settings/by-id/{app_id}
# ══════════════════════════════════════════════════════════════════════════
@router.get("/api/apps/public/prod/public-settings/by-id/{app_id}")
def get_public_settings_by_id(app_id: str, db: Session = Depends(get_db)):
    """Get public settings for a specific app by app_id（公開路由，不需 auth）。

    前端契約：固定回傳 {"id": app_id, "public_settings": "public_without_login"}。
    """
    return {"id": app_id, "public_settings": "public_without_login"}


# ══════════════════════════════════════════════════════════════════════════
# POST /api/apps/{app_id}/integration-endpoints/Core/InvokeLLM
# Base44 相容 LLM proxy — 前端多 Agent 審核/分類直接呼叫
# （對齊 knowledge-base 舊後端 app/main.py 的 integration-endpoints 實作）
# ══════════════════════════════════════════════════════════════════════════
@router.post(f"/api/apps/{settings.app_id}/integration-endpoints/Core/InvokeLLM")
def invoke_llm_endpoint(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user: AuthContext = Depends(get_current_user),
):
    """
    取代 base44.integrations.Core.InvokeLLM 的 HTTP 入口。

    輸入 {prompt, response_json_schema?}
      - prompt 為必填；也相容 messages 陣列（取最後一則 content）。
      - response_json_schema 存在 → invoke_llm 直接回傳解析後的 dict。
      - 無 schema → 拿純文字後嘗試解析 JSON，解析失敗回傳原文字。
    走 Platform LLM Router（policy / budget / logs），需要登入 token。
    """
    prompt = payload.get("prompt")
    if not prompt:
        messages = payload.get("messages") or []
        last = messages[-1] if messages else {}
        prompt = last.get("content")
    if not prompt:
        raise HTTPException(400, "Missing prompt or messages")

    schema = payload.get("response_json_schema")
    common = dict(
        db=db,
        app_key=payload.get("app_key", "knowledge_base"),
        task_type=payload.get("task_type", "classification"),
        module_key=payload.get("module_key"),
        agent_key=payload.get("agent_key"),
        temperature=float(payload.get("temperature", 0.2)),
        max_tokens=int(payload["max_tokens"]) if payload.get("max_tokens") else None,
    )
    try:
        if schema:
            return invoke_llm(str(prompt), response_json_schema=schema, **common)
        text = invoke_llm(str(prompt), **common)
        try:
            return _parse_json(text)
        except json.JSONDecodeError:
            return text
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"LLM invocation failed: {str(e)}")


# ══════════════════════════════════════════════════════════════════════════
# POST /api/apps/{app_id}/company/new
# Company Setup — 把 system-level (company_id=0) 的 config 複製到目標 company
# （對齊 knowledge-base app/company_setup/router.py，改為 sync SQLAlchemy）
# ══════════════════════════════════════════════════════════════════════════
@router.post("/api/apps/{app_id}/company/new")
def company_new_setup(
    app_id: str,
    db: Session = Depends(get_db),
    user: AuthContext = Depends(get_current_user),
):
    """
    Copy system-level (company_id=0) configurations to the target company.

    Copies records from:
      - kb_agent_registry
      - kb_category_schema

    The target company_id is extracted from the JWT token (Authorization header).
    """
    try:
        target_company_id = user.company_id

        if target_company_id is None or target_company_id == 0:
            return {
                "success": False,
                "error": "Invalid company_id: cannot copy to company_id 0",
            }

        # ── Check if target company already has data ────────────────
        for model, label in [
            (KBAgentRegistry, "agent_registry"),
            (KBCategorySchema, "category_schema"),
        ]:
            count = db.query(model).filter(
                model.company_id == target_company_id).count()
            if count and count > 0:
                return {
                    "success": True,
                    "message": f"Company {target_company_id} already has data in kb_{label}, skipping copy",
                    "already_exists": True,
                    "company_id": target_company_id,
                }

        now = datetime.now(timezone.utc)

        # ── Column names to exclude when copying (PK + timestamps) ──
        _EXCLUDE = {"id", "created_date", "updated_date"}

        def _copy_rows(model, rows):
            values = []
            for row in rows:
                data = {
                    c.name: getattr(row, c.name)
                    for c in model.__table__.columns
                    if c.name not in _EXCLUDE
                }
                data["company_id"] = target_company_id
                data["created_date"] = now
                data["updated_date"] = now
                values.append(data)
            if values:
                db.add_all(model(**v) for v in values)
            return len(rows)

        # ── 1. Batch copy kb_agent_registry ─────────────────────────
        system_agents = db.query(KBAgentRegistry).filter(
            KBAgentRegistry.company_id == 0).all()
        agent_copied = _copy_rows(KBAgentRegistry, system_agents)

        # ── 2. Batch copy kb_category_schema ────────────────────────
        system_categories = db.query(KBCategorySchema).filter(
            KBCategorySchema.company_id == 0).all()
        category_copied = _copy_rows(KBCategorySchema, system_categories)

        db.commit()

        return {
            "success": True,
            "message": f"System configuration copied to company {target_company_id}",
            "agent_registry_copied": agent_copied,
            "category_schema_copied": category_copied,
            "company_id": target_company_id,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to copy system config to company %s",
                         getattr(user, "company_id", None))
        return {
            "success": False,
            "error": str(e),
        }
