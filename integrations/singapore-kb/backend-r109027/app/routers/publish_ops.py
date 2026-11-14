"""
KB Delta Patch — 6 個 Publish 編排端點

套用位置：app/routers/publish_ops.py

註冊方式（app/main.py 末尾）：
    from app.routers.publish_ops import router as publish_ops_router
    app.include_router(publish_ops_router)

對外路徑：/api/functions/{name}     ← 與 Base44 公開 URL 一致
"""
from __future__ import annotations

import logging
import random
import string
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.auth import get_current_user          # 既有依賴
from app.core.config import settings
from app.core.database import get_db                # 既有依賴
from app.models import KBImportItem, KBDocument, KBDocumentVersion, KBReviewFixPreview
from app.models import KBPublishOperation
from app.services import publish_operation_core as core

logger = logging.getLogger("nexus_kb.publish")

router = APIRouter(prefix="/api/functions", tags=["kb-publish"])
app_router = APIRouter(
    prefix=f"/api/apps/{settings.app_id}/functions", tags=["kb-publish"]
)


def _register_both(path: str, **route_kwargs):
    """同時註冊到 /api/functions 與 /api/apps/{app_id}/functions，避免前端 404。"""

    def decorator(func):
        router.add_api_route(path, func, **route_kwargs)
        app_router.add_api_route(path, func, **route_kwargs)
        return func

    return decorator


TERMINAL = core.TERMINAL


def _now():
    return datetime.now(timezone.utc)


def _rand(n: int = 8) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(n))


def _new_id() -> str:
    return uuid.uuid4().hex


def _err(status: int, error: str, detail: Any = None) -> JSONResponse:
    body: dict = {"error": error}
    if detail is not None:
        body["detail"] = detail
    return JSONResponse(status_code=status, content=body)


def _serialize(op: KBPublishOperation) -> dict:
    """轉為前端可用的 dict。前端依賴 snake_case 欄位名，不可改。"""
    if op is None:
        return None
    out = {}
    for c in op.__table__.columns:
        v = getattr(op, c.name)
        if isinstance(v, datetime):
            v = v.isoformat()
        out[c.name] = v
    return out


