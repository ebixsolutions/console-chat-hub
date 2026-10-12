"""
KB Delta Patch — Celery 背景任務（取代 Base44 的 Deno waitUntil）

套用位置：app/tasks/publish_tasks.py

啟動時註冊（app/main.py 或 app/worker.py 頂部）：
    import app.tasks.publish_tasks     # noqa: F401  ← import 即完成註冊

celerybeat 排程（app/worker.py）：
    celery_app.conf.beat_schedule = {
        **celery_app.conf.beat_schedule,
        "kb-publish-watchdog": {
            "task": "kb.publish_watchdog",
            "schedule": 30.0,           # 每 30 秒
        },
    }

★ 為什麼必須用 Celery 而不是 FastAPI BackgroundTasks
    publishOperationCore 依賴：
      - 跨請求的 chunk self-chain
      - 心跳 + 續跑鎖
      - worker 重啟後從游標恢復
    BackgroundTasks 在進程內執行，重啟即丟失操作 → 7/7 全失敗會重現。
"""
from __future__ import annotations

import logging

from app.core.database import SessionLocal
from app.services import publish_operation_core as core
from app.worker import celery_app          # 既有 Celery app

logger = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════════════════════
# 續跑排程器 —— 注入 core
# ══════════════════════════════════════════════════════════════════════════════
def _schedule(operation_id: str, kind: str) -> None:
    """
    kind ∈ {'pipeline', 'production', 'activation', 'cancellation'}
    countdown=1 避免同一秒內的競態。
    """
    run_publish_step.apply_async(args=[operation_id, kind], countdown=1)


core.register_continuation_scheduler(_schedule)


# ══════════════════════════════════════════════════════════════════════════════
# 主任務
# ══════════════════════════════════════════════════════════════════════════════
@celery_app.task(name="kb.run_publish_step", bind=True, max_retries=0)
def run_publish_step(self, operation_id: str, kind: str = "pipeline"):
    """
    執行一個 publish 步驟 / chunk。
    core 內部會在需要時再次呼叫 _schedule() 形成 self-chain。

    max_retries=0：失敗不由 Celery 自動重試，交給 watchdog 判定後恢復
                   （避免重試與 watchdog 雙重觸發造成重複工作）。
    """
    db = SessionLocal()
    op_id = operation_id[:8]
    logger.info("[publish.task] DISPATCH op=%s kind=%s", op_id, kind)
    try:
        op = core.reload_operation(db, operation_id)
        if not op:
            logger.warning("[publish] operation %s not found", operation_id)
            return {"ok": False, "reason": "not_found"}
        if op.status in core.TERMINAL:
            return {"ok": True, "terminal": True, "status": op.status}

        audit_ctx = {"user_id": op.created_by}
        owner = f"celery_{kind}_{self.request.id or ''}"

        if kind == "pipeline":
            core.run_pipeline(db, op)

        elif kind == "production":
            if op.status == "production_writing":
                core.run_production_chunk(db, op, audit_ctx,
                                          is_initial=False, owner=owner)

        elif kind == "activation":
            if op.status == "activating":
                core.run_activation_chunk(db, op, audit_ctx,
                                          is_initial=False, owner=owner)

        elif kind == "cancellation":
            core.run_cancellation(db, op, audit_ctx)

        else:
            logger.warning("[publish] unknown kind=%s", kind)
            return {"ok": False, "reason": "unknown_kind"}

        fresh = core.reload_operation(db, operation_id)
        return {"ok": True, "status": fresh.status if fresh else None}

    except Exception as e:
        logger.exception("[publish] run_publish_step failed op=%s kind=%s",
                         operation_id, kind)
        # 不重試 —— 讓 watchdog 依心跳判定後恢復
        return {"ok": False, "error": str(e)}
    finally:
        db.close()


