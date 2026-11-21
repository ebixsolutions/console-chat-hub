"""
KB Delta Patch — publishOperationCore Python 移植

來源：base44/shared/publishOperationCore.ts（902 行，48,742 bytes）逐行對照移植
套用位置：app/services/publish_operation_core.py

架構說明
────────
production_writing 與 activating 兩個長步驟都是「分塊 + 可續跑 + 游標 + 心跳」
驅動的迴圈。每個 chunk 結束後若仍有文件未處理，由後端自行排下一個 chunk
（Celery self-chain 是主要續跑驅動）；前端輪詢只是顯示與手動恢復的 fallback。

動態整步期限 = max(300s, total × 45s)，存於 step_deadline_at。
它只在心跳「同時」失效時才作為安全上限觸發 —— 心跳新鮮的健康操作永不被它殺掉。

每份文件的操作都是冪等的：已在目標狀態的文件會被跳過（不重複寫向量、
不重複切 active 指標）。finalize 亦冪等：完成最後一份文件會原子地轉入
下一步 / completed，不會重做任何指標切換。

★ 與 Base44 的差異
    Base44 用 Deno `waitUntil` 做背景 self-chain。
    Python 側改用 Celery：`schedule_continuation()` 是唯一注入點。
"""
from __future__ import annotations

import hashlib
import logging
import random
import string
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

logger = logging.getLogger("nexus_kb.publish")

from app.models import (
    KBDocument, KBDocumentVersion, KBImportItem, KBSyncLog,
)
from app.models import (
    KBPublishOperation, KBAuditEvent,
)

from app.services.publish_candidate_adapter import (
    canonical_content_hash,
    operation_binding,
    load_bound_candidate_version,
    ensure_candidate_staging,
    verified_vector_set,
    copy_staging_to_candidate_production,
    activate_candidate,
    restore_previous,
)

# ══════════════════════════════════════════════════════════════════════════════
# 常數 —— 照抄 publishOperationCore.ts，不可調整
# ══════════════════════════════════════════════════════════════════════════════
TERMINAL = {"completed", "cancelled", "cancellation_failed", "failed"}

LEGAL_NEXT = {
    "preparing":          ["staging", "cancelling", "failed"],
    "staging":            ["production_writing", "cancelling", "failed"],
    "production_writing": ["activating", "cancelling", "failed"],
    "activating":         ["completed", "cancelling", "failed"],
    "cancelling":         ["cancelled", "cancellation_failed"],
}

MIN_WHOLE_DEADLINE_MS = 300_000     # 整步期限最低 5 分鐘
PER_DOC_BUDGET_MS     = 45_000      # 每文件預算
HEARTBEAT_STALE_MS    = 45_000      # 心跳失效門檻

CHUNK_SIZE            = 5           # 每 chunk 處理文件數
DOC_TIMEOUT_MS        = 45_000      # 單文件超時
ENTITY_TIMEOUT_MS     = 20_000      # Entity 操作超時
CHUNK_TIMEOUT_MS      = 90_000      # 單 chunk 總超時
CONTINUATION_LOCK_MS  = 90_000      # 續跑鎖有效期

ROLLBACK_CHUNK               = 5
DOC_RESTORE_TIMEOUT_MS       = 15_000
CANDIDATE_CLEANUP_TIMEOUT_MS = 20_000
POINTER_RESTORE_TIMEOUT_MS   = 20_000


# ══════════════════════════════════════════════════════════════════════════════
# 續跑排程注入點 —— 對應 Base44 的 waitUntil
# ══════════════════════════════════════════════════════════════════════════════
_schedule_continuation: Optional[Callable[[str, str], None]] = None


def register_continuation_scheduler(fn: Callable[[str, str], None]) -> None:
    """
    由 app/tasks/publish_tasks.py 在啟動時註冊 Celery 排程器。

    fn(operation_id: str, kind: str) -> None
        kind ∈ {'production', 'activation', 'cancellation'}
    """
    global _schedule_continuation
    _schedule_continuation = fn


def _chain(operation_id: str, kind: str) -> None:
    """後端 self-chain。排程失敗不可拋出 —— 由 watchdog 兜底。"""
    if _schedule_continuation is None:
        logger.warning(
            "[publish._chain] scheduler NOT registered — "
            "operation %s kind=%s will NOT be enqueued. "
            "Ensure 'from app.tasks import publish_tasks' in app/main.py",
            operation_id[:8], kind)
        return
    try:
        _schedule_continuation(operation_id, kind)
        logger.debug("[publish._chain] enqueued op=%s kind=%s",
                     operation_id[:8], kind)
    except Exception:
        logger.exception("[publish._chain] enqueue failed op=%s kind=%s",
                         operation_id[:8], kind)


# ══════════════════════════════════════════════════════════════════════════════
# 工具
# ══════════════════════════════════════════════════════════════════════════════
def http_error(status: int, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail=message)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_ms() -> int:
    return int(_now().timestamp() * 1000)


def _to_ms(dt: Optional[datetime]) -> int:
    if not dt:
        return 0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _rand(n: int = 8) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(n))


def _new_id() -> str:
    return uuid.uuid4().hex


def norm_industries(v: Any) -> dict:
    """
    ★ KBDocument.industries 必須是 dict。每次 update 前必須呼叫。
      dict  → 原樣
      list  → {"values": [...]}
      其他  → {"values": []}
    傳裸 array 會導致 422 ValidationError（Base44 已知歷史 bug）。
    """
    if isinstance(v, dict):
        return v
    if isinstance(v, list):
        return {"values": v}
    return {"values": []}


def compute_step_deadline_ms(total_count: int) -> int:
    """動態整步期限：max(300s, total × 45s)，永不低於 300s。"""
    return max(MIN_WHOLE_DEADLINE_MS, (total_count or 0) * PER_DOC_BUDGET_MS)


def heartbeat_stale_ms(heartbeat_at: Optional[datetime]) -> float:
    """未曾心跳 → 視為已失效（Infinity）。"""
    if not heartbeat_at:
        return float("inf")
    return _now_ms() - _to_ms(heartbeat_at)


def whole_rollback_deadline_ms(doc_count: int) -> int:
    """回滾整體期限：min(300s, max(120s, count × 15s))。"""
    return min(300_000, max(120_000, (doc_count or 0) * 15_000))


class EntityTimeout(Exception):
    def __init__(self, code: str = "ENTITY_TIMEOUT"):
        super().__init__(code)
        self.code = code
        self.timed_out = True


def _elapsed_guard(t0_ms: int, budget_ms: int, code: str) -> None:
    """
    同步版超時守衛。Base44 用 Promise.race，Python 側改為在關鍵點檢查耗時。
    每個 Entity 操作前後呼叫，超過預算即拋出 typed error。
    """
    if _now_ms() - t0_ms > budget_ms:
        raise EntityTimeout(code)


# ══════════════════════════════════════════════════════════════════════════════
# Entity 存取（service role，繞過 tenant 過濾）
# ══════════════════════════════════════════════════════════════════════════════
def _update_doc(db: Session, doc: KBDocument, fields: dict) -> None:
    """★ 內含 norm_industries —— 對應 core 的 updateDoc()"""
    for k, v in fields.items():
        setattr(doc, k, v)
    doc.industries = norm_industries(doc.industries)
    db.add(doc)
    db.flush()


