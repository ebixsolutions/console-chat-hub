"""
Publish Approval Resolver — 移植自 publishApprovalResolver.js（62 行）

★ 重大變更（08-04）：KB005 內容品質閘門已「移除」。
  publish 審批改為 technical-only + KB006 integrity gate（fail-closed）。

  - AI 行業審批仍在（review / fix preview / Apply），但結果不再阻擋也不再授權發布
  - KB006：任一 KBReviewFixPreview.integrity_failure=True → 阻擋發布（rollback 未完成）
  - integrity gate 查詢本身出錯 → fail-closed，不放行
"""
from __future__ import annotations
from sqlalchemy.orm import Session

from app.models import KBReviewFixPreview


def resolve_publish_approval(db: Session, document_id: str) -> dict:
    """
    回傳 {approved, approval_mode, review_id, confirmation_id, reason}
    """
    # ── KB006 integrity gate（fail-closed）──
    try:
        previews = (db.query(KBReviewFixPreview)
                    .filter(KBReviewFixPreview.document_id == document_id)
                    .all())
    except Exception as e:
        return {
            "approved": False, "approval_mode": None,
            "review_id": None, "confirmation_id": None,
            "reason": f"KB006_INTEGRITY_GATE_UNAVAILABLE: {e}",
        }

    integrity_failed = next(
        (p for p in previews if getattr(p, "integrity_failure", False)), None)
    if integrity_failed:
        return {
            "approved": False, "approval_mode": None,
            "review_id": None, "confirmation_id": None,
            "reason": (f"KB006: integrity_failure on preview {integrity_failed.id} "
                       f"— rollback incomplete, publish blocked"),
        }

    # ── technical-only（內容品質閘門已移除）──
    return {
        "approved": True, "approval_mode": "technical_only",
        "review_id": None, "confirmation_id": None,
        "reason": "Technical gates passed — content-quality gate removed",
    }