# ══════════════════════════════════════════════════════════════════════════════
# 1. kbPublishStart
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbPublishStart", methods=["POST"])
def kb_publish_start(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Base44 2026-08-24 authoritative publish-start contract.

    Adds:
      document_bindings[] with current document + optional candidate binding
      server-authoritative candidate lookup from KBImportItem.source_metadata
      fail-closed candidate version/hash verification
      exact active/excluded scope reconciliation
      terminal/stale idempotency retry handling
    """
    try:
        _, tenant_id = core.resolve_auth(user)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))

    document_ids = payload.get("document_ids") if isinstance(payload.get("document_ids"), list) else []
    idempotency_key = payload.get("idempotency_key") or f"pub_{int(_now().timestamp()*1000)}_{_rand(8)}"
    detection = payload.get("detection") or {}
    skipped_detection_types = (
        detection.get("skipped_detection_types")
        if isinstance(detection.get("skipped_detection_types"), list) else []
    )
    active_item_ids = payload.get("active_item_ids") if isinstance(payload.get("active_item_ids"), list) else None
    excluded_item_ids = payload.get("excluded_item_ids") if isinstance(payload.get("excluded_item_ids"), list) else None
    batch_id = payload.get("batch_id") or None
    requested_bindings = payload.get("document_bindings") if isinstance(payload.get("document_bindings"), list) else []

    def item_document_ids(item):
        ids = []
        primary = item.saved_document_id or item.created_document_id or item.original_document_id
        if primary:
            ids.append(primary)
        meta = item.source_metadata if isinstance(item.source_metadata, dict) else {}
        flow = meta.get("resolution_workflow") if isinstance(meta.get("resolution_workflow"), dict) else {}
        if flow.get("apply_status") == "applied":
            for did in flow.get("applied_document_ids") or []:
                if did and did not in ids:
                    ids.append(did)
        return ids

    server_candidate_by_document: dict[str, dict] = {}
    normalized_orphan_document_ids: list[str] = []
    excluded_document_ids: list[str] = []

    if active_item_ids is not None:
        if not active_item_ids:
            return _err(400, "EMPTY_PUBLISH_SCOPE", "All items excluded from publish scope")
        if not document_ids:
            return _err(400, "ACTIVE_ITEM_DOCUMENT_BINDING_FAILED",
                        {"active_count": len(active_item_ids), "document_count": 0})
        if batch_id:
            try:
                all_items = db.query(KBImportItem).filter(KBImportItem.batch_id == batch_id).all()
                server_active = [i for i in all_items if i.is_deleted_from_publish is not True]
                server_excluded = [i for i in all_items if i.is_deleted_from_publish is True]

                for item in server_active:
                    meta = item.source_metadata if isinstance(item.source_metadata, dict) else {}
                    flow = meta.get("resolution_workflow") if isinstance(meta.get("resolution_workflow"), dict) else {}
                    if flow.get("apply_status") != "applied":
                        continue
                    for cand in flow.get("candidate_versions") or []:
                        if not isinstance(cand, dict):
                            continue
                        did = cand.get("document_id")
                        vid = cand.get("version_record_id")
                        if not did or not vid:
                            continue
                        old = server_candidate_by_document.get(did)
                        if old and old.get("version_record_id") != vid:
                            return _err(409, "MULTIPLE_SERVER_CANDIDATE_VERSIONS",
                                        {"document_id": did})
                        server_candidate_by_document[did] = cand

                server_active_ids = {i.id for i in server_active}
                server_excluded_ids = {i.id for i in server_excluded}
                server_active_with_binding = [
                    i.id for i in server_active if item_document_ids(i)
                ]
                frontend_active = set(active_item_ids)
                missing_active = [
                    iid for iid in server_active_with_binding if iid not in frontend_active
                ]
                if missing_active:
                    return _err(400, "SCOPE_MISMATCH", {
                        "reason": "frontend_missing_active_items",
                        "missing_active_item_ids": missing_active[:10],
                    })

                frontend_excluded = set(excluded_item_ids or [])
                missing_excluded = [
                    iid for iid in server_excluded_ids if iid not in frontend_excluded
                ]
                if missing_excluded:
                    return _err(400, "SCOPE_MISMATCH", {
                        "reason": "frontend_missing_excluded_items",
                        "missing_excluded_item_ids": missing_excluded[:10],
                    })

                by_id = {i.id: i for i in all_items}
                canonical = []
                for iid in active_item_ids:
                    item = by_id.get(iid)
                    if item:
                        for did in item_document_ids(item):
                            if did and did not in canonical:
                                canonical.append(did)

                missing_docs = [did for did in canonical if did not in document_ids]
                if missing_docs:
                    return _err(400, "ACTIVE_ITEM_DOCUMENT_BINDING_FAILED",
                                {"missing_document_ids": missing_docs[:10]})

                doc_to_active = {}
                for item in all_items:
                    for did in item_document_ids(item):
                        doc_to_active.setdefault(did, 0)
                        if item.id in server_active_ids:
                            doc_to_active[did] += 1

                extras = [did for did in document_ids if did not in set(canonical)]
                unsafe = [did for did in extras if doc_to_active.get(did, 0) > 0]
                if unsafe:
                    return _err(400, "SCOPE_MISMATCH", {
                        "reason": "extra_active_documents",
                        "document_ids": unsafe[:10],
                    })
                normalized_orphan_document_ids = [
                    did for did in extras if doc_to_active.get(did, 0) == 0
                ]
                document_ids = canonical

                unbound = []
                for iid in active_item_ids:
                    item = by_id.get(iid)
                    refs = item_document_ids(item) if item else []
                    if not refs or any(did not in set(document_ids) for did in refs):
                        unbound.append(iid)
                if unbound:
                    return _err(400, "ACTIVE_ITEM_DOCUMENT_BINDING_FAILED",
                                {"unbound_active_item_ids": unbound[:10]})

                excluded_document_ids = list(dict.fromkeys(
                    did for item in server_excluded
                    for did in item_document_ids(item)
                    if did and did not in set(document_ids)
                ))
            except Exception as exc:
                db.rollback()
                return _err(500, "SCOPE_VALIDATION_FAILED", str(exc))
    elif not document_ids:
        return _err(400, "document_ids required")

    binding_map = {
        b.get("document_id"): b for b in requested_bindings
        if isinstance(b, dict) and b.get("document_id")
    }
    authoritative_bindings = []
    verified_candidate_version_ids = {}

    for document_id in document_ids:
        doc = db.query(KBDocument).filter(KBDocument.id == document_id).first()
        if not doc:
            return _err(404, "DOCS_NOT_FOUND", {"document_id": document_id})

        # Fail closed on an explicit integrity preview failure.
        try:
            previews = db.query(KBReviewFixPreview).filter(
                KBReviewFixPreview.document_id == document_id
            ).all()
        except Exception as exc:
            return _err(503, "KB006_INTEGRITY_GATE_UNAVAILABLE", str(exc))
        bad = next((p for p in previews if getattr(p, "integrity_failure", False) is True), None)
        if bad:
            return _err(409, "KB006_INTEGRITY_FAILURE",
                        {"document_id": document_id, "preview_id": bad.id})

        version = doc.version or "1.0"
        content_hash = core.canonical_content_hash(doc.raw_content or "")
        requested = binding_map.get(document_id) or {}

        if requested.get("version") and requested["version"] != version:
            return _err(409, "DOCUMENT_VERSION_DRIFT", {
                "document_id": document_id,
                "expected": requested["version"],
                "actual": version,
            })
        if requested.get("content_hash") and requested["content_hash"] != content_hash:
            known_stale = requested["content_hash"] == (doc.content_hash or "")
            if not known_stale:
                return _err(409, "DOCUMENT_CONTENT_HASH_DRIFT", {
                    "document_id": document_id,
                    "expected": requested["content_hash"],
                    "actual": content_hash,
                })

        if doc.content_hash != content_hash:
            doc.content_hash = content_hash
            if not isinstance(doc.industries, dict):
                doc.industries = {"values": doc.industries if isinstance(doc.industries, list) else []}
            db.add(doc)
            db.commit()

        server_candidate = server_candidate_by_document.get(document_id)
        requested_candidate_id = requested.get("candidate_version_id")
        if requested_candidate_id or server_candidate:
            if not batch_id or not server_candidate:
                return _err(409, "CANDIDATE_NOT_AUTHORIZED_FOR_SCOPE",
                            {"document_id": document_id})
            if (
                not requested_candidate_id
                or requested_candidate_id != server_candidate.get("version_record_id")
            ):
                return _err(409, "CANDIDATE_BINDING_MISMATCH",
                            {"document_id": document_id})

            candidate = db.query(KBDocumentVersion).filter(
                KBDocumentVersion.id == requested_candidate_id
            ).first()
            if not candidate or candidate.document_id != document_id:
                return _err(404, "CANDIDATE_NOT_FOUND", {
                    "document_id": document_id,
                    "candidate_version_id": requested_candidate_id,
                })
            candidate_hash = core.canonical_content_hash(
                candidate.raw_content_snapshot or ""
            )
            if (
                (requested.get("candidate_version") and
                 requested["candidate_version"] != candidate.version)
                or (requested.get("candidate_content_hash") and
                    requested["candidate_content_hash"] != candidate_hash)
                or (server_candidate.get("new_version") and
                    server_candidate["new_version"] != candidate.version)
                or (server_candidate.get("candidate_hash") and
                    server_candidate["candidate_hash"] != candidate_hash)
            ):
                return _err(409, "CANDIDATE_VERSION_OR_HASH_DRIFT", {
                    "document_id": document_id,
                    "candidate_version_id": requested_candidate_id,
                })
            verified_candidate_version_ids[document_id] = candidate.id
            authoritative_bindings.append({
                "document_id": document_id,
                "version": version,
                "content_hash": content_hash,
                "candidate_version_id": candidate.id,
                "candidate_version": candidate.version,
                "candidate_content_hash": candidate_hash,
            })
        else:
            authoritative_bindings.append({
                "document_id": document_id,
                "version": version,
                "content_hash": content_hash,
            })

    existing = core.find_idempotent_operation(db, tenant_id, idempotency_key)
    if existing:
        retryable_terminal = {"failed", "cancelled", "cancellation_failed"}
        active_statuses = {
            "preparing", "staging", "production_writing", "activating", "cancelling"
        }
        now = _now()
        updated = existing.updated_at or existing.updated_date or existing.created_at
        lock_expiry = existing.continuation_lock_expires_at
        # SQLite/legacy rows may return naive datetimes; normalise to UTC before
        # comparing against the tz-aware `now` (fixes TypeError -> HTTP 500).
        if updated is not None and updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        if lock_expiry is not None and lock_expiry.tzinfo is None:
            lock_expiry = lock_expiry.replace(tzinfo=timezone.utc)
        stale_active = (
            existing.status in active_statuses
            and updated is not None
            and (now - updated).total_seconds() > 120
            and (not existing.continuation_lock_owner
                 or not lock_expiry or now >= lock_expiry)
        )
        if stale_active:
            core.set_operation_fields(db, existing.id, {
                "status": "failed",
                "current_step": existing.current_step or existing.status,
                "error_code": "STALE_OPERATION_REPLACED",
                "error_detail": (
                    "A new publish attempt replaced an inactive operation "
                    "with no live continuation worker."
                ),
            })
        elif existing.status not in retryable_terminal:
            return {"operation": _serialize(existing), "idempotent": True}
        idempotency_key = (
            f"{idempotency_key}_retry_{int(_now().timestamp()*1000)}_{_rand(6)}"
        )

    try:
        now = _now()
        operation = KBPublishOperation(
            id=_new_id(),
            tenant_id=tenant_id,
            idempotency_key=idempotency_key,
            document_ids={"ids": document_ids},
            status="preparing",
            current_step="preparing",
            processed_count=0,
            total_count=len(document_ids),
            rollback_status="none",
            previous_active_versions={},
            candidate_version_ids=verified_candidate_version_ids,
            candidate_vector_ids={"ids": []},
            skipped_detection_types={"types": skipped_detection_types},
            detection_summary={
                **detection,
                "active_item_ids": active_item_ids or [],
                "excluded_item_ids": excluded_item_ids or [],
                "batch_id": batch_id,
                "excluded_document_ids": {"ids": excluded_document_ids},
                "normalized_orphan_document_ids": {"ids": normalized_orphan_document_ids},
                "document_bindings": {"items": authoritative_bindings},
            },
            error_code="",
            error_detail="",
            created_by=tenant_id,
            created_at=now,
            updated_at=now,
        )
        db.add(operation)
        db.commit()
        db.refresh(operation)

        core.append_audit(db, {
            "operation_id": operation.id,
            "tenant_id": tenant_id,
            "user_id": tenant_id,
            "event_type": "publish_requested",
            "document_ids": document_ids,
            "idempotency_key": idempotency_key,
            "new_status": "preparing",
            "skipped_detection_types": skipped_detection_types,
            "payload": {
                "detection": detection,
                "normalized_orphan_document_ids": normalized_orphan_document_ids,
                "document_bindings": authoritative_bindings,
            },
        })
        total_detection = detection.get("total_count") or 0
        det_type = (
            "detection_completed"
            if not skipped_detection_types
            else "detection_fully_skipped"
            if len(skipped_detection_types) == total_detection
            else "detection_partially_skipped"
        )
        core.append_audit(db, {
            "operation_id": operation.id,
            "tenant_id": tenant_id,
            "user_id": tenant_id,
            "event_type": det_type,
            "document_ids": document_ids,
            "idempotency_key": idempotency_key,
            "skipped_detection_types": skipped_detection_types,
            "payload": detection,
        })
    except Exception as exc:
        db.rollback()
        return _err(500, "Failed to initialize publish operation", str(exc))

    core._chain(operation.id, "pipeline")
    return {"operation": _serialize(operation), "idempotent": False}

# ══════════════════════════════════════════════════════════════════════════════
# 2. kbPublishContinue
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbPublishContinue", methods=["POST"])
def kb_publish_continue(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    驅動下一個 chunk。後端 self-chain 是主要續跑驅動，本端點是前端 fallback。
    每次最多處理 CHUNK_SIZE(5) 份文件，每份文件後持久化游標 + 心跳。
    伺服器端續跑鎖防止併發 chunk 重複工作。

    回傳 {operation, needs_continuation, already_running?, terminal?, not_continuable?}
    """
    try:
        _, tenant_id = core.resolve_auth(user)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))

    operation_id = payload.get("operation_id")
    if not operation_id:
        return _err(400, "operation_id required")

    op = core.reload_operation(db, operation_id)
    try:
        core.assert_owns_operation(op, user)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))

    if op.status in TERMINAL:
        return {"operation": _serialize(op), "terminal": True, "needs_continuation": False}

    if op.status not in ("production_writing", "activating"):
        return {"operation": _serialize(op), "not_continuable": True,
                "needs_continuation": False}

    audit_ctx = {"user_id": tenant_id}
    owner = f"continue_{tenant_id}_{int(_now().timestamp()*1000)}_{_rand(6)}"

    if op.status == "production_writing":
        result = core.run_production_chunk(db, op, audit_ctx, is_initial=False, owner=owner)
    else:
        result = core.run_activation_chunk(db, op, audit_ctx, is_initial=False, owner=owner)

    if isinstance(result, dict) and result.get("already_running"):
        return {"operation": _serialize(result.get("operation")),
                "already_running": True, "needs_continuation": True}

    fresh = core.reload_operation(db, operation_id)
    needs = False
    if fresh.status == "production_writing":
        needs = (fresh.production_next_index or 0) < (fresh.total_count or 0)
    elif fresh.status == "activating":
        needs = (fresh.activation_next_index or 0) < (fresh.activation_total_count or 0)

    return {"operation": _serialize(fresh), "needs_continuation": needs,
            "terminal": fresh.status in TERMINAL}