def _fetch_docs(db: Session, ids: list[str]) -> list[KBDocument]:
    """逐筆抓取，保持 ids 順序（core 的 fetchDocs 行為）。"""
    out: list[KBDocument] = []
    for did in ids:
        d = db.query(KBDocument).filter(KBDocument.id == did).first()
        if d:
            out.append(d)
    return out


# DB 中這些欄位是 NUMERIC，SQLAlchemy 讀回是 Decimal；
# 但它們是計數/游標，會被當 list index / slice / range 使用，必須是 int。
# 統一在 reload_operation 這個唯一讀取入口轉成 int，避免各處 TypeError
# （如 "list indices must be integers or slices, not decimal.Decimal"）。
_OPERATION_COUNTER_FIELDS = (
    "processed_count", "total_count",
    "production_next_index",
    "rollback_total_count", "rollback_processed_count", "rollback_next_index",
    "activation_total_count", "activation_processed_count",
    "activation_next_index", "activation_attempt_count",
    "continuation_retry_count",
)


def _normalize_operation_counters(op: KBPublishOperation) -> None:
    for name in _OPERATION_COUNTER_FIELDS:
        value = getattr(op, name)
        if value is not None and not isinstance(value, int):
            setattr(op, name, int(value))


def reload_operation(db: Session, op_id: str) -> Optional[KBPublishOperation]:
    db.expire_all()
    op = db.query(KBPublishOperation).filter(KBPublishOperation.id == op_id).first()
    if op is not None:
        _normalize_operation_counters(op)
    return op


def set_operation_fields(db: Session, op_id: str, fields: dict) -> None:
    op = db.query(KBPublishOperation).filter(KBPublishOperation.id == op_id).first()
    if not op:
        return
    for k, v in fields.items():
        setattr(op, k, v)
    op.updated_at = _now()
    db.add(op)
    db.commit()


# ══════════════════════════════════════════════════════════════════════════════
# 認證 / 擁有權 / 冪等
# ══════════════════════════════════════════════════════════════════════════════
def resolve_auth(user) -> tuple[Any, str]:
    """
    對應 core 的 resolveAuth()。
    Base44 中 tenant_id == user.id，Python 側保持一致以確保資料相容。
    """
    if not user:
        raise http_error(401, "Unauthorized")
    return user, user.id


def assert_owns_operation(operation, user) -> None:
    if not operation:
        raise http_error(404, "Operation not found")
    if operation.tenant_id != user.id:
        raise http_error(403, "Cross-tenant access denied")


def find_idempotent_operation(
    db: Session, tenant_id: str, idempotency_key: str
) -> Optional[KBPublishOperation]:
    op = (
        db.query(KBPublishOperation)
        .filter(
            KBPublishOperation.tenant_id == tenant_id,
            KBPublishOperation.idempotency_key == idempotency_key,
        )
        .first()
    )
    if op is not None:
        _normalize_operation_counters(op)
    return op


# ══════════════════════════════════════════════════════════════════════════════
# 審計 outbox（★ fail-closed）
# ══════════════════════════════════════════════════════════════════════════════
def append_audit(db: Session, evt: dict) -> None:
    """
    ★ 建立失敗必須向上拋出，由呼叫端 fail-closed 阻擋整個請求。
      注意包裝格式：document_ids → {"ids": [...]}
    """
    row = KBAuditEvent(
        id=_new_id(),
        operation_id=evt["operation_id"],
        tenant_id=evt["tenant_id"],
        user_id=evt["user_id"],
        event_type=evt["event_type"],
        document_ids={"ids": evt.get("document_ids") or []},
        document_versions={"items": evt.get("document_versions") or []},
        document_hashes={"hashes": evt.get("document_hashes") or []},
        skipped_detection_types={"types": evt.get("skipped_detection_types") or []},
        idempotency_key=evt.get("idempotency_key") or "",
        previous_status=evt.get("previous_status") or "",
        new_status=evt.get("new_status") or "",
        payload=evt.get("payload") or {},
        created_at=_now(),
    )
    db.add(row)
    db.commit()


def _write_sync_audit(db: Session, global_doc_id: str, doc_id: str, payload: dict) -> None:
    """
    生命週期端點（archive / restore / delete / rollback / reset）用的審計。
    對應 Base44 把 JSON 塞進 KBSyncLog.error_message 的做法 —— 保持一致以便
    既有審計查詢不需改動。
    """
    import json
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


# ══════════════════════════════════════════════════════════════════════════════
# 狀態轉換（★ LEGAL_NEXT 白名單）
# ══════════════════════════════════════════════════════════════════════════════
def _json_safe(v: Any) -> Any:
    """將 datetime / date 轉為 ISO 字串，確保 PostgreSQL JSONB 可序列化。"""
    if isinstance(v, (datetime,)):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _json_safe(v) for k, v in v.items()}
    if isinstance(v, (list, tuple)):
        return [_json_safe(x) for x in v]
    return v


def transition_operation(
    db: Session, op: KBPublishOperation, new_status: str,
    extra_fields: dict, audit_ctx: dict,
) -> KBPublishOperation:
    legal = LEGAL_NEXT.get(op.status, [])
    if new_status not in legal:
        raise http_error(409, f"Illegal transition {op.status} → {new_status}")

    append_audit(db, {
        "operation_id": op.id,
        "tenant_id": op.tenant_id,
        "user_id": audit_ctx.get("user_id"),
        "event_type": "publish_step_changed",
        "document_ids": (op.document_ids or {}).get("ids", []),
        "idempotency_key": op.idempotency_key,
        "previous_status": op.status,
        "new_status": new_status,
        "payload": _json_safe(dict(extra_fields or {})),
    })

    updates = {"status": new_status, "current_step": new_status, **(extra_fields or {})}
    set_operation_fields(db, op.id, updates)
    return reload_operation(db, op.id)


def check_cancel_requested(db: Session, op: KBPublishOperation) -> bool:
    fresh = reload_operation(db, op.id)
    if not fresh:
        return False
    if not fresh.cancel_requested_at:
        return False
    if fresh.status in TERMINAL or fresh.status == "cancelling":
        return False
    return True


# ══════════════════════════════════════════════════════════════════════════════
# 續跑鎖（read-set-verify；Celery self-chain 是主要單工保證）
# ══════════════════════════════════════════════════════════════════════════════
def acquire_continuation_lock(db: Session, op: KBPublishOperation, owner: str) -> bool:
    cur = reload_operation(db, op.id)
    if not cur or cur.status in TERMINAL:
        return False
    now_ms = _now_ms()
    expires_ms = _to_ms(cur.continuation_lock_expires_at)
    held_by_other = (
        cur.continuation_lock_owner
        and cur.continuation_lock_owner != owner
        and now_ms < expires_ms
    )
    if held_by_other:
        return False

    set_operation_fields(db, op.id, {
        "continuation_locked_at": _now(),
        "continuation_lock_owner": owner,
        "continuation_lock_expires_at": _now() + timedelta(milliseconds=CONTINUATION_LOCK_MS),
    })
    after = reload_operation(db, op.id)
    return bool(after and after.continuation_lock_owner == owner)


