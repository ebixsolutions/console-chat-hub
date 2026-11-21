"""
KB Delta Patch — 6 個生命週期端點

套用位置：app/routers/lifecycle_ops.py

註冊方式（app/main.py 末尾）：
    from app.routers.lifecycle_ops import router as lifecycle_ops_router
    app.include_router(lifecycle_ops_router)

對外路徑：/api/functions/{name}

★ 全部逐行對照 Base44 原始碼移植，包含：
    - dryRun 預覽模式（kbRollbackImportBatch / kbResetKnowledgeBase）
    - 雙來源文件查找 + is_estimated 標記（kbRollbackImportBatch）
    - 級聯歸檔 chunk + import item
    - 審計寫入 KBSyncLog.error_message（JSON payload）
    - company_id 綁定（kbPermanentDeleteDocument / kbResetKnowledgeBase / kbRestoreArchivedDocument）
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.models import (
    KBAgentResult, KBAuditEvent, KBConflict, KBDiffResult, KBDocument,
    KBDocumentVersion, KBGuestImportSession, KBHallucinationEvent,
    KBImportBatch, KBImportItem, KBPublishOperation, KBReview, KBSyncLog,
    KBVectorChunk, WebsiteImportJob,
)

router = APIRouter(prefix="/api/functions", tags=["kb-lifecycle"])
app_router = APIRouter(
    prefix=f"/api/apps/{settings.app_id}/functions", tags=["kb-lifecycle"]
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


def _iso():
    return _now().isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex


def _err(status: int, error: str, detail: Any = None) -> JSONResponse:
    body: dict = {"error": error}
    if detail is not None:
        body["detail"] = detail
    return JSONResponse(status_code=status, content=body)


def _norm_industries(v):
    if isinstance(v, dict):
        return v
    if isinstance(v, list):
        return {"values": v}
    return {"values": []}


def _update_doc(db: Session, doc: KBDocument, fields: dict) -> None:
    for k, v in fields.items():
        setattr(doc, k, v)
    doc.industries = _norm_industries(doc.industries)
    db.add(doc)


def _write_audit(db: Session, global_doc_id: str, doc_id: str, payload: dict) -> None:
    """對應 Base44 把 JSON 塞進 KBSyncLog.error_message 的審計做法。"""
    db.add(KBSyncLog(
        id=_new_id(),
        global_document_id=global_doc_id,
        document_id=doc_id,
        from_app="knowledge_base",
        to_app="knowledge_base",
        sync_type="manual_sync",
        sync_status="completed",
        error_message=json.dumps(payload, ensure_ascii=False),
    ))
    db.commit()


def _saved_ids(batch: KBImportBatch) -> Optional[list[str]]:
    """saved_doc_ids 可能是 {"ids": [...]} 或裸 list（歷史資料）。"""
    v = batch.saved_doc_ids
    if isinstance(v, dict):
        return v.get("ids") or None
    if isinstance(v, list):
        return v or None
    return None


# ══════════════════════════════════════════════════════════════════════════════
# 1. kbArchiveDocument
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbArchiveDocument", methods=["POST"])
def kb_archive_document(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    歸檔文件 —— 從活躍使用中移除，停用所有檢索。
    同時級聯歸檔 KBVectorChunk 與 KBImportItem。

    輸入 {documentId, operatorUserId?, reason?}
    回傳 {success, archived_chunks, archived_import_items, was_published}
    """
    if not user:
        return _err(401, "Unauthorized")

    document_id = payload.get("documentId")
    if not document_id:
        return _err(400, "documentId required")

    op_user_id = payload.get("operatorUserId") or getattr(user, "id", None) or "system"
    reason = payload.get("reason") or "manual"
    now = _now()

    doc = db.query(KBDocument).filter(KBDocument.id == document_id).first()
    if not doc:
        return _err(404, "Document not found")

    was_published = (doc.status == "published") or (doc.available_to_live_console is True)
    prev_status = doc.status

    try:
        _update_doc(db, doc, {
            "status": "archived",
            "available_to_live_console": False,
            "staging_vector_status": "not_indexed",
            "production_vector_status": "not_indexed",
            "production_status": "archived",
            "archived_by": op_user_id,
            "archived_at": now,
            "archive_reason": reason,
        })

        # 級聯歸檔 vector chunks
        chunks = db.query(KBVectorChunk).filter(
            KBVectorChunk.document_id == document_id).all()
        archived_chunks = 0
        for c in chunks:
            c.status = "archived"
            db.add(c)
            archived_chunks += 1

        # 級聯歸檔 import items
        items = db.query(KBImportItem).filter(
            KBImportItem.original_document_id == document_id).all()
        archived_items = 0
        for it in items:
            it.status = "ignored"
            db.add(it)
            archived_items += 1

        db.commit()

        _write_audit(db, doc.global_document_id or document_id, document_id, {
            "operation": "archive_document",
            "operator_user_id": op_user_id,
            "reason": reason,
            "previous_status": prev_status,
            "was_published": was_published,
            "affected_chunks": archived_chunks,
            "affected_import_items": archived_items,
            "timestamp": _iso(),
        })

        return {"success": True, "archived_chunks": archived_chunks,
                "archived_import_items": archived_items,
                "was_published": was_published}

    except Exception as e:
        db.rollback()
        return _err(500, str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 2. kbRestoreArchivedDocument
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbRestoreArchivedDocument", methods=["POST"])
def kb_restore_archived_document(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Restore archived test-owned/admin document to a non-live draft with compensation.

    Archived vectors are never reactivated. A later explicit re-index/review/publish flow is required.
    """
    if not user:
        return _err(401, "Authentication required")
    document_id = payload.get("documentId")
    if not document_id:
        return _err(400, "documentId required")

    doc = db.query(KBDocument).filter(KBDocument.id == document_id).first()
    if not doc:
        return _err(404, "Document not found")
    # ★ D-006 修復：已認證使用者只要文件在其 company scope 內即可 restore，
    #   不再限定 admin / service-role / 必須持有 company claim。
    #   （service-role 不受限；無公司文件視為 system/test scope，任何 company 使用者可恢復。）
    if not getattr(user, "is_service_role", False):
        user_company = getattr(user, "company_id", 0) or 0
        doc_company = getattr(doc, "company_id", None)
        if not (doc_company is None or int(doc_company or 0) in (0, user_company)):
            return _err(403, "Permission denied: document is outside your company scope")
    if doc.status != "archived":
        return _err(409, "Document is not archived")

    def references_document(item: KBImportItem) -> bool:
        if document_id in {getattr(item, "original_document_id", None), getattr(item, "saved_document_id", None), getattr(item, "created_document_id", None)}:
            return True
        meta = item.source_metadata if isinstance(item.source_metadata, dict) else {}
        flow = meta.get("resolution_workflow") if isinstance(meta.get("resolution_workflow"), dict) else {}
        return document_id in (flow.get("applied_document_ids") or [])

    items = [it for it in db.query(KBImportItem).all() if references_document(it)]
    doc_snapshot = {
        "status": doc.status,
        "staging_vector_status": doc.staging_vector_status,
        "production_vector_status": doc.production_vector_status,
        "production_status": doc.production_status,
        "available_to_live_console": doc.available_to_live_console,
        "restored_by": doc.restored_by,
        "restored_at": doc.restored_at,
    }
    item_snapshots = {it.id: it.status for it in items}
    audit = None
    try:
        _update_doc(db, doc, {
            "status": "draft",
            "staging_vector_status": "not_indexed",
            "production_vector_status": "not_indexed",
            "production_status": "not_published",
            "available_to_live_console": False,
            "restored_by": getattr(user, "id", None) or "system",
            "restored_at": _now(),
        })
        restored_items = 0
        for it in items:
            if it.status == "ignored":
                it.status = "pending"
                db.add(it)
                restored_items += 1

        audit = KBSyncLog(
            id=_new_id(),
            global_document_id=doc.global_document_id or document_id,
            document_id=document_id,
            from_app="knowledge_base",
            to_app="knowledge_base",
            sync_type="manual_sync",
            sync_status="completed",
            error_message=json.dumps({
                "operation": "restore_document",
                "operator_user_id": getattr(user, "id", None),
                "previous_status": doc_snapshot["status"],
                "restored_to": "draft",
                "restored_import_items": restored_items,
                "timestamp": _iso(),
            }, ensure_ascii=False),
        )
        db.add(audit)
        db.commit()

        verify_doc = db.query(KBDocument).filter(KBDocument.id == document_id).first()
        verify_chunks = db.query(KBVectorChunk).filter(KBVectorChunk.document_id == document_id).all()
        verify_items = [it for it in db.query(KBImportItem).all() if references_document(it)]
        valid = bool(
            verify_doc
            and verify_doc.status == "draft"
            and verify_doc.available_to_live_console is not True
            and verify_doc.staging_vector_status == "not_indexed"
            and verify_doc.production_vector_status == "not_indexed"
            and all(c.status != "active" for c in verify_chunks)
            and all(it.status != "ignored" for it in verify_items)
        )
        if not valid:
            raise RuntimeError("RESTORE_ARCHIVE_POST_WRITE_VERIFICATION_FAILED")
        return {
            "success": True, "document_id": document_id, "restored_status": "draft",
            "restored_import_items": restored_items, "vectors_reactivated": 0,
            "readback_verified": True,
        }
    except Exception as e:
        db.rollback()
        rollback_failures = []
        try:
            fresh = db.query(KBDocument).filter(KBDocument.id == document_id).first()
            if fresh:
                _update_doc(db, fresh, doc_snapshot)
            for item_id, old_status in item_snapshots.items():
                it = db.query(KBImportItem).filter(KBImportItem.id == item_id).first()
                if it:
                    it.status = old_status
                    db.add(it)
            if audit and getattr(audit, "id", None):
                existing = db.query(KBSyncLog).filter(KBSyncLog.id == audit.id).first()
                if existing:
                    db.delete(existing)
            db.commit()
        except Exception as rb:
            db.rollback(); rollback_failures.append(str(rb))
        return JSONResponse(status_code=409 if not rollback_failures else 500, content={
            "error": str(e), "rolled_back": not rollback_failures, "rollback_failures": rollback_failures
        })


# ══════════════════════════════════════════════════════════════════════════════
# 3. kbPermanentDeleteDocument（company_id 綁定）
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbPermanentDeleteDocument", methods=["POST"])
def kb_permanent_delete_document(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    永久刪除文件 + 7 類關聯資料，刪除前寫 tombstone 審計。

    權限：company_id 綁定（JWT 帶 company_id 即通過；service-role 不受限）
    確認：confirmName 必須完全等於 doc.name（trim 後比對）

    輸入 {documentId, operatorUserId?, confirmName}
    回傳 {success, document_id, document_name, deleted_counts}
    """
    if not user:
        return _err(401, "Unauthorized")
    if not getattr(user, "company_id", 0) and not getattr(user, "is_service_role", False):
        return _err(403, "Permission denied: company_id required for permanent deletion")

    document_id = payload.get("documentId")
    if not document_id:
        return _err(400, "documentId required")

    op_user_id = getattr(user, "id", None) or "system"
    confirm_name = payload.get("confirmName")

    doc = db.query(KBDocument).filter(KBDocument.id == document_id).first()
    if not doc:
        return _err(404, "Document not found")

    if not confirm_name or confirm_name.strip() != (doc.name or "").strip():
        return _err(400, "Document name confirmation does not match")

    global_doc_id = doc.global_document_id or document_id
    doc_name = doc.name
    doc_status = doc.status
    was_published = doc.available_to_live_console is True

    counts = {"chunks": 0, "import_items": 0, "reviews": 0, "agent_results": 0,
              "conflicts": 0, "hallucinations": 0, "diff_results": 0, "sync_logs": 0}

    try:
        # 1. vector chunks
        for c in db.query(KBVectorChunk).filter(
                KBVectorChunk.document_id == document_id).all():
            db.delete(c)
            counts["chunks"] += 1

        # 2. import items
        for it in db.query(KBImportItem).filter(
                KBImportItem.original_document_id == document_id).all():
            db.delete(it)
            counts["import_items"] += 1

        # 3. reviews + agent results
        for rv in db.query(KBReview).filter(
                KBReview.document_id == document_id).all():
            for ar in db.query(KBAgentResult).filter(
                    KBAgentResult.review_id == rv.id).all():
                db.delete(ar)
                counts["agent_results"] += 1
            db.delete(rv)
            counts["reviews"] += 1

        # 4. conflicts（雙向）
        for cf in db.query(KBConflict).filter(
                or_(KBConflict.document_id_a == document_id,
                    KBConflict.document_id_b == document_id)).all():
            db.delete(cf)
            counts["conflicts"] += 1

        # 5. hallucination events
        for h in db.query(KBHallucinationEvent).filter(
                KBHallucinationEvent.document_id == document_id).all():
            db.delete(h)
            counts["hallucinations"] += 1

        # 6. diff results
        for d in db.query(KBDiffResult).filter(
                KBDiffResult.document_id == document_id).all():
            db.delete(d)
            counts["diff_results"] += 1

        # 7. sync logs（審計軌跡由下方 tombstone 保留）
        for sl in db.query(KBSyncLog).filter(
                KBSyncLog.document_id == document_id).all():
            db.delete(sl)
            counts["sync_logs"] += 1

        db.commit()

        # 8. ★ 刪除文件前寫 tombstone
        _write_audit(db, global_doc_id, document_id, {
            "operation": "permanent_delete_document",
            "operator_user_id": op_user_id,
            "document_name": doc_name,
            "document_id": document_id,
            "global_document_id": global_doc_id,
            "previous_status": doc_status,
            "was_published": was_published,
            "deleted_counts": counts,
            "timestamp": _iso(),
        })

        # 9. 最後刪除文件
        db.delete(doc)
        db.commit()
        remaining = db.query(KBDocument).filter(KBDocument.id == document_id).first()
        if remaining is not None:
            return _err(500, "DOCUMENT_DELETE_NOT_COMMITTED")

        return {"success": True, "document_id": document_id,
                "document_name": doc_name, "deleted_counts": counts}

    except Exception as e:
        db.rollback()
        return _err(500, str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 4. kbRollbackImportBatch
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbRollbackImportBatch", methods=["POST"])
def kb_rollback_import_batch(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    回滾整批匯入 —— 把該 batch 建立的文件歸檔（不刪除）。

    ★ 雙來源文件查找：
        1. batch.saved_doc_ids 有值 → 精確查找，is_estimated = False
        2. 無值 → 用 created_date 時間窗（-5min ~ +60min）+ created_by 推估，
                  is_estimated = True

    dryRun=True 時只回傳預覽計數，不執行任何寫入。

    輸入 {batchId, operatorUserId?, dryRun?}
    回傳（dryRun）{dry_run, batch_name, source_file_name, total_docs,
                   staging_rag_docs, published_docs, affected_chunks, is_estimated}
    回傳（執行）  {success, archived_docs, archived_chunks, batch_id, is_estimated}
    """
    if not user:
        return _err(401, "Unauthorized")

    batch_id = payload.get("batchId")
    if not batch_id:
        return _err(400, "batchId required")

    # Security parity with Base44: caller-supplied operatorUserId is never
    # authoritative. Audit actor is always the authenticated user.
    op_user_id = getattr(user, "id", None) or "system"
    dry_run = bool(payload.get("dryRun", False))

    batch = db.query(KBImportBatch).filter(KBImportBatch.id == batch_id).first()
    if not batch:
        return _err(404, "Batch not found")

    # ── 雙來源文件查找 ──
    saved = _saved_ids(batch)
    if saved:
        docs = db.query(KBDocument).filter(KBDocument.id.in_(saved)).all()
        is_estimated = False
    else:
        batch_time = batch.created_date or _now()
        if batch_time.tzinfo is None:
            batch_time = batch_time.replace(tzinfo=timezone.utc)
        after = batch_time - timedelta(minutes=5)
        before = batch_time + timedelta(minutes=60)
        docs = (
            db.query(KBDocument)
            .filter(
                KBDocument.created_date >= after,
                KBDocument.created_date <= before,
                KBDocument.created_by == batch.created_by,
                KBDocument.status != "archived",
            )
            .all()
        )
        is_estimated = True

    total_chunks = 0
    for d in docs:
        total_chunks += (
            db.query(KBVectorChunk)
            .filter(KBVectorChunk.document_id == d.id)
            .count()
        )

    staging_rag_docs = sum(1 for d in docs if d.staging_vector_status == "indexed")
    published_docs = sum(1 for d in docs if d.status == "published")

    if dry_run:
        return {"dry_run": True,
                "batch_name": batch.batch_name,
                "source_file_name": batch.source_file_name,
                "total_docs": len(docs),
                "staging_rag_docs": staging_rag_docs,
                "published_docs": published_docs,
                "affected_chunks": total_chunks,
                "is_estimated": is_estimated}

    try:
        archived_chunks = 0
        for d in docs:
            _update_doc(db, d, {
                "status": "archived",
                "available_to_live_console": False,
                "staging_vector_status": "not_indexed",
                "production_vector_status": "not_indexed",
                "production_status": "not_published",
            })
            for c in db.query(KBVectorChunk).filter(
                    KBVectorChunk.document_id == d.id).all():
                c.status = "archived"
                db.add(c)
                archived_chunks += 1

        batch.status = "rolled_back"
        db.add(batch)
        db.commit()

        _write_audit(db, batch_id, (docs[0].id if docs else batch_id), {
            "operation": "rollback_batch",
            "batch_id": batch_id,
            "operator_user_id": op_user_id,
            "archived_docs": len(docs),
            "archived_chunks": archived_chunks,
            "is_estimated": is_estimated,
            "timestamp": _iso(),
        })

        return {"success": True, "archived_docs": len(docs),
                "archived_chunks": archived_chunks, "batch_id": batch_id,
                "is_estimated": is_estimated}

    except Exception as e:
        db.rollback()
        return _err(500, str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 5. kbRestoreArchivedBatch
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbRestoreArchivedBatch", methods=["POST"])
def kb_restore_archived_batch(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    還原整批 —— 文件還原到 draft，batch 還原到 ready。

    輸入 {batchId, operatorUserId?}
    回傳 {success, restored_docs, batch_id, batch_status}
    """
    if not user:
        return _err(401, "Unauthorized")

    batch_id = payload.get("batchId")
    if not batch_id:
        return _err(400, "batchId required")

    op_user_id = payload.get("operatorUserId") or getattr(user, "id", None) or "system"

    batch = db.query(KBImportBatch).filter(KBImportBatch.id == batch_id).first()
    if not batch:
        return _err(404, "Batch not found")

    saved = _saved_ids(batch)
    restored_docs = 0
    anchor_doc_id = batch_id

    try:
        if saved:
            docs = (
                db.query(KBDocument)
                .filter(KBDocument.id.in_(saved), KBDocument.status == "archived")
                .all()
            )
            for d in docs:
                _update_doc(db, d, {"status": "draft"})
                restored_docs += 1
            if docs:
                anchor_doc_id = docs[0].id

        batch.status = "ready"
        db.add(batch)
        db.commit()

        _write_audit(db, anchor_doc_id, anchor_doc_id, {
            "operation": "restore_batch",
            "batch_id": batch_id,
            "operator_user_id": op_user_id,
            "restored_docs": restored_docs,
            "timestamp": _iso(),
        })

        return {"success": True, "restored_docs": restored_docs,
                "batch_id": batch_id, "batch_status": "ready"}

    except Exception as e:
        db.rollback()
        return _err(500, str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 6. kbResetKnowledgeBase（company_id 綁定）
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbResetKnowledgeBase", methods=["POST"])
def kb_reset_knowledge_base(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Hard-delete all file-import records for a clean UAT reset.

    Matches the current live Base44 endpoint semantics. A date-scoped explicit
    confirmation is mandatory. ``dryRun`` returns counts without writes.
    Deletion order is child-first and the endpoint verifies zero remaining rows.
    """
    if not user:
        return _err(401, "Unauthorized")
    if not getattr(user, "company_id", 0) and not getattr(user, "is_service_role", False):
        return _err(403, "Permission denied: company_id required for reset")

    confirmation = payload.get("confirmation")
    expected_confirmation = "UAT_RESET_20260806_1521"
    if confirmation != expected_confirmation:
        return _err(400, "RESET_CONFIRMATION_MISMATCH")

    entities = [
        KBAgentResult, KBReview, KBAuditEvent, KBPublishOperation, KBVectorChunk,
        KBDocumentVersion, KBConflict, KBHallucinationEvent, KBDiffResult, KBSyncLog,
        KBImportItem, KBGuestImportSession, WebsiteImportJob, KBDocument, KBImportBatch,
    ]
    names = [model.__name__ for model in entities]
    before = {model.__name__: db.query(model).count() for model in entities}
    if payload.get("dryRun") is True:
        return {"dry_run": True, "scope": "all_file_import_records", "before": before}

    deleted: dict[str, int] = {}
    try:
        for model in entities:
            count = db.query(model).delete(synchronize_session=False)
            deleted[model.__name__] = int(count or 0)
            db.flush()
        db.commit()
    except Exception as e:
        db.rollback()
        return _err(500, str(e))

    remaining = {model.__name__: db.query(model).count() for model in entities}
    remaining_total = sum(remaining.values())
    body = {
        "success": remaining_total == 0,
        "scope": "all_file_import_records",
        "operator": getattr(user, "id", None) or "system",
        "before": before, "deleted": deleted, "remaining": remaining,
        "remaining_total": remaining_total, "completed_at": _iso(),
    }
    if remaining_total:
        return JSONResponse(status_code=500, content=body)
    return body


# ══════════════════════════════════════════════════════════════════════════════
# 7. kbCleanupUatSession — scoped MANUS_UAT_ cleanup（company_id 綁定）
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbCleanupUatSession", methods=["POST"])
def kb_cleanup_uat_session(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """company_id 綁定的 UAT 清理端點（MANUS_UAT_ 前綴限定）。

    Production FastAPI keeps this stricter than Base44 guest fallback: an
    authenticated caller with company_id (or service-role) is required, and only
    MANUS_UAT_ prefixed records are eligible.
    """
    if not user:
        return _err(401, "Unauthorized")
    if not getattr(user, "company_id", 0) and not getattr(user, "is_service_role", False):
        return _err(403, "Permission denied: company_id required for MANUS_UAT_ cleanup")
    prefix = "MANUS_UAT_"
    dry_run = payload.get("dry_run") is not False

    batches = db.query(KBImportBatch).all()
    safe_batches = [b for b in batches if str(getattr(b, "source_file_name", "") or "").startswith(prefix) or str(getattr(b, "batch_name", "") or "").startswith(prefix)]
    batch_ids = {b.id for b in safe_batches}
    items = db.query(KBImportItem).filter(KBImportItem.batch_id.in_(batch_ids)).all() if batch_ids else []
    doc_ids = {getattr(it, "saved_document_id", None) or getattr(it, "created_document_id", None) for it in items}
    doc_ids.discard(None)
    docs = db.query(KBDocument).filter(KBDocument.id.in_(doc_ids)).all() if doc_ids else []
    for d in db.query(KBDocument).all():
        if str(d.name or "").startswith(prefix) and d.id not in doc_ids:
            docs.append(d); doc_ids.add(d.id)

    def residue():
        active_batches = sum(1 for b in safe_batches if b.status != "archived")
        active_documents = sum(1 for d in docs if d.status != "archived")
        live_documents = sum(1 for d in docs if d.available_to_live_console is True)
        active_staging = active_production = 0
        if doc_ids:
            chunks = db.query(KBVectorChunk).filter(KBVectorChunk.document_id.in_(doc_ids)).all()
            active_staging = sum(1 for c in chunks if c.status == "active" and c.environment == "staging")
            active_production = sum(1 for c in chunks if c.status == "active" and c.environment == "production")
        active_vectors = active_staging + active_production
        return {
            "active_batches": active_batches, "active_documents": active_documents,
            "active_vectors": active_vectors, "staging_vectors": active_staging,
            "production_vectors": active_production, "live_documents": live_documents,
        }

    before = residue()
    if dry_run:
        return {"dry_run": True, "prefix": prefix, "scope": "all_manus_uat_admin", "active_residue": sum(before.values()), "residue": before}

    failures = []
    try:
        for d in docs:
            d.status = "archived"; d.available_to_live_console = False
            d.staging_vector_status = "not_indexed"; d.production_vector_status = "not_indexed"
            d.production_status = "not_published"; db.add(d)
            for c in db.query(KBVectorChunk).filter(KBVectorChunk.document_id == d.id).all():
                c.status = "archived"; db.add(c)
        for b in safe_batches:
            b.status = "archived"; db.add(b)
        db.commit()
    except Exception as e:
        db.rollback(); failures.append(str(e))

    # authoritative requery
    safe_batches = [b for b in db.query(KBImportBatch).all() if str(getattr(b, "source_file_name", "") or "").startswith(prefix) or str(getattr(b, "batch_name", "") or "").startswith(prefix)]
    docs = [d for d in db.query(KBDocument).all() if str(d.name or "").startswith(prefix) or d.id in doc_ids]
    after = residue()
    active_residue = after["active_batches"] + after["active_documents"] + after["active_vectors"] + after["live_documents"]
    ok = not failures and active_residue == 0
    return JSONResponse(status_code=200 if ok else 409, content={
        "success": ok, "dry_run": False, "prefix": prefix, "scope": "all_manus_uat_admin",
        "active_residue": active_residue, "residue": after, "failures": failures,
    })
