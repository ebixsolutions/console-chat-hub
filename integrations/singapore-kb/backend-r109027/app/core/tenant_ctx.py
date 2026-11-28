"""
Tenant context — 讓所有 backend writer 自動帶上正確 tenant_id / created_by。

回應 QA gap C：不只 repository，連 import/publish/website 等 service 層直接
new Model() 建立的 record 也必須落 tenant_id，否則 tenant-scoped 讀取會漏或誤。

機制：
  - contextvar 於 get_current_user 設定（每個 authed request 必經）。
  - SQLAlchemy before_insert 事件：若 instance 有 tenant_id/created_by 欄位且為空，
    自動由 contextvar 補上。已明確指定者不覆蓋（如 service-role 跨租戶寫入）。
"""
from __future__ import annotations
import contextvars

from sqlalchemy import event

from app.models import Base

_current_tenant: contextvars.ContextVar = contextvars.ContextVar(
    "current_tenant", default=None)
_current_user: contextvars.ContextVar = contextvars.ContextVar(
    "current_user", default=None)
_current_company: contextvars.ContextVar = contextvars.ContextVar(
    "current_company", default=None)


def set_tenant_context(tenant_id, user_id, company_id=None):
    _current_tenant.set(tenant_id)
    _current_user.set(user_id)
    _current_company.set(company_id)


def get_tenant() -> str | None:
    return _current_tenant.get()


def get_user() -> str | None:
    return _current_user.get()


def get_company() -> int | None:
    return _current_company.get()


@event.listens_for(Base, "before_insert", propagate=True)
def _stamp_tenant(mapper, connection, target):
    cols = {c.name for c in target.__table__.columns}
    tid = _current_tenant.get()
    uid = _current_user.get()
    cid = _current_company.get()
    if "tenant_id" in cols and getattr(target, "tenant_id", None) in (None, ""):
        if tid:
            target.tenant_id = tid
    if "company_id" in cols and getattr(target, "company_id", None) in (None, ""):
        if cid:
            target.company_id = cid
    if "created_by" in cols and getattr(target, "created_by", None) in (None, ""):
        if uid:
            target.created_by = uid