def release_continuation_lock(db: Session, op: KBPublishOperation, owner: str) -> None:
    cur = reload_operation(db, op.id)
    if cur and cur.continuation_lock_owner == owner:
        set_operation_fields(db, op.id, {
            "continuation_locked_at": None,
            "continuation_lock_owner": "",
            "continuation_lock_expires_at": None,
        })


def still_owns_lock(db: Session, op: KBPublishOperation, owner: str) -> bool:
    cur = reload_operation(db, op.id)
    return bool(cur and cur.continuation_lock_owner == owner)


# ══════════════════════════════════════════════════════════════════════════════
# 主管線
# ══════════════════════════════════════════════════════════════════════════════
def run_pipeline(db: Session, operation: KBPublishOperation):
    """
    Base44 2026-08-24 publish pipeline:
      preparing → real candidate Staging → candidate Production → activation.
    Existing Live content and vectors remain Live/Indexed until activation.
    """
    op = reload_operation(db, operation.id)
    doc_ids = (op.document_ids or {}).get("ids", [])
    audit_ctx = {"user_id": op.created_by}
    op_id = op.id[:8]

    if op.status != "preparing":
        logger.info("[publish.pipeline] skip op=%s status=%s", op_id, op.status)
        return op

    try:
        docs = _fetch_docs(db, doc_ids)
        if len(docs) != len(doc_ids):
            missing = set(doc_ids) - {d.id for d in docs}
            transition_operation(db, op, "failed", {
                "error_code": "DOCS_NOT_FOUND",
                "error_detail": f"Missing documents: {sorted(missing)}",
            }, audit_ctx)
            return reload_operation(db, op.id)

        # Exact rollback snapshot. This is deliberately wider than the old
        # pointer-only snapshot because activation can change content, hash, RAG,
        # counts and published timestamp.
        previous_active = {}
        for d in docs:
            previous_active[d.id] = {
                "version_id": d.active_version_id or None,
                "version": d.version or "1.0",
                "raw_content": d.raw_content or "",
                "content_hash": d.content_hash or canonical_content_hash(d.raw_content or ""),
                "rag_summary": d.rag_summary or "",
                "rag_summary_hash": d.rag_summary_hash or "",
                "chunk_count": int(d.chunk_count or 0),
                "vector_count": int(d.vector_count or 0),
                "published_at": d.published_at.isoformat() if hasattr(d.published_at, "isoformat") else d.published_at,
                "status": d.status,
                "production_vector_status": d.production_vector_status,
                "production_status": d.production_status,
                "staging_vector_status": d.staging_vector_status,
                "available_to_live_console": d.available_to_live_console,
            }

        # Preserve candidate_version_ids pre-seeded and server-verified by
        # kbPublishStart. Do not reset them to {}.
        candidate_version_ids = dict(op.candidate_version_ids or {})
        set_operation_fields(db, op.id, {
            "total_count": len(docs),
            "previous_active_versions": previous_active,
            "candidate_version_ids": candidate_version_ids,
            "candidate_vector_ids": {"ids": []},
        })
        op = reload_operation(db, op.id)

        if check_cancel_requested(db, op):
            return run_cancellation(db, op, audit_ctx)

        op = transition_operation(db, op, "staging", {"processed_count": 0}, audit_ctx)

        for i, d in enumerate(docs):
            if check_cancel_requested(db, op):
                return run_cancellation(db, op, audit_ctx)

            binding = operation_binding(op, d.id)
            cand_vid = candidate_version_ids.get(d.id)
            if cand_vid:
                candidate, _, _ = load_bound_candidate_version(db, d, cand_vid, binding)
            else:
                # Normal publish creates a candidate snapshot of the current doc.
                candidate = KBDocumentVersion(
                    id=_new_id(),
                    document_id=d.id,
                    version=d.version or "1.0",
                    version_type="minor",
                    change_type="content_edit",
                    change_summary="Publish operation candidate",
                    raw_content_snapshot=d.raw_content or "",
                    content_hash=canonical_content_hash(d.raw_content or ""),
                    rag_summary=d.rag_summary or "",
                    rag_summary_hash=d.rag_summary_hash or "",
                    review_status="pending",
                    vector_status="not_generated",
                    created_by="publish_operation",
                )
                db.add(candidate)
                db.commit()
                cand_vid = candidate.id
                candidate_version_ids[d.id] = cand_vid

            currently_live = (
                d.status == "published"
                and d.available_to_live_console is True
                and d.production_vector_status == "indexed"
            )
            if not currently_live:
                d.staging_vector_status = "indexing"
                db.add(d)
                db.commit()

            ensure_candidate_staging(
                db, d, candidate, mutate_doc=not currently_live
            )

            set_operation_fields(db, op.id, {
                "candidate_version_ids": dict(candidate_version_ids),
                "processed_count": i + 1,
            })
            op = reload_operation(db, op.id)

        if check_cancel_requested(db, op):
            return run_cancellation(db, op, audit_ctx)

        now = _now()
        transition_operation(db, op, "production_writing", {
            "processed_count": 0,
            "production_writing_status": "in_progress",
            "production_next_index": 0,
            "production_started_at": now,
            "production_heartbeat_at": now,
            "production_completed_at": None,
            "production_failed_document_ids": {"ids": []},
            "production_errors": {"items": []},
            "step_deadline_at": now + timedelta(
                milliseconds=compute_step_deadline_ms(len(doc_ids))
            ),
        }, audit_ctx)
        op = reload_operation(db, op.id)
        return run_production_chunk(db, op, audit_ctx, is_initial=True)

    except Exception as e:
        logger.exception("[publish.pipeline] FAILED op=%s", op_id)
        db.rollback()
        try:
            set_operation_fields(db, op.id, {
                "status": "failed",
                "current_step": getattr(op, "current_step", None) or "preparing",
                "error_code": getattr(e, "code", None) or "PIPELINE_ERROR",
                "error_detail": str(e),
            })
            append_audit(db, {
                "operation_id": operation.id,
                "tenant_id": operation.tenant_id,
                "user_id": operation.created_by,
                "event_type": "publish_failed",
                "document_ids": doc_ids,
                "idempotency_key": operation.idempotency_key,
                "previous_status": getattr(op, "status", "preparing"),
                "new_status": "failed",
                "payload": {"error": str(e)},
            })
        except Exception:
            db.rollback()
        raise

