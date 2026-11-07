"""
Import 相關 Celery 任務

generate_embeddings_task   批量產生向量（大量文件走背景）
extract_batch_task         連續跑 kbExtractStep 直到 remaining=0（可選）
"""
from __future__ import annotations
import logging

from app.core.database import SessionLocal
from app.core import llm as llm_mod
from app.core.config import settings
from app.worker import celery_app
from app.models import KBVectorChunk, KBImportBatch, KBImportItem
from app.services import import_pipeline as pipe
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def _now():
    return datetime.now(timezone.utc)


@celery_app.task(name="kb.generate_embeddings", bind=True, max_retries=0)
def generate_embeddings_task(self, document_id=None, limit=500, reprocess=False):
    db = SessionLocal()
    done = failed = 0
    try:
        if reprocess:
            # 重建：不限 status，重建所有 production chunk（統一換新 embedding 模型）
            q = db.query(KBVectorChunk).filter(
                KBVectorChunk.environment == "production")
        else:
            q = db.query(KBVectorChunk).filter(
                KBVectorChunk.embedding_status.in_(["pending", None]))
        if document_id:
            q = q.filter(KBVectorChunk.document_id == document_id)
        chunks = q.limit(limit).all()
        for c in chunks:
            try:
                c.embedding_status = "generating"
                db.add(c); db.commit()
                vec = llm_mod.generate_embedding(c.chunk_text or "")
                c.embedding_vector = vec
                c.embedding_dimensions = len(vec)
                c.embedding_model = settings.embedding_model
                c.embedding_status = "generated"
                c.vector_store = "local_embedding"
                c.embedded_at = _now()
                db.add(c); db.commit()
                done += 1
            except Exception as e:
                db.rollback()
                c.embedding_status = "failed"
                c.embedding_error = str(e)[:500]
                db.add(c); db.commit()
                failed += 1
        return {"ok": True, "embedded": done, "failed": failed}
    except Exception as e:
        logger.exception("generate_embeddings_task failed")
        return {"ok": False, "error": str(e), "embedded": done, "failed": failed}
    finally:
        db.close()


@celery_app.task(name="kb.classify_batch_industry", bind=True, max_retries=0)
def classify_batch_industry_task(self, batch_id: str):
    """背景 AI 行業分類：逐條覆寫 skeleton items 的 industry/sub_industries。

    kbImportStart 只做規則匹配（快速、不阻塞），真正的 AI 分類由本任務
    在 Celery worker 中異步完成，避免 import API 504 超時。
    """
    db = SessionLocal()
    done = failed = skipped = 0
    try:
        batch = db.query(KBImportBatch).filter(
            KBImportBatch.id == batch_id).first()
        # 自動新增分類時記錄操作者（來源=llm_auto）
        created_by = getattr(batch, "created_by", None) if batch else None
        items = (db.query(KBImportItem)
                 .filter(KBImportItem.batch_id == batch_id)
                 .order_by(KBImportItem.item_index.asc())
                 .all())
        for it in items:
            sm = it.source_metadata or {}
            title = it.extracted_title or ""
            content = ((it.original_content or "") + "\n"
                       + (sm.get("raw_block_content") or ""))
            try:
                industry, industries, sub_industries = pipe._classify_industry_ai(
                    db, title, content, created_by=created_by)
                # ★ LLM 未註冊 / 呼叫失敗 / 未識別出分類時回空：
                #   保留同步階段（規則匹配）已落地的值，絕不以空值覆寫。
                if not industry:
                    skipped += 1
                    continue
                it.industry = industry
                it.industries = industries
                it.sub_industries = sub_industries
                db.add(it)
                db.commit()
                done += 1
            except Exception:
                db.rollback()
                failed += 1
        return {"ok": True, "classified": done, "skipped": skipped,
                "failed": failed}
    except Exception as e:
        logger.exception("classify_batch_industry_task failed")
        return {"ok": False, "error": str(e), "classified": done, "failed": failed}
    finally:
        db.close()


@celery_app.task(name="kb.extract_batch", bind=True, max_retries=0)
def extract_batch_task(self, batch_id: str, max_steps: int = 500):
    """連續執行 extract_one_item 直到無 enumerated item。"""
    db = SessionLocal()
    processed = 0
    try:
        for _ in range(max_steps):
            batch = db.query(KBImportBatch).filter(
                KBImportBatch.id == batch_id).first()
            if not batch or batch.extraction_phase != "extracting":
                break
            from app.models import KBImportItem
            items = (db.query(KBImportItem)
                     .filter(KBImportItem.batch_id == batch_id)
                     .order_by(KBImportItem.item_index.asc()).all())
            target = pipe.pick_next_item(items)
            if not target:
                break
            target.status = "extracting"
            db.add(target); db.commit()
            try:
                pipe.extract_one_item(db, target, batch)
                processed += 1
            except Exception:
                db.rollback()
                target.status = "failed"
                db.add(target); db.commit()
        return {"ok": True, "processed": processed}
    except Exception as e:
        logger.exception("extract_batch_task failed")
        return {"ok": False, "error": str(e), "processed": processed}
    finally:
        db.close()