# ══════════════════════════════════════════════════════════════════════════════
# Watchdog —— celerybeat 每 30 秒
# ══════════════════════════════════════════════════════════════════════════════
@celery_app.task(name="kb.publish_watchdog")
def publish_watchdog():
    """
    掃描心跳失效的操作並觸發續跑 / finalize。

    ★ INV-8：只有「整步期限過期 AND 心跳失效」同時成立才判定卡死。
      心跳新鮮的健康長任務永不被殺。
    """
    from app.models import KBPublishOperation

    db = SessionLocal()
    triggered = {"pipeline": 0, "production": 0, "activation": 0,
                 "cancellation": 0, "finalized": 0}
    try:
        ops = (
            db.query(KBPublishOperation)
            .filter(KBPublishOperation.status.in_(
                ["preparing", "production_writing", "activating", "cancelling"]))
            .all()
        )

        for op in ops:
            audit_ctx = {"user_id": op.created_by}

            # ── preparing：pipeline 任務遺失/未排程 → 重新排程 ──
            #   正常流程 kbPublishStart 已排程 pipeline（countdown=1），
            #   若 API 進程未註冊排程器或 broker/worker 暫不可用，操作會卡在
            #   preparing。超過門檻即重新排程，run_pipeline 有 status 守衛，重複安全。
            if op.status == "preparing":
                stale_secs = (core._now_ms() - core._to_ms(op.updated_at)) / 1000
                if stale_secs > 90:
                    _schedule(op.id, "pipeline")
                    triggered["pipeline"] += 1
                continue

            # ── production_writing ──
            if op.status == "production_writing":
                a = core.assess_production_stall(op)
                if a["overDeadline"]:
                    secs = round((core._now_ms() - a["startedMs"]) / 1000)
                    core.set_operation_fields(db, op.id, {
                        "production_writing_status": "timed_out",
                        "production_completed_at": core._now(),
                        "error_code": "PRODUCTION_TIMEOUT",
                        "error_detail": (f"Production writing timed out after {secs}s; "
                                         f"wrote {a['nextIndex']}/{a['total']}"),
                    })
                    failed = core.reload_operation(db, op.id)
                    try:
                        core.transition_operation(db, failed, "failed", {
                            "error_code": "PRODUCTION_TIMEOUT",
                            "error_detail": "Production writing timed out",
                        }, audit_ctx)
                    except Exception:
                        pass
                    triggered["finalized"] += 1
                    continue

                if ((a["heartbeatStale"] or a["neverStarted"])
                        and a["nextIndex"] < a["total"]):
                    core.set_operation_fields(db, op.id, {
                        "continuation_locked_at": None,
                        "continuation_lock_owner": "",
                        "continuation_lock_expires_at": None,
                        "production_heartbeat_at": core._now(),
                    })
                    _schedule(op.id, "production")
                    triggered["production"] += 1
                continue

            # ── activating ──
            if op.status == "activating":
                a = core.assess_activation_stall(op)
                if a["overDeadline"]:
                    core.finalize_activation_timeout(db, op, audit_ctx, a)
                    triggered["finalized"] += 1
                    continue

                failed_ids = (op.activation_failed_document_ids or {}).get("ids", [])
                # final-chunk：全部激活但 finalize 未執行 → 冪等 finalize
                if (a["total"] > 0 and a["nextIndex"] >= a["total"]
                        and not failed_ids
                        and (a["heartbeatStale"] or not a["lockActive"])):
                    core.set_operation_fields(db, op.id, {
                        "continuation_locked_at": None,
                        "continuation_lock_owner": "",
                        "continuation_lock_expires_at": None,
                    })
                    core.finalize_activation_completed(db, op, audit_ctx)
                    triggered["finalized"] += 1
                    continue

                if ((a["heartbeatStale"] or a["neverStarted"])
                        and a["nextIndex"] < a["total"] and not a["lockActive"]):
                    core.set_operation_fields(db, op.id, {
                        "continuation_locked_at": None,
                        "continuation_lock_owner": "",
                        "continuation_lock_expires_at": None,
                    })
                    _schedule(op.id, "activation")
                    triggered["activation"] += 1
                continue

            # ── cancelling ──
            if op.status == "cancelling":
                doc_ids = (op.document_ids or {}).get("ids", [])
                started_ms = core._to_ms(op.rollback_started_at)
                whole_deadline = started_ms + core.whole_rollback_deadline_ms(len(doc_ids))
                # cancelling 心跳門檻為 2 倍（core 原始行為）
                hb_stale = (core.heartbeat_stale_ms(op.rollback_heartbeat_at)
                            > core.HEARTBEAT_STALE_MS * 2)
                never_started = (not op.rollback_started_at
                                 or op.rollback_status == "none")
                over_deadline = started_ms > 0 and core._now_ms() > whole_deadline

                if over_deadline or hb_stale:
                    processed = op.rollback_processed_count or 0
                    failed_ids = (op.rollback_failed_document_ids or {}).get("ids", [])
                    error_code = ("ROLLBACK_TIMEOUT" if over_deadline
                                  else "ROLLBACK_HEARTBEAT_STALE")
                    if over_deadline:
                        secs = round((core._now_ms() - started_ms) / 1000)
                        detail = (f"Rollback timed out after {secs}s; "
                                  f"restored {processed}/{len(doc_ids)}")
                    else:
                        detail = (f"Rollback heartbeat stale; "
                                  f"restored {processed}/{len(doc_ids)}")
                    core.set_operation_fields(db, op.id, {
                        "status": "cancellation_failed",
                        "rollback_status": "timed_out",
                        "rollback_completed_at": core._now(),
                        "rollback_current_step": "completed",
                        "error_code": error_code,
                        "error_detail": detail,
                        "cancelled_at": core._now(),
                    })
                    try:
                        core.append_audit(db, {
                            "operation_id": op.id, "tenant_id": op.tenant_id,
                            "user_id": op.created_by,
                            "event_type": "cancellation_failed",
                            "document_ids": doc_ids,
                            "idempotency_key": op.idempotency_key,
                            "previous_status": "cancelling",
                            "new_status": "cancellation_failed",
                            "payload": {"watchdog": True,
                                        "restored_count": processed,
                                        "total": len(doc_ids),
                                        "failed_document_ids": failed_ids},
                        })
                    except Exception:
                        pass
                    triggered["finalized"] += 1
                elif never_started:
                    _schedule(op.id, "cancellation")
                    triggered["cancellation"] += 1

        if any(triggered.values()):
            logger.info("[publish_watchdog] triggered=%s", triggered)
        return triggered

    except Exception:
        logger.exception("[publish_watchdog] failed")
        return triggered
    finally:
        db.close()