def write_one_doc_production(db: Session, doc_id: str, cand_vid: Optional[str], op) -> dict:
    t0 = _now_ms()
    d = db.query(KBDocument).filter(KBDocument.id == doc_id).first()
    if not d:
        return {"document_id": doc_id, "written": False,
                "skipped_as_already_written": False,
                "error_code": "DOC_NOT_FOUND", "error_detail": "document missing",
                "duration_ms": _now_ms() - t0}
    if not cand_vid:
        return {"document_id": doc_id, "written": False,
                "skipped_as_already_written": False,
                "error_code": "CANDIDATE_VERSION_REQUIRED",
                "error_detail": "candidate version missing",
                "duration_ms": _now_ms() - t0}

    try:
        binding = operation_binding(op, doc_id)
        candidate, _, _ = load_bound_candidate_version(db, d, cand_vid, binding)

        existing = verified_vector_set(db, doc_id, cand_vid, "production")
        if existing:
            return {"document_id": doc_id, "written": True,
                    "skipped_as_already_written": True,
                    "error_code": "", "error_detail": "",
                    "duration_ms": _now_ms() - t0}

        staging = verified_vector_set(db, doc_id, cand_vid, "staging")
        if not staging:
            return {"document_id": doc_id, "written": False,
                    "skipped_as_already_written": False,
                    "error_code": "STAGING_NOT_READY",
                    "error_detail": "complete real staging vectors are required",
                    "duration_ms": _now_ms() - t0}

        currently_live = (
            d.status == "published"
            and d.available_to_live_console is True
            and d.production_vector_status == "indexed"
        )
        if not currently_live and d.production_vector_status != "indexing":
            d.production_vector_status = "indexing"
            db.add(d)
            db.commit()

        candidate.vector_status = "generating"
        db.add(candidate)
        db.commit()

        production = copy_staging_to_candidate_production(db, d, cand_vid)
        if not production:
            raise RuntimeError("PRODUCTION_COPY_VERIFICATION_FAILED")

        summary = next(
            (r.chunk_text for r in production if r.chunk_type == "rag_summary"), ""
        )
        candidate.vector_status = "generated"
        candidate.rag_summary = summary
        candidate.rag_summary_hash = canonical_content_hash(summary) if summary else ""
        db.add(candidate)

        # A live document must stay fully Live/Indexed until atomic activation.
        if not currently_live:
            d.production_vector_status = "indexed"
            d.production_status = "not_published"
            d.chunk_count = len(production)
            d.vector_count = len(production)
            d.rag_summary = summary
            d.rag_summary_hash = candidate.rag_summary_hash
            db.add(d)
        db.commit()

        return {"document_id": doc_id, "written": True,
                "skipped_as_already_written": False,
                "error_code": "", "error_detail": "",
                "duration_ms": _now_ms() - t0}
    except Exception as e:
        db.rollback()
        return {"document_id": doc_id, "written": False,
                "skipped_as_already_written": False,
                "error_code": getattr(e, "code", "PRODUCTION_WRITE_FAILED"),
                "error_detail": str(e),
                "duration_ms": _now_ms() - t0}

def init_production_fields(doc_ids: list[str]) -> dict:
    now = _now()
    return {
        "production_writing_status": "in_progress",
        "production_next_index": 0,
        "production_started_at": now,
        "production_heartbeat_at": now,
        "production_completed_at": None,
        "production_failed_document_ids": {"ids": []},
        "production_errors": {"items": []},
        "step_deadline_at": now + timedelta(
            milliseconds=compute_step_deadline_ms(len(doc_ids))),
    }


def run_production_chunk(db: Session, op, audit_ctx: dict,
                         is_initial: bool = False, owner: Optional[str] = None):
    cur = reload_operation(db, op.id)
    op_id = op.id[:8]
    if not cur or cur.status in TERMINAL:
        return cur
    if cur.status != "production_writing":
        return cur

    all_doc_ids = (cur.document_ids or {}).get("ids", [])
    cursor = cur.production_next_index or 0
    logger.info("[publish.prod_chunk] START op=%s cursor=%d/%d initial=%s",
                op_id, cursor, len(all_doc_ids), is_initial)

    owner = owner or ("initial_prod" if is_initial else f"prod_{_now_ms()}_{_rand(6)}")

    locked = False
    if not is_initial:
        locked = acquire_continuation_lock(db, cur, owner)
        if not locked:
            return {"operation": cur, "already_running": True}
        cur = reload_operation(db, op.id)

    try:
        all_doc_ids = (cur.document_ids or {}).get("ids", [])
        candidate_version_ids = cur.candidate_version_ids or {}
        candidate_vector_ids = (cur.candidate_vector_ids or {}).get("ids", [])

        # legacy 操作（無 production_started_at）→ 從 processed_count 推導游標
        if not cur.production_started_at:
            legacy = cur.processed_count or 0
            fields = init_production_fields(all_doc_ids)
            fields["production_next_index"] = legacy
            fields["production_heartbeat_at"] = _now()
            set_operation_fields(db, op.id, fields)
            cur = reload_operation(db, op.id)

        if check_cancel_requested(db, cur):
            return run_cancellation(db, cur, audit_ctx)

        chunk_deadline = _now_ms() + CHUNK_TIMEOUT_MS
        cursor = cur.production_next_index or 0
        failed_ids = list((cur.production_failed_document_ids or {}).get("ids", []))
        errors = list((cur.production_errors or {}).get("items", []))
        chunk_processed = 0

        while cursor < len(all_doc_ids) and chunk_processed < CHUNK_SIZE:
            if _now_ms() > chunk_deadline:
                break
            if not is_initial and not still_owns_lock(db, op, owner):
                return reload_operation(db, op.id)
            if check_cancel_requested(db, cur):
                set_operation_fields(db, op.id, {
                    "production_next_index": cursor,
                    "production_heartbeat_at": _now(),
                })
                return run_cancellation(db, cur, audit_ctx)

            doc_id = all_doc_ids[cursor]
            cand_vid = candidate_version_ids.get(doc_id)

            set_operation_fields(db, op.id, {
                "production_heartbeat_at": _now(),
                "production_next_index": cursor,
                "processed_count": cursor,
            })

            t_doc = _now_ms()
            try:
                r = write_one_doc_production(db, doc_id, cand_vid, cur)
                if _now_ms() - t_doc > DOC_TIMEOUT_MS:
                    raise EntityTimeout("PRODUCTION_DOC_TIMEOUT")
            except Exception as e:
                r = {"document_id": doc_id, "written": False,
                     "skipped_as_already_written": False,
                     "error_code": getattr(e, "code", "PRODUCTION_DOC_TIMEOUT"),
                     "error_detail": str(e), "duration_ms": 0}

            if r["written"]:
                if not any(c.get("doc_id") == doc_id for c in candidate_vector_ids):
                    candidate_vector_ids.append(
                        {"doc_id": doc_id, "version_id": cand_vid, "hash": ""})
            else:
                if doc_id not in failed_ids:
                    failed_ids.append(doc_id)
                errors.append({"document_id": doc_id,
                               "error_code": r["error_code"],
                               "error_detail": r["error_detail"]})

            cursor += 1
            chunk_processed += 1

            set_operation_fields(db, op.id, {
                "production_next_index": cursor,
                "production_heartbeat_at": _now(),
                "production_failed_document_ids": {"ids": failed_ids},
                "production_errors": {"items": errors},
                "candidate_vector_ids": {"ids": candidate_vector_ids},
                "processed_count": cursor,
            })
            cur = reload_operation(db, op.id)

        # ── 全部寫完？ ──
        if cursor >= len(all_doc_ids):
            if check_cancel_requested(db, cur):
                return run_cancellation(db, cur, audit_ctx)

            now = _now()
            if failed_ids:
                # production 有失敗 → 直接 fail，不嘗試 activation
                logger.warning(
                    "[publish.prod_chunk] PRODUCTION_INCOMPLETE op=%s "
                    "failed_docs=%d/%d errors=%s",
                    op_id, len(failed_ids), len(all_doc_ids),
                    [e.get("error_code") for e in errors[:5]])
                detail = f"Unwritten documents: {', '.join(failed_ids)}"
                set_operation_fields(db, op.id, {
                    "production_writing_status": "failed",
                    "production_completed_at": now,
                    "error_code": "PRODUCTION_INCOMPLETE",
                    "error_detail": detail,
                })
                failed = reload_operation(db, op.id)
                try:
                    transition_operation(db, failed, "failed", {
                        "error_code": "PRODUCTION_INCOMPLETE",
                        "error_detail": detail,
                    }, audit_ctx)
                except Exception:
                    pass
                append_audit(db, {
                    "operation_id": op.id, "tenant_id": op.tenant_id,
                    "user_id": op.created_by, "event_type": "publish_failed",
                    "document_ids": all_doc_ids,
                    "idempotency_key": op.idempotency_key,
                    "previous_status": "production_writing", "new_status": "failed",
                    "payload": {"failed_document_ids": failed_ids},
                })
                return reload_operation(db, op.id)

            # → 轉入 activating
            logger.info("[publish.prod_chunk] → activating op=%s docs=%d",
                        op_id, len(all_doc_ids))
            extra = {
                "processed_count": 0,
                "production_writing_status": "succeeded",
                "production_completed_at": now,
                **init_activation_fields(all_doc_ids),
                "step_deadline_at": _now() + timedelta(
                    milliseconds=compute_step_deadline_ms(len(all_doc_ids))),
            }
            nxt = transition_operation(db, cur, "activating", extra, audit_ctx)
            return run_activation_chunk(db, nxt, audit_ctx, is_initial=True)

        # ── 尚有文件 → 後端 self-chain ──
        logger.debug("[publish.prod_chunk] self-chain op=%s cursor=%d/%d",
                     op_id, cursor, len(all_doc_ids))
        _chain(op.id, "production")
        return reload_operation(db, op.id)

    finally:
        if locked:
            release_continuation_lock(db, op, owner)