# ══════════════════════════════════════════════════════════════════════════════
# 3. kbPublishResume
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbPublishResume", methods=["POST"])
def kb_publish_resume(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    從游標明確恢復卡住的操作。處理 production_writing 與 activating 兩種卡住。
    冪等：
      - 永不重做已完成文件（跳過 already-written / already-activated）
      - 永不建立新 candidate version
      - 永不重做向量寫入或 active 指標切換
      - 若全部激活但 finalize 未完成 → 冪等 finalize

    回傳 {operation, resumed, terminal}
    """
    try:
        _, tenant_id = core.resolve_auth(user)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))

    operation_id = payload.get("operation_id")
    if not operation_id:
        return _err(400, "operation_id required")

    op = core.reload_operation(db, operation_id)
    try:
        core.assert_owns_operation(op, user)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))

    if op.status in TERMINAL:
        return {"operation": _serialize(op), "terminal": True, "resumed": False}
    if op.status not in ("production_writing", "activating"):
        return {"operation": _serialize(op), "not_continuable": True, "resumed": False}

    core.resume_operation(db, op, {"user_id": tenant_id})

    fresh = core.reload_operation(db, operation_id)
    return {"operation": _serialize(fresh),
            "resumed": fresh.status not in TERMINAL,
            "terminal": fresh.status in TERMINAL}


# ══════════════════════════════════════════════════════════════════════════════
# 4. kbPublishCancel
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbPublishCancel", methods=["POST"])
def kb_publish_cancel(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    冪等取消 + 卡死恢復。

    Case A: 在 production_writing / activating 請求取消，但 worker 已過期
            （心跳失效）→ 檢查點永不觸發，必須自行啟動回滾。
    Case B: 已在 cancelling 但回滾卡住（心跳失效 / 未初始化 / 超過整體期限）
            → 重新啟動冪等回滾，從 rollback_next_index 續跑。

    回傳 {operation, already_requested, requested?, terminal?}
    """
    try:
        _, tenant_id = core.resolve_auth(user)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))

    operation_id = payload.get("operation_id")
    if not operation_id:
        return _err(400, "operation_id required")

    op = core.reload_operation(db, operation_id)
    try:
        core.assert_owns_operation(op, user)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))

    # 與 completed 競態：已終態則 cancel 為 no-op
    if op.status in TERMINAL:
        return {"operation": _serialize(op), "already_requested": True, "terminal": True}

    # 冪等取消請求：已請求過則不啟第二個回滾 job
    already_requested = bool(op.cancel_requested_at)
    if not already_requested:
        # ★ fail-closed 審計，在標記 cancel_requested 之前
        core.append_audit(db, {
            "operation_id": op.id, "tenant_id": op.tenant_id, "user_id": tenant_id,
            "event_type": "cancel_requested",
            "document_ids": (op.document_ids or {}).get("ids", []),
            "idempotency_key": op.idempotency_key,
            "previous_status": op.status, "new_status": op.status,
            "payload": {"from_step": op.current_step},
        })
        core.set_operation_fields(db, op.id, {"cancel_requested_at": _now()})

    fresh = core.reload_operation(db, operation_id)
    audit_ctx = {"user_id": tenant_id}

    # ── Case A-1: production_writing 卡死 ──
    if fresh.status == "production_writing":
        hb_stale = core.heartbeat_stale_ms(fresh.production_heartbeat_at) > core.HEARTBEAT_STALE_MS
        never_started = not fresh.production_started_at
        if hb_stale or never_started:
            core._chain(fresh.id, "cancellation")

    # ── Case A-2: activating 卡死 ──
    if fresh.status == "activating":
        a = core.assess_activation_stall(fresh)
        if a["heartbeatStale"] or a["neverStarted"]:
            core._chain(fresh.id, "cancellation")

    # ── Case B: cancelling 但回滾卡住 ──
    if fresh.status == "cancelling":
        doc_ids = (fresh.document_ids or {}).get("ids", [])
        hb_stale = core.heartbeat_stale_ms(fresh.rollback_heartbeat_at) > core.HEARTBEAT_STALE_MS
        never_started = (not fresh.rollback_started_at) or fresh.rollback_status == "none"
        started_ms = core._to_ms(fresh.rollback_started_at)
        whole_deadline = started_ms + core.whole_rollback_deadline_ms(len(doc_ids))
        over_deadline = started_ms > 0 and core._now_ms() > whole_deadline
        if never_started or hb_stale or over_deadline:
            core._chain(fresh.id, "cancellation")

    return {"operation": _serialize(fresh),
            "already_requested": already_requested,
            "requested": not already_requested}


