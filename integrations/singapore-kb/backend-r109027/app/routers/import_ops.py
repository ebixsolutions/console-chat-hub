"""
KB Delta Patch v1.2 — 4 個 Import Pipeline 端點

套用位置：app/routers/import_ops.py
來源：nexus-kb-import-pipeline-replacement（2026-07-31）逐行移植

註冊方式（app/main.py 末尾）：
    from app.routers.import_ops import router as import_ops_router
    app.include_router(import_ops_router)

★ 這 4 個端點取代 OLD 後端既有的同名實作。
  舊實作沒有 structured_items 路徑，也沒有 raw_block_content 邊界安全提取。

對外路徑：/api/functions/{name}

呼叫順序：
    kbImportBatchCreate  →  kbImportStart  →  kbExtractStep × N  →  kbImportFinalize
                                              （迴圈直到 remaining=0）
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.models import KBImportBatch, KBImportItem
from app.services import import_pipeline as pipe
from app.services.industry_groups import label_for_subcategory

router = APIRouter(prefix="/api/functions", tags=["kb-import"])
app_router = APIRouter(
    prefix=f"/api/apps/{settings.app_id}/functions", tags=["kb-import"]
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


def _new_id() -> str:
    return uuid.uuid4().hex


def _err(status: int, error: str, detail: Any = None) -> JSONResponse:
    body: dict = {"error": error}
    if detail is not None:
        body["detail"] = detail
    return JSONResponse(status_code=status, content=body)


def _is_valid_xlsx_block(raw_block_content: str) -> bool:
    """
    xlsx 的 structured_items.raw_block_content 應包含實際記錄資料，
    而非僅有工作表名稱/章節標題。過濾條件：
      1. 非空白
      2. 除工作表標題行（「工作表：xxx」/「Sheet xxx」）外，
         需至少 2 行真實欄位資料
      3. 若存在 ID 行，其值必須為數字
         （過濾「ID: 記錄：4」這類無效佔位）
    """
    if not raw_block_content or not raw_block_content.strip():
        return False

    lines = [ln.strip() for ln in raw_block_content.strip().split("\n") if ln.strip()]
    if not lines:
        return False

    data_lines = [
        ln for ln in lines
        if not (ln.startswith("工作表") or ln.startswith("Sheet"))
    ]
    # 至少 2 行真實欄位資料（純工作表標題 / 只有一行殘缺資料 → 無效）
    if len(data_lines) < 2:
        return False

    # ID 行值必須是數字（「ID: 記錄：4」→ 值「記錄：4」不是數字 → 無效）
    for ln in data_lines:
        m = re.match(r"^ID\s*[:：]\s*(.*)$", ln)
        if m:
            value = m.group(1).strip()
            if not re.fullmatch(r"\d+", value):
                return False

    return True


# ══════════════════════════════════════════════════════════════════════════════
# 1. kbImportBatchCreate — 輕量：只建 batch，立即回 batchId
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbImportBatchCreate", methods=["POST"])
def kb_import_batch_create(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    在 kbImportStart 之前呼叫，取得穩定 batchId 供前端輪詢。

    輸入 {batch_meta, raw_content}
    回傳 ★ 完整物件（缺 batch 子物件前端進度條會壞）：
        {success, id, batchId, batch_id,
         batch: {batch_name, source_file_name, source_file_type, chunks,
                 extraction_phase, partial, source_encoding, total_items}}
    """
    created_by = getattr(user, "id", None) or "system"

    batch_meta = payload.get("batch_meta")
    raw_content = payload.get("raw_content") or ""

    if not raw_content or len(raw_content.strip()) < pipe.MIN_RAW_CONTENT:
        return _err(400, "raw_content is empty or too short")
    if not batch_meta:
        return _err(400, "batch_meta is required")

    # 單檔上限：超過拒絕，★ 絕不靜默截斷
    if len(raw_content) > pipe.RAW_CONTENT_THRESHOLD:
        return _err(400, "RAW_CONTENT_TOO_LARGE", {
            "length": len(raw_content),
            "limit": pipe.RAW_CONTENT_THRESHOLD,
        })

    file_name = batch_meta.get("file_name") or "untitled"
    batch_name = file_name.rsplit(".", 1)[0] + " [Phase1]"

    try:
        batch = KBImportBatch(
            id=_new_id(),
            batch_name=batch_name,
            source_file_name=batch_meta.get("file_name") or "",
            source_file_type=batch_meta.get("file_type") or "manual",
            raw_content=raw_content,
            extraction_status="pending",
            analysis_status="pending",
            duplicate_check_status="pending",
            review_status="not_started",
            rag_status="not_ready",
            total_items=0,
            items_extracted=0,
            items_failed=0,
            partial=False,
            extraction_phase="enumerating",
            site_type=batch_meta.get("site_type") or "ecommerce",
            status="uploaded",
            created_by=created_by,
            detected_sections={
                "primary_source_type": batch_meta.get("default_source_type"),
                "primary_knowledge_type": batch_meta.get("default_knowledge_type"),
                "source_types": ([batch_meta["default_source_type"]]
                                 if batch_meta.get("default_source_type") else []),
            },
        )
        db.add(batch)
        db.commit()
        db.refresh(batch)

        return {
            "success": True,
            "id": batch.id,
            "batchId": batch.id,
            "batch_id": batch.id,
            "batch": {
                "batch_name": batch.batch_name,
                "source_file_name": batch.source_file_name or None,
                "source_file_type": batch.source_file_type,
                "chunks": batch_meta.get("chunks") or 1,
                "extraction_phase": batch.extraction_phase,
                "partial": batch.partial,
                "source_encoding": batch_meta.get("source_encoding") or "UTF-8",
                "total_items": batch.total_items,
            },
        }
    except Exception as e:
        db.rollback()
        return _err(500, str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 2. kbImportStart — Pass 1：只列標題，建 skeleton items
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbImportStart", methods=["POST"])
def kb_import_start(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    ★ 不提取內容（original_content / ai_suggested_content 留空）。

    兩條路徑：
      ① structured path（batch_meta.structured_items 存在）
         前端已算好區塊 → 直接落地 + source_metadata
         跳過 detectCandidates 與 LLM union-merge
      ② legacy path（無 structured_items）
         rule-based detectCandidates + 分塊 LLM union-merge
         ★ structured 與 legacy/raw-content 兩條路徑均已完整接通。

    輸入 {batch_meta, raw_content, batchId?}
    回傳 {batchId, total_items, created_count, skipped_count, warning_count,
          error_count, partial, structured, source_format, table_count?,
          idempotent?, existing_item_count?}
    """
    if not user:
        return _err(401, "Unauthorized")

    batch_meta = payload.get("batch_meta")
    raw_content = payload.get("raw_content") or ""
    existing_batch_id = payload.get("batchId")

    if not raw_content or len(raw_content.strip()) < pipe.MIN_RAW_CONTENT:
        return _err(400, "raw_content is empty or too short")
    if not batch_meta:
        return _err(400, "batch_meta is required")

    # batchId 已存在（由 kbImportBatchCreate 建立）→ 標記為 enumerating
    if existing_batch_id:
        b = db.query(KBImportBatch).filter(
            KBImportBatch.id == existing_batch_id).first()
        if b:
            b.extraction_phase = "enumerating"
            b.extraction_status = "pending"
            db.add(b)
            db.commit()

    structured_raw = batch_meta.get("structured_items")

    # ══════════════════════════════════════════════════════════════════════
    # ① STRUCTURED PATH
    # ══════════════════════════════════════════════════════════════════════
    if isinstance(structured_raw, list) and len(structured_raw) > 0:
        # ★ 拆分结果后处理（无论走哪条路径都要过）：
        #   丢弃 title/content 双空条目；title-only + content-only 相邻合并；
        #   朴素段落拆分兜底（短标题段落 + 正文段落合并）；保持顺序并重编号。
        structured_items = pipe.normalize_split_items(structured_raw)

        # ★ xlsx 過濾：剔除 raw_block_content 不符規範的條目
        if batch_meta.get("file_type") == "xlsx":
            structured_items = [
                it for it in structured_items
                if _is_valid_xlsx_block(it.get("raw_block_content") or "")
            ]

        # ── 冪等守衛：同 batchId 已有 items → 直接回傳現況，不重複建立 ──
        if existing_batch_id:
            existing_items = (
                db.query(KBImportItem)
                .filter(KBImportItem.batch_id == existing_batch_id)
                .all()
            )
            if existing_items:
                b = db.query(KBImportBatch).filter(
                    KBImportBatch.id == existing_batch_id).first()
                if b:
                    b.extraction_status = "success"
                    b.total_items = len(existing_items)
                    b.items_extracted = 0
                    b.items_failed = 0
                    b.partial = False
                    b.extraction_phase = "extracting"   # ★ 仍推進到 extracting
                    b.status = "uploaded"
                    b.extraction_error = None
                    db.add(b)
                    db.commit()
                src_fmt = (structured_items[0].get("source_format")
                           if structured_items else None) \
                    or batch_meta.get("file_type") or "docx"
                return {
                    "batchId": existing_batch_id,
                    "total_items": len(existing_items),
                    "created_count": 0,
                    "skipped_count": len(structured_items),
                    "warning_count": 0,
                    "error_count": 0,
                    "partial": False,
                    "structured": True,
                    "source_format": src_fmt,
                    "idempotent": True,
                    "existing_item_count": len(existing_items),
                }

        source_format = (structured_items[0].get("source_format")
                         if structured_items else None) \
            or batch_meta.get("file_type") or "docx"

        try:
            # ── 建立 / 更新 batch ──
            if existing_batch_id:
                batch = db.query(KBImportBatch).filter(
                    KBImportBatch.id == existing_batch_id).first()
                if not batch:
                    return _err(404, "Batch not found")
                batch.extraction_status = "success"
                batch.total_items = len(structured_items)
                batch.items_extracted = 0
                batch.items_failed = 0
                batch.partial = False
                batch.extraction_phase = "extracting"
                batch.status = "uploaded"
                batch.extraction_error = None
                db.add(batch)
                db.commit()
            else:
                file_name = batch_meta.get("file_name") or "untitled"
                batch = KBImportBatch(
                    id=_new_id(),
                    batch_name=file_name.rsplit(".", 1)[0] + " [Phase1]",
                    source_file_name=batch_meta.get("file_name") or "",
                    source_file_type=batch_meta.get("file_type") or "manual",
                    raw_content=raw_content,
                    extraction_status="success",
                    analysis_status="pending",
                    duplicate_check_status="pending",
                    review_status="not_started",
                    rag_status="not_ready",
                    total_items=len(structured_items),
                    items_extracted=0,
                    items_failed=0,
                    partial=False,
                    extraction_phase="extracting",
                    site_type=batch_meta.get("site_type") or "ecommerce",
                    status="uploaded",
                    created_by=getattr(user, "id", None) or "",
                )
                db.add(batch)
                db.commit()
                db.refresh(batch)

            # ── 建立 skeleton items（含完整 source_metadata）──
            warning_count = pipe.create_skeleton_items(
                db, batch.id, structured_items, source_format)

            # ★ AI 行業分類改為異步：規則匹配已同步落地，LLM 分類交由 Celery 覆寫
            pipe.schedule_industry_classification(batch.id)

            return {
                "batchId": batch.id,
                "total_items": len(structured_items),
                "created_count": len(structured_items),
                "skipped_count": len(structured_raw) - len(structured_items),
                "warning_count": warning_count,
                "error_count": 0,
                "partial": False,
                "structured": True,
                "source_format": source_format,
                "table_count": batch_meta.get("structured_table_count"),
            }
        except Exception as e:
            db.rollback()
            return _err(500, str(e))

    # ══════════════════════════════════════════════════════════════════════
    # ② LEGACY / RAW-CONTENT PATH（無 structured_items）
    # ══════════════════════════════════════════════════════════════════════
    try:
        # ★ 拆分结果后处理（与 structured path 一致）：
        #   双空丢弃 / title-only+content-only 合并 / 朴素段落兜底 / 重编号。
        candidates = pipe.normalize_split_items(
            pipe.detect_legacy_candidates(raw_content))
        source_format = batch_meta.get("file_type") or "manual"

        # A document with no detectable headings is still valid knowledge.
        # Preserve it as one boundary-safe item instead of returning 501/empty.
        fallback_whole_document = False
        if not candidates:
            fallback_whole_document = True
            title = (batch_meta.get("document_name") or batch_meta.get("file_name")
                     or "Imported knowledge").rsplit(".", 1)[0]
            candidates = [{"title": title, "line_idx": 0, "hint_type": "whole_document"}]

        if existing_batch_id:
            batch = db.query(KBImportBatch).filter(KBImportBatch.id == existing_batch_id).first()
            if not batch:
                return _err(404, "Batch not found")
            existing_items = db.query(KBImportItem).filter(KBImportItem.batch_id == batch.id).all()
            if existing_items:
                return {
                    "batchId": batch.id, "total_items": len(existing_items),
                    "created_count": 0, "skipped_count": len(candidates),
                    "warning_count": 0, "error_count": 0, "partial": False,
                    "structured": False, "source_format": source_format,
                    "idempotent": True, "existing_item_count": len(existing_items),
                }
        else:
            file_name = batch_meta.get("file_name") or "untitled"
            batch = KBImportBatch(
                id=_new_id(), batch_name=file_name.rsplit(".", 1)[0] + " [Phase1]",
                source_file_name=file_name, source_file_type=source_format, raw_content=raw_content,
                extraction_status="pending", analysis_status="pending",
                duplicate_check_status="pending", review_status="not_started",
                rag_status="not_ready", total_items=0, items_extracted=0, items_failed=0,
                partial=False, extraction_phase="enumerating",
                site_type=batch_meta.get("site_type") or "ecommerce", status="uploaded",
                created_by=getattr(user, "id", None) or "",
            )
            db.add(batch)
            db.commit()
            db.refresh(batch)

        if fallback_whole_document:
            item = {
                "text": candidates[0]["title"],
                # ★ verbatim：整份文件即單一內容，避免 kbExtractStep 走 LLM 提取而留空
                "source_block_type": "atomic_section",
                "raw_block_content": raw_content,
                "order": 0,
                # ★ kbImportStart 直接落地 original_content，不再留空
                "original_content": raw_content,
            }
            pipe.create_skeleton_items(db, batch.id, [item], source_format)
        else:
            pipe.create_legacy_skeleton_items(db, batch.id, candidates, source_format)

        batch.total_items = len(candidates)
        batch.items_extracted = 0
        batch.items_failed = 0
        batch.partial = False
        batch.extraction_phase = "extracting"
        batch.extraction_status = "success"
        batch.extraction_error = None
        db.add(batch)
        db.commit()

        # ★ AI 行業分類改為異步：規則匹配已同步落地，LLM 分類交由 Celery 覆寫
        pipe.schedule_industry_classification(batch.id)

        return {
            "batchId": batch.id, "total_items": len(candidates),
            "created_count": len(candidates), "skipped_count": 0,
            "warning_count": 0, "error_count": 0, "partial": False,
            "structured": False, "source_format": source_format,
            "fallback_whole_document": fallback_whole_document,
            "chunk_count": len(pipe.split_into_chunks(raw_content)),
        }
    except Exception as e:
        db.rollback()
        return _err(500, str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 3. kbExtractStep — Pass 2：每次只處理 1 條
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbExtractStep", methods=["POST"])
def kb_extract_step(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    ★ 每次呼叫只處理 1 條 item（避免 function timeout）。
      前端 / SDK 需迴圈呼叫直到 remaining=0。

    挑選規則：
        1. 第一個 status='enumerated'
        2. 或卡住超過 5 分鐘的 status='extracting'（安全重取 / 續跑）

    提取分支（見 import_pipeline.extract_one_item）：
        A. code           → 完全逐字，不呼叫 LLM
        B. verbatim item  → original_content 逐字，LLM 只做 ai_suggested
        C. 其他           → LLM 提取 + anti-fabrication 驗證
        D. legacy         → 標題位置邊界搜尋

    輸入 {batchId}
    回傳 {processed_item_id, processed_item_title, items_extracted, items_failed,
          needs_manual_check, remaining, total_items, verbatim?, boundary_source?}
    無事可做時：{message, extraction_phase, remaining:0, processed:false}
    """
    if not user:
        return _err(401, "Unauthorized")

    batch_id = payload.get("batchId")
    if not batch_id:
        return _err(400, "batchId required")

    batch = db.query(KBImportBatch).filter(KBImportBatch.id == batch_id).first()
    if not batch:
        return _err(404, "Batch not found")

    if batch.extraction_phase != "extracting":
        return {
            "message": (f"Batch extraction_phase is '{batch.extraction_phase}', "
                        f"not 'extracting'. Nothing to do."),
            "extraction_phase": batch.extraction_phase,
            "remaining": 0,
            "processed": False,
        }

    if not (batch.raw_content or ""):
        return _err(400, "Batch has no raw_content")

    all_items = (
        db.query(KBImportItem)
        .filter(KBImportItem.batch_id == batch_id)
        .order_by(KBImportItem.item_index.asc())
        .all()
    )

    target = pipe.pick_next_item(all_items)

    # ── 無事可做 ──
    if not target:
        t = pipe.tally_items(db, batch_id)
        return {
            "remaining": 0,
            "processed": False,
            "message": "No remaining items",
            "items_extracted": t["pending"],
            "items_failed": t["failed"],
            "needs_manual_check": t["needs_manual_check"],
            "total_items": batch.total_items or len(all_items),
        }

    # ── 標記為 extracting ──
    target.status = "extracting"
    db.add(target)
    db.commit()

    try:
        result = pipe.extract_one_item(db, target, batch)
    except Exception as e:
        db.rollback()
        target.status = "failed"
        db.add(target)
        db.commit()
        result = {"ok": False, "status": "failed", "error": str(e)}

    # ── 更新 batch 計數 ──
    fresh_batch = db.query(KBImportBatch).filter(
        KBImportBatch.id == batch_id).first()
    if result.get("status") == "pending":
        fresh_batch.items_extracted = (fresh_batch.items_extracted or 0) + 1
    elif result.get("status") == "failed":
        fresh_batch.items_failed = (fresh_batch.items_failed or 0) + 1
    db.add(fresh_batch)
    db.commit()

    t = pipe.tally_items(db, batch_id)

    resp = {
        "processed_item_id": target.id,
        "processed_item_title": (target.extracted_title or "").strip(),
        "items_extracted": t["pending"],
        "items_failed": t["failed"],
        "needs_manual_check": t["needs_manual_check"],
        "remaining": t["still_enumerated"],
        "total_items": batch.total_items or len(all_items),
    }
    if result.get("verbatim"):
        resp["verbatim"] = True
    if result.get("boundary_source"):
        resp["boundary_source"] = result["boundary_source"]
    if result.get("error"):
        resp["error_detail"] = result["error"]
    return resp


# ══════════════════════════════════════════════════════════════════════════════
# 4. kbImportFinalize — 結算
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbImportFinalize", methods=["POST"])
def kb_import_finalize(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    結算最終計數，設 extraction_phase='done'。
    kbExtractStep 在 remaining=0 時自動呼叫，或手動呼叫。
    ★ 冪等：從當前 item 狀態重算，可安全重複呼叫。

    輸入 {batchId}
    回傳 {done, extracted, failed, needs_manual_check, still_enumerated,
          partial, total}
    """
    if not user:
        return _err(401, "Unauthorized")

    batch_id = payload.get("batchId")
    if not batch_id:
        return _err(400, "batchId required")

    batch = db.query(KBImportBatch).filter(KBImportBatch.id == batch_id).first()
    if not batch:
        return _err(404, "Batch not found")

    t = pipe.tally_items(db, batch_id)
    partial = (t["failed"] > 0 or t["needs_manual_check"] > 0
               or t["still_enumerated"] > 0)

    error_parts = []
    if t["failed"] > 0:
        error_parts.append(f"技術失敗：{t['failed']} 條")
    if t["needs_manual_check"] > 0:
        error_parts.append(f"需人工核查：{t['needs_manual_check']} 條")
    if t["still_enumerated"] > 0:
        error_parts.append(f"未抽取：{t['still_enumerated']} 條")

    try:
        batch.extraction_phase = "done"
        batch.items_extracted = t["extracted"]
        batch.items_failed = t["failed"]
        batch.partial = partial
        batch.analysis_status = "failed" if partial else "completed"
        if error_parts:
            batch.extraction_error = "；".join(error_parts)
        # ── 08-06：detected_sections 補強（primary source/knowledge type）──
        all_items = (db.query(KBImportItem)
                     .filter(KBImportItem.batch_id == batch_id).all())
        source_types = sorted({i.source_type for i in all_items if i.source_type})
        knowledge_types = sorted({i.knowledge_type for i in all_items
                                  if i.knowledge_type})
        prev = dict(batch.detected_sections or {})
        prev.update({
            "primary_source_type": source_types[0] if len(source_types) == 1 else None,
            "primary_knowledge_type": (knowledge_types[0]
                                       if len(knowledge_types) == 1 else None),
            "source_types": source_types,
            "knowledge_types": knowledge_types,
        })
        batch.detected_sections = prev
        db.add(batch)
        db.commit()

        return {
            "done": True,
            "extracted": t["extracted"],
            "failed": t["failed"],
            "needs_manual_check": t["needs_manual_check"],
            "still_enumerated": t["still_enumerated"],
            "partial": partial,
            "total": t["total"],
        }
    except Exception as e:
        db.rollback()
        return _err(500, str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 5. kbIndustryDetectionSummary — 行業分類檢測結果聚合
# ══════════════════════════════════════════════════════════════════════════════
@_register_both("/kbIndustryDetectionSummary", methods=["POST"])
def kb_industry_detection_summary(
    payload: dict = Body(default_factory=dict),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """前端傳 batch_id，聚合 kb_import_item 的 industry / sub_industries。

    輸入 {batch_id}（亦相容 batchId）
    回傳 {
        description,
        industries: [{label, count_lable}]
    }
    - label 對應 kb_industry_category 的 label（主分類.次分類）
    - 任一 item 的 sub_industries 為空 → description 改為「尚有未能自動識別…」
    """
    batch_id = payload.get("batch_id") or payload.get("batchId")
    if not batch_id:
        return _err(400, "batch_id required")

    batch = db.query(KBImportBatch).filter(KBImportBatch.id == batch_id).first()
    if not batch:
        return _err(404, "Batch not found")

    items = db.query(KBImportItem).filter(
        KBImportItem.batch_id == batch_id).all()

    counts: dict[str, int] = {}
    has_unidentified = False

    for it in items:
        subs = it.sub_industries
        if isinstance(subs, dict):
            subs = subs.get("values") or []
        if not isinstance(subs, list):
            subs = []
        if not subs:
            has_unidentified = True
            continue

        main_value = it.industry or ""
        for sub in subs:
            if not isinstance(sub, str) or not sub.strip():
                has_unidentified = True
                continue
            label = label_for_subcategory(main_value, sub)
            if not label:
                has_unidentified = True
                continue
            counts[label] = counts.get(label, 0) + 1

    industries = [
        {"label": label, "count_lable": f"{count}条"}
        for label, count in sorted(counts.items(), key=lambda kv: -kv[1])
    ]

    description = (
        "尚有未能自動識別您的行業分類。請手動選擇或修改，以確保 AI 客服能提供標準的解答。"
        if has_unidentified
        else "檢測完成！請核對下方行業分類數據，如有可能需要可手動調整。"
    )

    return {
        "description": description,
        "industries": industries,
    }


# ══════════════════════════════════════════════════════════════════════════════
# legacy path 說明
# ══════════════════════════════════════════════════════════════════════════════
"""
kbImportStart 的 legacy/raw-content path（無 structured_items）現已實作：

    app/services/import_pipeline.py → detect_legacy_candidates()
    app/services/import_pipeline.py → create_legacy_skeleton_items()

detect_legacy_candidates 是對 live rule-based heading scan 的 faithful Python port：
    - 保留 «TABLE» fences 內的表格行（不做標題判讀）
    - 排除 continuation labels / list items / 純數字行
    - 全局 normaliseTitleKey 去重
無任何可偵測標題時，整份文件作為單一 boundary-safe item（fallback_whole_document），
不再回傳 501 / 空匯入。kbExtractStep 對 legacy items 退回標題位置邊界搜尋。
"""