# ══════════════════════════════════════════════════════════════════════════════
# activating
# ══════════════════════════════════════════════════════════════════════════════
def init_activation_fields(doc_ids: list[str]) -> dict:
    now = _now()
    return {
        "activation_status": "in_progress",
        "activation_total_count": len(doc_ids),
        "activation_processed_count": 0,
        "activation_next_index": 0,
        "activation_current_document_id": "",
        "activation_current_substep": "",
        "activation_started_at": now,
        "activation_heartbeat_at": now,
        "activation_completed_at": None,
        "activation_attempt_count": 0,
        "activation_failed_document_ids": {"ids": []},
        "activation_errors": {"items": []},
        "continuation_locked_at": None,
        "continuation_lock_owner": "",
        "continuation_lock_expires_at": None,
        "step_deadline_at": now + timedelta(
            milliseconds=compute_step_deadline_ms(len(doc_ids))),
    }


def activate_one_doc(db: Session, doc_id: str, cand_vid: Optional[str], op) -> dict:
    t0 = _now_ms()
    d = db.query(KBDocument).filter(KBDocument.id == doc_id).first()
    if not d:
        return {"document_id": doc_id, "activated": False,
                "skipped_as_already_activated": False,
                "error_code": "DOC_NOT_FOUND", "error_detail": "document missing",
                "duration_ms": _now_ms() - t0, "substep": "verify_candidate"}
    if not cand_vid:
        return {"document_id": doc_id, "activated": False,
                "skipped_as_already_activated": False,
                "error_code": "CANDIDATE_VERSION_REQUIRED",
                "error_detail": "candidate version missing",
                "duration_ms": _now_ms() - t0, "substep": "verify_candidate"}

    result_summary = op.result_summary or {}
    production = verified_vector_set(db, doc_id, cand_vid, "production")
    already = (
        d.available_to_live_console is True
        and d.status == "published"
        and d.production_vector_status == "indexed"
        and d.production_status == "production"
        and d.active_version_id == cand_vid
        and bool(production)
        and bool(result_summary.get(doc_id))
    )
    if already:
        return {"document_id": doc_id, "activated": False,
                "skipped_as_already_activated": True,
                "error_code": "", "error_detail": "",
                "duration_ms": _now_ms() - t0, "substep": "verify_candidate"}

    substep = "verify_candidate"
    try:
        binding = operation_binding(op, doc_id)
        candidate, _, _ = load_bound_candidate_version(db, d, cand_vid, binding)

        substep = "verify_candidate_vectors"
        production = verified_vector_set(db, doc_id, cand_vid, "production")
        if not production:
            copy_staging_to_candidate_production(db, d, cand_vid)
            production = verified_vector_set(db, doc_id, cand_vid, "production")
        if not production:
            raise RuntimeError("CANDIDATE_VECTOR_SET_MISSING")

        substep = "switch_active_pointer"
        activate_candidate(db, d, candidate, binding)

        substep = "write_audit"
        append_audit(db, {
            "operation_id": op.id,
            "tenant_id": op.tenant_id,
            "user_id": op.created_by,
            "event_type": "publish_completed",
            "document_ids": [doc_id],
            "idempotency_key": op.idempotency_key,
            "previous_status": "activating",
            "new_status": "activating",
            "payload": {"document_id": doc_id, "version_id": cand_vid, "per_doc": True},
        })

        substep = "verify_activation"
        db.expire_all()
        vd = db.query(KBDocument).filter(KBDocument.id == doc_id).first()
        verified = verified_vector_set(db, doc_id, cand_vid, "production")
        candidate_hash = canonical_content_hash(candidate.raw_content_snapshot or "")
        if (
            not vd
            or vd.available_to_live_console is not True
            or vd.status != "published"
            or vd.production_vector_status != "indexed"
            or vd.production_status != "production"
            or vd.active_version_id != cand_vid
            or vd.version != candidate.version
            or canonical_content_hash(vd.raw_content or "") != candidate_hash
            or not verified
            or int(vd.chunk_count or 0) != len(verified)
            or int(vd.vector_count or 0) != len(verified)
        ):
            raise RuntimeError("ACTIVATION_VERIFY_FAILED")

        return {"document_id": doc_id, "activated": True,
                "skipped_as_already_activated": False,
                "error_code": "", "error_detail": "",
                "duration_ms": _now_ms() - t0,
                "substep": "verify_activation", "published_at": _now()}
    except Exception as e:
        db.rollback()
        return {"document_id": doc_id, "activated": False,
                "skipped_as_already_activated": False,
                "error_code": getattr(e, "code", "ACTIVATION_FAILED"),
                "error_detail": str(e),
                "duration_ms": _now_ms() - t0, "substep": substep}

def fail_activation(db: Session, op, audit_ctx: dict, error_code: str,
                    error_detail: str, failed_ids: list, errors: list):
    now = _now()
    timed_out = error_code in ("ACTIVATION_TIMEOUT", "ACTIVATION_DOCUMENT_TIMEOUT")
    set_operation_fields(db, op.id, {
        "activation_status": "timed_out" if timed_out else "failed",
        "activation_completed_at": now,
        "activation_failed_document_ids": {"ids": failed_ids},
        "activation_errors": {"items": errors},
        "error_code": error_code,
        "error_detail": error_detail,
        "activation_current_substep": "",
    })
    fresh = reload_operation(db, op.id)
    return run_cancellation(db, fresh, audit_ctx, failure_mode=True,
                            error_code=error_code, error_detail=error_detail)