# ══════════════════════════════════════════════════════════════════════════════
# 5. kbPublishGetStatus
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbPublishGetStatus", methods=["POST"])
def kb_publish_get_status(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    查詢狀態，★ 回傳前執行三個 watchdog：
      1. production 卡死判定
      2. activation 卡死判定（含 final-chunk 冪等 finalize）
      3. cancelling 卡死判定

    回傳 {operation}
    """
    try:
        _, tenant_id = core.resolve_auth(user)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))

    operation_id = payload.get("operation_id")
    if not operation_id:
        return _err(400, "operation_id required")

    op = core.reload_operation(db, operation_id)
    try:
        core.assert_owns_operation(op, user)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))

    if op.status not in TERMINAL:
        op = _apply_production_stuck_recovery(db, op)
        op = _apply_activation_stuck_recovery(db, op)
        op = _apply_cancelling_stuck_recovery(db, op)

    return {"operation": _serialize(op)}


def _apply_production_stuck_recovery(db: Session, op):
    if op.status != "production_writing":
        return op
    a = core.assess_production_stall(op)

    if a["overDeadline"]:
        secs = round((core._now_ms() - a["startedMs"]) / 1000)
        core.set_operation_fields(db, op.id, {
            "production_writing_status": "timed_out",
            "production_completed_at": _now(),
            "error_code": "PRODUCTION_TIMEOUT",
            "error_detail": (f"Production writing timed out after {secs}s; "
                             f"wrote {a['nextIndex']}/{a['total']}"),
        })
        try:
            core.append_audit(db, {
                "operation_id": op.id, "tenant_id": op.tenant_id,
                "user_id": op.created_by, "event_type": "publish_failed",
                "document_ids": a["docIds"], "idempotency_key": op.idempotency_key,
                "previous_status": "production_writing", "new_status": "failed",
                "payload": {"watchdog": True, "written": a["nextIndex"],
                            "total": a["total"]},
            })
        except Exception:
            pass
        return core.reload_operation(db, op.id)

    if (a["heartbeatStale"] or a["neverStarted"]) and a["nextIndex"] < a["total"]:
        core.set_operation_fields(db, op.id, {
            "continuation_locked_at": None,
            "continuation_lock_owner": "",
            "continuation_lock_expires_at": None,
            "production_heartbeat_at": _now(),
        })
        core._chain(op.id, "production")
    return op


def _apply_activation_stuck_recovery(db: Session, op):
    if op.status != "activating":
        return op
    a = core.assess_activation_stall(op)

    if a["overDeadline"]:
        core.finalize_activation_timeout(db, op, {"user_id": op.created_by}, a)
        return core.reload_operation(db, op.id)

    # final-chunk bug fix：全部激活但 worker 在最後一份文件後死亡，
    # 未執行 finalizeActivationCompleted → 冪等 finalize
    failed_ids = (op.activation_failed_document_ids or {}).get("ids", [])
    if (a["total"] > 0 and a["nextIndex"] >= a["total"]
            and not failed_ids
            and (a["heartbeatStale"] or not a["lockActive"])):
        core.set_operation_fields(db, op.id, {
            "continuation_locked_at": None,
            "continuation_lock_owner": "",
            "continuation_lock_expires_at": None,
        })
        core.finalize_activation_completed(db, op, {"user_id": op.created_by})
        return core.reload_operation(db, op.id)

    if ((a["heartbeatStale"] or a["neverStarted"])
            and a["nextIndex"] < a["total"] and not a["lockActive"]):
        core.set_operation_fields(db, op.id, {
            "continuation_locked_at": None,
            "continuation_lock_owner": "",
            "continuation_lock_expires_at": None,
        })
        core._chain(op.id, "activation")
    return op


def _apply_cancelling_stuck_recovery(db: Session, op):
    if op.status != "cancelling":
        return op
    doc_ids = (op.document_ids or {}).get("ids", [])
    started_ms = core._to_ms(op.rollback_started_at)
    whole_deadline = started_ms + core.whole_rollback_deadline_ms(len(doc_ids))
    # 注意：cancelling 的心跳門檻是 2 倍（core 原始行為）
    hb_stale = core.heartbeat_stale_ms(op.rollback_heartbeat_at) > core.HEARTBEAT_STALE_MS * 2
    over_deadline = started_ms > 0 and core._now_ms() > whole_deadline
    if not hb_stale and not over_deadline:
        return op

    processed = op.rollback_processed_count or 0
    failed_ids = (op.rollback_failed_document_ids or {}).get("ids", [])
    error_code = "ROLLBACK_TIMEOUT" if over_deadline else "ROLLBACK_HEARTBEAT_STALE"
    if over_deadline:
        secs = round((core._now_ms() - started_ms) / 1000)
        error_detail = (f"Rollback timed out after {secs}s; "
                        f"restored {processed}/{len(doc_ids)}")
    else:
        error_detail = f"Rollback heartbeat stale; restored {processed}/{len(doc_ids)}"

    core.set_operation_fields(db, op.id, {
        "status": "cancellation_failed",
        "rollback_status": "timed_out",
        "rollback_completed_at": _now(),
        "rollback_current_step": "completed",
        "error_code": error_code,
        "error_detail": error_detail,
        "cancelled_at": _now(),
    })
    core.append_audit(db, {
        "operation_id": op.id, "tenant_id": op.tenant_id, "user_id": op.created_by,
        "event_type": "cancellation_failed", "document_ids": doc_ids,
        "idempotency_key": op.idempotency_key,
        "previous_status": "cancelling", "new_status": "cancellation_failed",
        "payload": {"watchdog": True, "restored_count": processed,
                    "total": len(doc_ids), "failed_document_ids": failed_ids},
    })
    return core.reload_operation(db, op.id)


# ══════════════════════════════════════════════════════════════════════════════
# 6. kbPublishRecoverStalled
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbPublishRecoverStalled", methods=["POST"])
def kb_publish_recover_stalled(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Worker 過期未恢復的 watchdog（原始根因：WORKER_EXPIRED_WITHOUT_RESUME）。
    處理 production_writing 與 activating 兩種卡住。

    對每個卡住的操作（心跳失效 > 45s，next_index < total）：
      1. 清除過期續跑鎖
      2. 從游標恢復該步驟（永不重做已完成文件）
      3. 回傳 recovered=true

    若整步動態期限已超過（且心跳失效）→ finalize 為 failed/timed_out，
    並回滾已激活文件（僅 activation）。

    回傳 {operation, recovered?, finalized?, needs_continuation?, terminal?}
    """
    try:
        _, tenant_id = core.resolve_auth(user)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))

    operation_id = payload.get("operation_id")
    if not operation_id:
        return _err(400, "operation_id required")

    op = core.reload_operation(db, operation_id)
    try:
        core.assert_owns_operation(op, user)
    except HTTPException as e:
        return _err(e.status_code, str(e.detail))

    if op.status in TERMINAL:
        return {"operation": _serialize(op), "terminal": True}
    if op.status not in ("production_writing", "activating"):
        return {"operation": _serialize(op), "not_continuable": True}

    audit_ctx = {"user_id": tenant_id}

    # ── production_writing 卡死恢復 ──
    if op.status == "production_writing":
        a = core.assess_production_stall(op)
        if a["overDeadline"]:
            secs = round((core._now_ms() - a["startedMs"]) / 1000)
            core.set_operation_fields(db, op.id, {
                "production_writing_status": "timed_out",
                "production_completed_at": _now(),
                "error_code": "PRODUCTION_TIMEOUT",
                "error_detail": (f"Production writing timed out after {secs}s; "
                                 f"wrote {a['nextIndex']}/{a['total']}"),
            })
            return {"operation": _serialize(core.reload_operation(db, op.id)),
                    "finalized": True}

        if (a["heartbeatStale"] or a["neverStarted"]) and a["nextIndex"] < a["total"]:
            core.set_operation_fields(db, op.id, {
                "continuation_locked_at": None,
                "continuation_lock_owner": "",
                "continuation_lock_expires_at": None,
                "production_heartbeat_at": _now(),
            })
            core._chain(op.id, "production")
            return {"operation": _serialize(core.reload_operation(db, op.id)),
                    "recovered": True, "needs_continuation": True}

        return {"operation": _serialize(op), "recovered": False,
                "needs_continuation": a["nextIndex"] < a["total"]}

    # ── activating 卡死恢復 ──
    a = core.assess_activation_stall(op)
    if a["overDeadline"]:
        core.finalize_activation_timeout(db, op, audit_ctx, a)
        return {"operation": _serialize(core.reload_operation(db, op.id)),
                "finalized": True}

    failed_ids = (op.activation_failed_document_ids or {}).get("ids", [])
    if (a["total"] > 0 and a["nextIndex"] >= a["total"]
            and not failed_ids
            and (a["heartbeatStale"] or not a["lockActive"])):
        core.set_operation_fields(db, op.id, {
            "continuation_locked_at": None,
            "continuation_lock_owner": "",
            "continuation_lock_expires_at": None,
        })
        core.finalize_activation_completed(db, op, audit_ctx)
        return {"operation": _serialize(core.reload_operation(db, op.id)),
                "finalized": True}

    if (a["heartbeatStale"] or a["neverStarted"]) and a["nextIndex"] < a["total"]:
        core.set_operation_fields(db, op.id, {
            "continuation_locked_at": None,
            "continuation_lock_owner": "",
            "continuation_lock_expires_at": None,
        })
        core._chain(op.id, "activation")
        return {"operation": _serialize(core.reload_operation(db, op.id)),
                "recovered": True, "needs_continuation": True}

    return {"operation": _serialize(op), "recovered": False,
            "needs_continuation": a["nextIndex"] < a["total"]}
