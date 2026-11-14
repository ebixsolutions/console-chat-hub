"""
KB Delta Patch — content_hash canonical 服務（KB005 修復）

套用位置：app/services/content_hash.py

問題根因
────────
現況（錯誤順序）：
    prepare KBDocument（content_hash 空）
    → 建 KBUserPublishConfirmation（effective_content_hash = ''）
    → 跑 Staging RAG
    → Staging 寫入真實 KBDocument.content_hash
    → publishDocument
    → resolvePublishApproval 比對兩個不同 hash
    → ✗ KB005

★ 不變式
    confirmation.effective_content_hash
      == KBDocument.content_hash
      == hash of exact Staging/Production content

正確順序（本模組實作）
────────────────────
    1.  prepare / create / reuse KBDocument
    2.  resolve_effective_content()        取得精確有效內容
    3.  canonical_content_hash()           計算 canonical hash
    4.  persist_content_hash()             寫入 KBDocument.content_hash
    5.  refetch                            重新讀取權威文件
    6.  create_user_confirmation()         用步驟 3 的 hash 建 confirmation
    7.  Staging RAG
    8.  verify_hash_unchanged()            ✗ 不符 → 400 CONTENT_HASH_DRIFT
    9.  publish
    10. Production Vector（記錄 staging_indexed_content_hash）
    11. live verification
    12. authoritative refetch

禁止
────
    ✗ 弱化 hash 驗證
    ✗ 把空白 hash 視為普遍有效
    ✗ 先建 confirmation 後算 hash
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import KBDocument, KBImportItem, KBReview
from app.models import KBUserPublishConfirmation


def _now():
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return uuid.uuid4().hex


# ══════════════════════════════════════════════════════════════════════════════
# canonical hash
# ══════════════════════════════════════════════════════════════════════════════
def canonical_content_hash(content: Optional[str]) -> str:
    """
    ★ 必須與前端 services/sourceGroundingValidator.js 的 sha256() 產生相同結果。

    前端實作（供對照）：
        async function sha256(text) {
          const buf = new TextEncoder().encode((text || '').trim())
          const hash = await crypto.subtle.digest('SHA-256', buf)
          return Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, '0')).join('')
        }

    → normalize = .trim()，編碼 UTF-8，輸出小寫十六進位。
    """
    normalized = (content or "").strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


# ══════════════════════════════════════════════════════════════════════════════
# 步驟 2：解析精確有效內容
# ══════════════════════════════════════════════════════════════════════════════
def resolve_effective_content(db: Session, doc: KBDocument) -> str:
    """
    優先順序（與前端 aiReviewFixPreviewService 的 reassemble 一致）：
        1. 該文件關聯的 KBImportItem 逐條組裝
             final_content > ai_suggested_content > original_content
           （item 需排除 is_deleted_from_publish=True）
        2. 若無關聯 item → KBDocument.raw_content

    ★ 這個順序決定了 hash 的值。任何偏離都會導致 hash 漂移。
    """
    items = (
        db.query(KBImportItem)
        .filter(KBImportItem.original_document_id == doc.id)
        .order_by(KBImportItem.item_index.asc())
        .all()
    )
    # 舊資料可能用 saved_document_id / created_document_id 綁定
    if not items:
        items = (
            db.query(KBImportItem)
            .filter(
                (KBImportItem.saved_document_id == doc.id)
                | (KBImportItem.created_document_id == doc.id)
            )
            .order_by(KBImportItem.item_index.asc())
            .all()
        )

    if items:
        parts = []
        for it in items:
            if getattr(it, "is_deleted_from_publish", False):
                continue
            piece = (
                it.human_edited_content
                or it.final_content
                or it.ai_suggested_content
                or it.original_content
                or ""
            )
            if piece and piece.strip():
                parts.append(piece.strip())
        if parts:
            return "\n\n".join(parts)

    return doc.raw_content or ""


# ══════════════════════════════════════════════════════════════════════════════
# 步驟 3-5：計算 → 寫入 → 重讀
# ══════════════════════════════════════════════════════════════════════════════
def persist_content_hash(db: Session, doc: KBDocument) -> tuple[str, str]:
    """
    ★ 必須在建立 confirmation 之前呼叫。

    回傳 (effective_content, content_hash)
    """
    effective = resolve_effective_content(db, doc)
    content_hash = canonical_content_hash(effective)

    doc.content_hash = content_hash
    # industries 必須是 dict
    if not isinstance(doc.industries, dict):
        doc.industries = {"values": doc.industries} if isinstance(doc.industries, list) else {"values": []}
    db.add(doc)
    db.commit()
    db.refresh(doc)      # 步驟 5：重讀權威文件

    return effective, content_hash


# ══════════════════════════════════════════════════════════════════════════════
# 步驟 6：建立 / 重用 confirmation
# ══════════════════════════════════════════════════════════════════════════════
def create_user_confirmation(
    db: Session,
    doc: KBDocument,
    *,
    confirmed_by: str,
    tenant_id: str,
    content_checked: bool,
    business_suitability_accepted: bool,
    ai_use_acknowledged: bool,
    publish_attempt_id: Optional[str] = None,
) -> KBUserPublishConfirmation:
    """
    ★ 必須在 persist_content_hash() 之後呼叫。
      effective_content_hash 直接取 doc.content_hash（已為 canonical）。

    三項聲明必須全部為 True，否則 400。
    冪等：同 (document_id, document_version, effective_content_hash) 已存在則重用。
    """
    if not (content_checked and business_suitability_accepted and ai_use_acknowledged):
        raise HTTPException(
            status_code=400,
            detail={
                "error": "CONFIRMATION_DECLARATIONS_INCOMPLETE",
                "detail": "三項聲明必須全部勾選",
            },
        )

    if not doc.content_hash:
        # ★ 禁止空白 hash 視為有效
        raise HTTPException(
            status_code=400,
            detail={
                "error": "CONTENT_HASH_MISSING",
                "detail": "content_hash 未計算，必須先呼叫 persist_content_hash()",
            },
        )

    existing = (
        db.query(KBUserPublishConfirmation)
        .filter(
            KBUserPublishConfirmation.document_id == doc.id,
            KBUserPublishConfirmation.document_version == (doc.version or "1.0"),
            KBUserPublishConfirmation.effective_content_hash == doc.content_hash,
        )
        .first()
    )
    if existing:
        return existing

    review = (
        db.query(KBReview)
        .filter(KBReview.document_id == doc.id)
        .order_by(KBReview.created_date.desc())
        .first()
    )

    row = KBUserPublishConfirmation(
        id=_new_id(),
        document_id=doc.id,
        document_version=doc.version or "1.0",
        effective_content_hash=doc.content_hash,
        review_id=review.id if review else None,
        original_review_publish_decision=(
            getattr(review, "publish_decision", None) if review else None
        ),
        approval_mode="user_confirmation",
        confirmation_content_checked=content_checked,
        confirmation_business_suitability_accepted=business_suitability_accepted,
        confirmation_ai_use_acknowledged=ai_use_acknowledged,
        confirmed_by=confirmed_by,
        confirmed_at=_now(),
        tenant_id=tenant_id,
        publish_attempt_id=publish_attempt_id or _new_id(),
        publish_result="pending",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ══════════════════════════════════════════════════════════════════════════════
# 步驟 8：驗證 hash 未漂移
# ══════════════════════════════════════════════════════════════════════════════
def verify_hash_unchanged(db: Session, doc_id: str, confirmation_id: str) -> None:
    """
    ★ 必須在 Staging RAG 之後、publish 之前呼叫。
      不符 → 400 CONTENT_HASH_DRIFT，拒絕發布。
    """
    db.expire_all()
    doc = db.query(KBDocument).filter(KBDocument.id == doc_id).first()
    conf = (
        db.query(KBUserPublishConfirmation)
        .filter(KBUserPublishConfirmation.id == confirmation_id)
        .first()
    )
    if not doc or not conf:
        raise HTTPException(
            status_code=404,
            detail={"error": "DOC_OR_CONFIRMATION_NOT_FOUND"},
        )

    if not doc.content_hash or not conf.effective_content_hash:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "CONTENT_HASH_MISSING",
                "detail": "content_hash 為空，不可視為有效",
            },
        )

    if doc.content_hash != conf.effective_content_hash:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "CONTENT_HASH_DRIFT",
                "detail": {
                    "document_id": doc_id,
                    "confirmation_hash": conf.effective_content_hash,
                    "current_hash": doc.content_hash,
                    "message": "文件內容在確認後已變更，必須重新確認",
                },
            },
        )

    # 若 Staging 已記錄索引內容 hash，也必須一致
    if doc.staging_indexed_content_hash and \
            doc.staging_indexed_content_hash != doc.content_hash:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "CONTENT_HASH_DRIFT",
                "detail": {
                    "document_id": doc_id,
                    "staging_indexed_hash": doc.staging_indexed_content_hash,
                    "current_hash": doc.content_hash,
                    "message": "Staging 索引內容與現行內容不一致",
                },
            },
        )


# ══════════════════════════════════════════════════════════════════════════════
# 步驟 10：記錄 Staging 已索引內容 hash
# ══════════════════════════════════════════════════════════════════════════════
def record_staging_indexed_hash(db: Session, doc: KBDocument) -> None:
    """Staging RAG 完成後呼叫，把當時實際索引的內容 hash 釘住。"""
    doc.staging_indexed_content_hash = doc.content_hash
    if not isinstance(doc.industries, dict):
        doc.industries = {"values": []}
    db.add(doc)
    db.commit()


# ══════════════════════════════════════════════════════════════════════════════
# 完整安全順序 —— 一次性封裝
# ══════════════════════════════════════════════════════════════════════════════
def prepare_document_for_publish(
    db: Session,
    doc: KBDocument,
    *,
    confirmed_by: str,
    tenant_id: str,
    content_checked: bool = False,
    business_suitability_accepted: bool = False,
    ai_use_acknowledged: bool = False,
    use_user_confirmation: bool = False,
) -> dict:
    """
    執行步驟 1-6（confirmation 建立為止）。
    Staging RAG 之後呼叫端必須自行呼叫 verify_hash_unchanged()。

    回傳 {content_hash, effective_length, confirmation_id | None}
    """
    # 步驟 2-5
    effective, content_hash = persist_content_hash(db, doc)

    confirmation_id = None
    if use_user_confirmation:
        # 步驟 6
        conf = create_user_confirmation(
            db, doc,
            confirmed_by=confirmed_by,
            tenant_id=tenant_id,
            content_checked=content_checked,
            business_suitability_accepted=business_suitability_accepted,
            ai_use_acknowledged=ai_use_acknowledged,
        )
        confirmation_id = conf.id

    return {
        "content_hash": content_hash,
        "effective_length": len(effective),
        "confirmation_id": confirmation_id,
    }