def run_activation_chunk(db: Session, op, audit_ctx: dict,
                         is_initial: bool = False, owner: Optional[str] = None):
    cur = reload_operation(db, op.id)
    op_id = op.id[:8]
    if not cur or cur.status in TERMINAL:
        return cur
    if cur.status != "activating":
        return cur

    owner = owner or ("initial_act" if is_initial else f"act_{_now_ms()}_{_rand(6)}")

    locked = False
    if not is_initial:
        locked = acquire_continuation_lock(db, cur, owner)
        if not locked:
            return {"operation": cur, "already_running": True}
        cur = reload_operation(db, op.id)

    try:
        all_doc_ids = (cur.document_ids or {}).get("ids", [])
        candidate_version_ids = cur.candidate_version_ids or {}
        result_summary = dict(cur.result_summary or {})

        # legacy 操作 → 從 processed_count 推導游標
        if not cur.activation_started_at:
            legacy = cur.processed_count or 0
            fields = init_activation_fields(all_doc_ids)
            fields["activation_processed_count"] = legacy
            fields["activation_next_index"] = legacy
            fields["result_summary"] = result_summary
            set_operation_fields(db, op.id, fields)
            cur = reload_operation(db, op.id)

        if check_cancel_requested(db, cur):
            return run_cancellation(db, cur, audit_ctx)

        chunk_deadline = _now_ms() + CHUNK_TIMEOUT_MS
        cursor = cur.activation_next_index or 0
        processed = cur.activation_processed_count or 0
        attempt_count = cur.activation_attempt_count or 0
        failed_ids = list((cur.activation_failed_document_ids or {}).get("ids", []))
        errors = list((cur.activation_errors or {}).get("items", []))
        chunk_processed = 0

        HARD_FAIL = {"ACTIVATION_DOCUMENT_TIMEOUT", "APPROVE_FAILED",
                     "AUDIT_WRITE_FAILED", "ACTIVATION_VERIFY_FAILED"}

        while cursor < len(all_doc_ids) and chunk_processed < CHUNK_SIZE:
            if _now_ms() > chunk_deadline:
                break
            if not is_initial and not still_owns_lock(db, op, owner):
                return reload_operation(db, op.id)
            if check_cancel_requested(db, cur):
                set_operation_fields(db, op.id, {
                    "activation_processed_count": processed,
                    "activation_next_index": cursor,
                })
                return run_cancellation(db, cur, audit_ctx)

            doc_id = all_doc_ids[cursor]
            cand_vid = candidate_version_ids.get(doc_id)

            attempt_count += 1
            set_operation_fields(db, op.id, {
                "activation_heartbeat_at": _now(),
                "activation_current_document_id": doc_id,
                "activation_current_substep": "verify_candidate",
                "activation_attempt_count": attempt_count,
            })

            t_doc = _now_ms()
            try:
                r = activate_one_doc(db, doc_id, cand_vid, cur)
                if _now_ms() - t_doc > DOC_TIMEOUT_MS:
                    raise EntityTimeout("ACTIVATION_DOCUMENT_TIMEOUT")
            except Exception as e:
                r = {"document_id": doc_id, "activated": False,
                     "skipped_as_already_activated": False,
                     "error_code": getattr(e, "code", "ACTIVATION_DOCUMENT_TIMEOUT"),
                     "error_detail": str(e), "duration_ms": 0,
                     "substep": "verify_candidate"}

            if r["activated"] or r["skipped_as_already_activated"]:
                processed += 1
                if r["activated"]:
                    result_summary[doc_id] = {
                        "success": True,
                        "published_at": r.get("published_at").isoformat()
                        if hasattr(r.get("published_at"), "isoformat")
                        else r.get("published_at"),
                        "version_id": cand_vid,
                    }
            else:
                if doc_id not in failed_ids:
                    failed_ids.append(doc_id)
                errors.append({"document_id": doc_id,
                               "error_code": r["error_code"],
                               "error_detail": r["error_detail"],
                               "substep": r.get("substep")})
                if r["error_code"] in HARD_FAIL:
                    set_operation_fields(db, op.id, {
                        "activation_processed_count": processed,
                        "activation_next_index": cursor + 1,
                        "activation_heartbeat_at": _now(),
                        "activation_failed_document_ids": {"ids": failed_ids},
                        "activation_errors": {"items": errors},
                        "result_summary": result_summary,
                        "processed_count": processed,
                    })
                    failed = reload_operation(db, op.id)
                    return fail_activation(
                        db, failed, audit_ctx, r["error_code"],
                        f"Document {doc_id} failed at substep {r.get('substep')}",
                        failed_ids, errors)

            cursor += 1
            chunk_processed += 1

            set_operation_fields(db, op.id, {
                "activation_processed_count": processed,
                "activation_next_index": cursor,
                "activation_heartbeat_at": _now(),
                "activation_current_substep": "verify_activation",
                "activation_failed_document_ids": {"ids": failed_ids},
                "activation_errors": {"items": errors},
                "result_summary": result_summary,
                "processed_count": processed,
            })
            cur = reload_operation(db, op.id)

        # ── 全部激活 → 冪等 finalize ──
        if cursor >= len(all_doc_ids):
            if check_cancel_requested(db, cur):
                return run_cancellation(db, cur, audit_ctx)
            done = len(all_doc_ids) - len(failed_ids)
            logger.info("[publish.activate_chunk] DONE op=%s activated=%d/%d",
                        op_id, done, len(all_doc_ids))
            if failed_ids:
                failed = reload_operation(db, op.id)
                return fail_activation(
                    db, failed, audit_ctx, "ACTIVATION_INCOMPLETE",
                    f"Unactivated documents: {', '.join(failed_ids)}",
                    failed_ids, errors)
            return finalize_activation_completed(db, cur, audit_ctx)

        # ── 尚有文件 → 後端 self-chain ──
        _chain(op.id, "activation")
        return reload_operation(db, op.id)

    finally:
        if locked:
            release_continuation_lock(db, op, owner)


def finalize_activation_completed(db: Session, op, audit_ctx: dict):
    """冪等 finalize：所有文件激活完成時原子轉入 completed。"""
    all_doc_ids = (op.document_ids or {}).get("ids", [])
    op_id = op.id[:8]
    logger.info("[publish.activate_chunk] COMPLETED op=%s docs=%d",
                op_id, len(all_doc_ids))
    result_summary = op.result_summary or {}
    now = _now()
    try:
        completed = transition_operation(db, op, "completed", {
            "completed_at": now,
            "processed_count": len(all_doc_ids),
            "activation_status": "succeeded",
            "activation_completed_at": now,
            "activation_current_document_id": "",
            "activation_current_substep": "finalize_operation",
            "result_summary": result_summary,
        }, audit_ctx)
    except Exception:
        # 轉換非法（併發 finalize）→ 直接寫入作為 fallback
        set_operation_fields(db, op.id, {
            "status": "completed", "current_step": "completed",
            "completed_at": now, "processed_count": len(all_doc_ids),
            "activation_status": "succeeded", "activation_completed_at": now,
            "result_summary": result_summary,
        })
        completed = reload_operation(db, op.id)

    append_audit(db, {
        "operation_id": completed.id, "tenant_id": completed.tenant_id,
        "user_id": completed.created_by, "event_type": "publish_completed",
        "document_ids": all_doc_ids, "idempotency_key": completed.idempotency_key,
        "previous_status": "activating", "new_status": "completed",
        "payload": {"result_summary": result_summary, "batch_complete": True},
    })
    return reload_operation(db, op.id)


# ══════════════════════════════════════════════════════════════════════════════
# 回滾（分塊、冪等）
# ══════════════════════════════════════════════════════════════════════════════
def restore_one_doc(db: Session, doc_id: str, prev: Optional[dict],
                    cand_vid: Optional[str]) -> dict:
    t0 = _now_ms()
    d = db.query(KBDocument).filter(KBDocument.id == doc_id).first()
    if not d:
        return {"document_id": doc_id, "restored": False,
                "skipped_as_already_restored": False,
                "error_code": "DOC_NOT_FOUND", "error_detail": "document missing",
                "duration_ms": _now_ms() - t0}

    prev = prev or {}
    target_vid = prev.get("version_id")
    target_content = prev.get("raw_content", d.raw_content or "")
    target_hash = prev.get("content_hash") or canonical_content_hash(target_content)
    already = (
        d.status == (prev.get("status") or "approved")
        and d.available_to_live_console == (prev.get("available_to_live_console") is True)
        and d.production_vector_status == (prev.get("production_vector_status") or "not_indexed")
        and d.production_status == (prev.get("production_status") or "not_published")
        and d.staging_vector_status == (prev.get("staging_vector_status") or "not_indexed")
        and d.version == (prev.get("version") or d.version or "1.0")
        and (d.raw_content or "") == (target_content or "")
        and (d.active_version_id == target_vid if target_vid else not d.active_version_id)
    )
    try:
        restore_previous(db, d, prev, cand_vid)
        db.expire_all()
        restored = db.query(KBDocument).filter(KBDocument.id == doc_id).first()
        if not restored:
            raise RuntimeError("RESTORE_VERIFY_FAILED")
        if (
            (restored.raw_content or "") != (target_content or "")
            or canonical_content_hash(restored.raw_content or "") != target_hash
            or restored.active_version_id != target_vid
        ):
            raise RuntimeError("RESTORE_VERIFY_FAILED")
        return {"document_id": doc_id, "restored": True,
                "skipped_as_already_restored": already,
                "error_code": "", "error_detail": "",
                "duration_ms": _now_ms() - t0}
    except Exception as e:
        db.rollback()
        return {"document_id": doc_id, "restored": False,
                "skipped_as_already_restored": False,
                "error_code": getattr(e, "code", "RESTORE_FAILED"),
                "error_detail": str(e),
                "duration_ms": _now_ms() - t0}

def init_rollback_fields(doc_ids: list[str]) -> dict:
    now = _now()
    return {
        "rollback_status": "in_progress",
        "rollback_total_count": len(doc_ids),
        "rollback_processed_count": 0,
        "rollback_next_index": 0,
        "rollback_started_at": now,
        "rollback_heartbeat_at": now,
        "rollback_current_step": "restore_document",
        "rollback_current_document_id": "",
        "rollback_failed_document_ids": {"ids": []},
        "rollback_errors": {"items": []},
        "rollback_results": {"items": []},
    }


def run_cancellation(db: Session, op, audit_ctx: dict,
                     failure_mode: bool = False,
                     error_code: Optional[str] = None,
                     error_detail: Optional[str] = None):
    cur = reload_operation(db, op.id)
    if not cur or cur.status in TERMINAL:
        return cur

    all_doc_ids = (cur.document_ids or {}).get("ids", [])
    activation_cursor = cur.activation_next_index or 0
    from_activation = (cur.current_step == "activating") or bool(cur.activation_started_at)
    # 從 activating 取消 → 只回滾已激活的部分
    doc_ids = (all_doc_ids[:activation_cursor]
               if (from_activation and activation_cursor > 0) else all_doc_ids)

    if cur.status != "cancelling":
        try:
            cur = transition_operation(db, cur, "cancelling",
                                       init_rollback_fields(doc_ids), audit_ctx)
        except Exception:
            cur = reload_operation(db, op.id)
            if cur.status in TERMINAL:
                return cur

    if cur.rollback_status == "none" or not cur.rollback_started_at:
        set_operation_fields(db, op.id, init_rollback_fields(doc_ids))
    cur = reload_operation(db, op.id)

    prev_map = cur.previous_active_versions or {}
    candidate_version_ids = cur.candidate_version_ids or {}
    started_ms = _to_ms(cur.rollback_started_at) or _now_ms()
    deadline_ms = started_ms + whole_rollback_deadline_ms(len(doc_ids))

    cursor = cur.rollback_next_index or 0
    processed = cur.rollback_processed_count or 0
    failed_ids = list((cur.rollback_failed_document_ids or {}).get("ids", []))
    errors = list((cur.rollback_errors or {}).get("items", []))
    results = list((cur.rollback_results or {}).get("items", []))
    chunk_processed = 0
    timed_out = False

    while cursor < len(doc_ids):
        if _now_ms() > deadline_ms:
            timed_out = True
            break

        doc_id = doc_ids[cursor]
        cand_vid = candidate_version_ids.get(doc_id)

        set_operation_fields(db, op.id, {
            "rollback_heartbeat_at": _now(),
            "rollback_current_document_id": doc_id,
            "rollback_current_step": "restore_document",
        })

        r = restore_one_doc(db, doc_id, prev_map.get(doc_id), cand_vid)
        results.append(r)
        if r["restored"]:
            processed += 1
        else:
            if doc_id not in failed_ids:
                failed_ids.append(doc_id)
            errors.append({"document_id": doc_id,
                           "error_code": r["error_code"],
                           "error_detail": r["error_detail"]})

        cursor += 1
        chunk_processed += 1

        set_operation_fields(db, op.id, {
            "rollback_processed_count": processed,
            "rollback_next_index": cursor,
            "rollback_heartbeat_at": _now(),
            "rollback_failed_document_ids": {"ids": failed_ids},
            "rollback_errors": {"items": errors},
            "rollback_results": {"items": results},
        })

        if chunk_processed >= ROLLBACK_CHUNK and cursor < len(doc_ids):
            _chain(op.id, "cancellation")
            return reload_operation(db, op.id)

    if not timed_out and _now_ms() > deadline_ms and cursor < len(doc_ids):
        timed_out = True

    has_failures = bool(failed_ids)
    if failure_mode:
        final_status = "failed"
    elif has_failures or timed_out:
        final_status = "cancellation_failed"
    else:
        final_status = "cancelled"

    rollback_status = ("timed_out" if timed_out
                       else ("failed" if has_failures else "succeeded"))

    if failure_mode:
        f_code = error_code or "ACTIVATION_FAILURE"
        f_detail = error_detail or "Activation failed; rolled back activated documents"
    elif timed_out:
        secs = round((_now_ms() - started_ms) / 1000)
        f_code = "ROLLBACK_TIMEOUT"
        f_detail = (f"Rollback timed out after {secs}s; "
                    f"restored {processed}/{len(doc_ids)}")
    elif has_failures:
        f_code = "ROLLBACK_INCOMPLETE"
        f_detail = f"Unrestored documents: {', '.join(failed_ids)}"
    else:
        f_code = ""
        f_detail = ""

    now = _now()
    final_fields = {
        "rollback_status": rollback_status,
        "rollback_completed_at": now,
        "rollback_current_step": "completed",
        "rollback_current_document_id": "",
        "error_code": f_code,
        "error_detail": f_detail,
        "cancelled_at": now,
    }
    try:
        finalized = transition_operation(db, cur, final_status, final_fields, audit_ctx)
    except Exception:
        set_operation_fields(db, op.id, {"status": final_status, **final_fields})
        finalized = reload_operation(db, op.id)

    if failure_mode:
        audit_event = "publish_failed"
    elif final_status == "cancelled":
        audit_event = "publish_cancelled"
    else:
        audit_event = "cancellation_failed"

    append_audit(db, {
        "operation_id": finalized.id, "tenant_id": finalized.tenant_id,
        "user_id": finalized.created_by, "event_type": audit_event,
        "document_ids": doc_ids, "idempotency_key": finalized.idempotency_key,
        "previous_status": "cancelling", "new_status": final_status,
        "payload": {"rollback_status": rollback_status,
                    "restored_count": processed, "total": len(doc_ids),
                    "failed_document_ids": failed_ids, "timed_out": timed_out},
    })
    return reload_operation(db, op.id)


# ══════════════════════════════════════════════════════════════════════════════
# 停滯判定（watchdog）
# ══════════════════════════════════════════════════════════════════════════════
def assess_activation_stall(op) -> dict:
    doc_ids = (op.document_ids or {}).get("ids", [])
    now_ms = _now_ms()
    hb_ms = _to_ms(op.activation_heartbeat_at)
    started_ms = _to_ms(op.activation_started_at)
    next_index = op.activation_next_index or 0
    total = op.activation_total_count or len(doc_ids)

    heartbeat_stale = hb_ms > 0 and (now_ms - hb_ms) > HEARTBEAT_STALE_MS
    never_started = (not op.activation_started_at) or op.activation_status == "none"
    deadline_ms = (_to_ms(op.step_deadline_at)
                   or (started_ms + compute_step_deadline_ms(total)))
    # ★ INV-8：整步期限只在心跳「同時」失效時才觸發
    over_deadline = heartbeat_stale and now_ms > deadline_ms

    lock_expires = _to_ms(op.continuation_lock_expires_at)
    lock_active = bool(op.continuation_lock_owner) and now_ms < lock_expires

    return {"docIds": doc_ids, "now": now_ms, "startedMs": started_ms,
            "nextIndex": next_index, "total": total,
            "heartbeatStale": heartbeat_stale, "neverStarted": never_started,
            "overDeadline": over_deadline, "lockActive": lock_active}


def assess_production_stall(op) -> dict:
    doc_ids = (op.document_ids or {}).get("ids", [])
    now_ms = _now_ms()
    hb_ms = _to_ms(op.production_heartbeat_at)
    started_ms = _to_ms(op.production_started_at)
    next_index = op.production_next_index or 0
    total = len(doc_ids)

    heartbeat_stale = hb_ms > 0 and (now_ms - hb_ms) > HEARTBEAT_STALE_MS
    never_started = (not op.production_started_at) or op.production_writing_status == "none"
    deadline_ms = (_to_ms(op.step_deadline_at)
                   or (started_ms + compute_step_deadline_ms(total)))
    over_deadline = heartbeat_stale and now_ms > deadline_ms

    return {"docIds": doc_ids, "now": now_ms, "startedMs": started_ms,
            "nextIndex": next_index, "total": total,
            "heartbeatStale": heartbeat_stale, "neverStarted": never_started,
            "overDeadline": over_deadline}


def finalize_activation_timeout(db: Session, op, audit_ctx: dict, assessment: dict):
    started_ms = assessment["startedMs"]
    next_index = assessment["nextIndex"]
    total = assessment["total"]
    secs = round((_now_ms() - started_ms) / 1000)
    failed_ids = (op.activation_failed_document_ids or {}).get("ids", [])
    errors = (op.activation_errors or {}).get("items", [])

    set_operation_fields(db, op.id, {
        "continuation_locked_at": None,
        "continuation_lock_owner": "",
        "continuation_lock_expires_at": None,
        "activation_status": "timed_out",
        "activation_completed_at": _now(),
        "error_code": "ACTIVATION_TIMEOUT",
        "error_detail": (f"Activation timed out after {secs}s; "
                         f"activated {next_index}/{total}"),
        "activation_failed_document_ids": {"ids": failed_ids},
        "activation_errors": {"items": errors},
    })
    fresh = reload_operation(db, op.id)
    return run_cancellation(db, fresh, audit_ctx, failure_mode=True,
                            error_code="ACTIVATION_TIMEOUT",
                            error_detail=f"Activation timed out after {secs}s")


# ══════════════════════════════════════════════════════════════════════════════
# resumeOperation —— 從游標恢復任何卡住的步驟
# ══════════════════════════════════════════════════════════════════════════════
def resume_operation(db: Session, op, audit_ctx: dict):
    cur = reload_operation(db, op.id)
    if not cur or cur.status in TERMINAL:
        return cur
    if cur.status == "cancelling":
        return run_cancellation(db, cur, audit_ctx)

    if cur.status == "production_writing":
        a = assess_production_stall(cur)
        if a["overDeadline"]:
            secs = round((_now_ms() - a["startedMs"]) / 1000)
            set_operation_fields(db, op.id, {
                "production_writing_status": "timed_out",
                "production_completed_at": _now(),
                "error_code": "PRODUCTION_TIMEOUT",
                "error_detail": (f"Production writing timed out after {secs}s; "
                                 f"wrote {a['nextIndex']}/{a['total']}"),
            })
            failed = reload_operation(db, op.id)
            try:
                transition_operation(db, failed, "failed", {
                    "error_code": "PRODUCTION_TIMEOUT",
                    "error_detail": "Production writing timed out",
                }, audit_ctx)
            except Exception:
                pass
            return reload_operation(db, op.id)

        # 清除過期鎖 + 從游標續跑
        set_operation_fields(db, op.id, {
            "continuation_locked_at": None,
            "continuation_lock_owner": "",
            "continuation_lock_expires_at": None,
            "production_heartbeat_at": _now(),
        })
        _chain(op.id, "production")
        return reload_operation(db, op.id)

    if cur.status == "activating":
        a = assess_activation_stall(cur)
        if a["overDeadline"]:
            return finalize_activation_timeout(db, cur, audit_ctx, a)

        # 全部激活但未 finalize → 冪等 finalize
        all_doc_ids = (cur.document_ids or {}).get("ids", [])
        failed_ids = (cur.activation_failed_document_ids or {}).get("ids", [])
        if (cur.activation_next_index or 0) >= len(all_doc_ids) and not failed_ids:
            return finalize_activation_completed(db, cur, audit_ctx)

        set_operation_fields(db, op.id, {
            "continuation_locked_at": None,
            "continuation_lock_owner": "",
            "continuation_lock_expires_at": None,
            "activation_heartbeat_at": _now(),
        })
        _chain(op.id, "activation")
        return reload_operation(db, op.id)

    return cur
