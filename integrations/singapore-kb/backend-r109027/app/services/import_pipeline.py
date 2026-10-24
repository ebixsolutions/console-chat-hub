"""
KB Delta Patch v1.2 — Import Pipeline 核心（structure-first 兩段式）

套用位置：app/services/import_pipeline.py
來源：nexus-kb-import-pipeline-replacement（2026-07-31）逐行移植
      backend/functions/kbImportStart/entry.ts    958 行
      backend/functions/kbExtractStep/entry.ts    731 行

═══════════════════════════════════════════════════════════════════════════════
架構
═══════════════════════════════════════════════════════════════════════════════

structure-first 兩段式：前端 adapter 先算好 structured_items（含每個區塊的
raw_block_content），後端直接落地，不再做「下一個候選標題」邊界搜尋。

    kbImportBatchCreate  建 KBImportBatch，回 batchId
    kbImportStart        Pass 1：只列標題，建 skeleton KBImportItem
    kbExtractStep        Pass 2：每次呼叫只處理 1 條（迴圈直到 remaining=0）
    kbImportFinalize     結算計數，extraction_phase='done'

兩條路徑：

  ① structured path（有 structured_items）
     前端已算好區塊 → 每條 item 的 raw_block_content 就是唯一合法來源
     → 邊界安全：不做標題搜尋、不會跨表吞併、無標題子串誤配

  ② legacy path（無 structured_items）
     rule-based detectCandidates + 分塊 LLM union-merge
     kbExtractStep 退回標題位置邊界搜尋
     舊 batch（source_metadata 無 raw_block_content）走此路

═══════════════════════════════════════════════════════════════════════════════
verbatim 分類（決定 original_content 是否 100% 忠實原文）
═══════════════════════════════════════════════════════════════════════════════

    source_block_type ∈ {table, table_section, record, csv_row, csv_table, code}
        → original_content = raw_block_content（逐字，零 LLM 竄改）
          ai_suggested_content = LLM 重排版（code 除外，code 完全不重排）

    其他 block type
        → LLM 從 raw_block_content 提取，並做 anti-fabrication 驗證
          （結果必須在 snippet 範圍內）

★ 這是防 AI 捏造的核心設計。價目表 / 規格表 / JSON record / CSV row
  絕不可讓 LLM 改寫 original_content。
"""
from __future__ import annotations

import re
import threading
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import KBImportBatch, KBImportItem
from app.services.industry_groups import (
    CLASSIFICATION_JSON_SCHEMA,
    build_classification_prompt,
    classify_industry,
    normalize_classification_result,
)

# ══════════════════════════════════════════════════════════════════════════════
# 常數
# ══════════════════════════════════════════════════════════════════════════════
RAW_CONTENT_THRESHOLD = 18_000        # 單檔內容上限（超過拒絕，絕不靜默截斷）
MIN_RAW_CONTENT = 20                  # raw_content 最短長度
STALLED_EXTRACTING_MS = 5 * 60 * 1000  # extracting 卡住 5 分鐘後可重取
LLM_RETRY = 3
LLM_BACKOFF_MS = 1500                 # 1.5s × attempt

# verbatim block type：original_content 必須 100% 忠實原文
VERBATIM_BLOCK_TYPES = {
    "table", "table_section", "atomic_section",
    "record", "csv_row", "csv_table", "code",
}
TABLE_LIKE_BLOCK_TYPES = {"table", "table_section", "atomic_section"}

SOURCE_TYPE_TO_KNOWLEDGE_TYPE = {
    "FAQ": "faq",
    "Product": "product",
    "TermsAndConditions": "compliance",
    "ReturnPolicy": "policy",
    "DeliveryPolicy": "logistics",
    "WarrantyPolicy": "policy",
    "PaymentPolicy": "policy",
    "PrivacyPolicy": "compliance",
    "SizeGuide": "other",
    "ServiceSOP": "sop",
    "Policy": "policy",
    "Other": "other",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return uuid.uuid4().hex


# ══════════════════════════════════════════════════════════════════════════════
# LLM 注入點
# ══════════════════════════════════════════════════════════════════════════════
_invoke_llm: Optional[Callable[..., Any]] = None


def register_llm(fn: Callable[..., Any]) -> None:
    """
    註冊 LLM 呼叫器（對應 Base44 的 base44.integrations.Core.InvokeLLM）。

        fn(prompt: str, response_json_schema: dict | None = None) -> str | dict

    在 app/main.py 啟動時註冊：
        from app.core.llm import invoke_llm
        from app.services.import_pipeline import register_llm
        register_llm(invoke_llm)
    """
    global _invoke_llm
    _invoke_llm = fn


def _llm_text(prompt: str) -> str:
    """
    呼叫 LLM 取純文字。3 次重試，1.5s × attempt backoff。
    全部失敗回空字串（呼叫端會 fallback 到 verbatim）。
    """
    import time
    if _invoke_llm is None:
        return ""
    for attempt in range(1, LLM_RETRY + 1):
        try:
            out = _invoke_llm(prompt=prompt)
            if isinstance(out, str):
                txt = out
            elif isinstance(out, dict):
                txt = out.get("text") or out.get("content") or ""
            else:
                txt = ""
            if txt and txt.strip():
                return txt.strip()
        except Exception:
            if attempt < LLM_RETRY:
                time.sleep(LLM_BACKOFF_MS * attempt / 1000)
    return ""


def _classify_industry_ai(db: Session, title: str = "", content: str = "",
                          created_by: str | None = None) -> tuple[str, dict, list]:
    """AI（LLM）行業分類，走 Platform LLM Router（policy / budget / logs）。

    LLM 回傳字典中不存在的分類時，由 normalize_classification_result 驗證後
    自動新增到 kb_industry_category（含稽核日誌）。
    LLM 未註冊或呼叫失敗時回 ("", {"values": []}, [])，不影響拆分流程。
    """
    if _invoke_llm is None:
        return "", {"values": []}, []
    try:
        out = _invoke_llm(
            prompt=build_classification_prompt(title, content, db),
            response_json_schema=CLASSIFICATION_JSON_SCHEMA,
            db=db,
            app_key="knowledge_base",
            task_type="classification",
        )
        return normalize_classification_result(out, db, created_by=created_by)
    except Exception:
        return "", {"values": []}, []


def schedule_industry_classification(batch_id: str) -> None:
    """背景 AI 行業分類（盡力而為；無 broker 或測試環境時靜默跳過）。

    kbImportStart / 網站匯入只做規則匹配（快速、不阻塞），真正的 LLM 分類
    由本函式派送 Celery 任務在 worker 中異步覆寫。

    ★ 在獨立線程中發送，避免 broker 連線/重試阻塞呼叫方的響應線程（防 API 504）。
    """
    # memory:// 為測試 broker，TestClient portal 下建立連線會觸發原生崩潰 → 跳過
    if (settings.celery_broker or "").startswith("memory://"):
        return

    def _send() -> None:
        try:
            from app.tasks.import_tasks import classify_batch_industry_task
            classify_batch_industry_task.apply_async(args=[batch_id], ignore_result=True)
        except Exception:
            pass

    threading.Thread(target=_send, daemon=True).start()


# ══════════════════════════════════════════════════════════════════════════════
# 文字工具（逐行對照 TS）
# ══════════════════════════════════════════════════════════════════════════════
def normalise_title_key(title: str) -> str:
    """
    候選標題 → 去重鍵。
    去掉前綴（A. / FAQ-01 / 1. / 【】）、括號註記、尾部英文、空白 → 小寫。
    """
    t = title or ""
    t = re.sub(r"^#{1,4}\s+", "", t)                                  # ## heading
    t = re.sub(r"^【[^】]*】\s*", "", t)                                # 【標題】
    t = re.sub(r"^[一二三四五六七八九十百]+[、.．:：]\s*", "", t)        # 一、
    t = re.sub(r"^\d+[\.、）)]\s*", "", t)                             # 1.
    t = re.sub(r"^[A-Za-z]{1,6}[-\s]?\d+\s*[:\s：.．、)）]*", "", t)    # FAQ-01 / A1 / Q12
    t = re.sub(r"^[A-Za-z][\.、]\s*", "", t)                          # A.
    t = re.sub(r"（[^）]*）", "", t)                                    # （括號註記）
    t = re.sub(r"\([^)]*\)", "", t)                                    # (parenthetical)
    t = re.sub(r"[A-Za-z\s]+$", "", t)                                 # 尾部英文
    t = re.sub(r"\s+", "", t)
    return t.strip().lower()


def is_formatting_only(text: Optional[str]) -> bool:
    """
    True = 完全沒有實質內容（只有空行、空 HTML 標籤、分隔線、隱形空白）。
    """
    if not text:
        return True
    s = text.strip()
    if not s:
        return True
    # 空 HTML 區塊：<p></p>, <p><br></p>, <div><br></div>, <span></span>
    s = re.sub(
        r"<(p|div|span|br|hr|h[1-6])[^>]*>\s*(<br\s*/?\s*>|&nbsp;|\s)*</(p|div|span|h[1-6])>",
        "", s, flags=re.I,
    )
    s = re.sub(r"<br\s*/?\s*>", "", s, flags=re.I)
    s = s.replace("&nbsp;", "")
    # 純分隔線
    s = re.sub(r"^[\s\-—–•*]+$", "", s, flags=re.M)
    # 隱形 Unicode 空白
    s = re.sub(r"[\u200B-\u200D\uFEFF\u00A0]", "", s)
    return len(s.strip()) == 0


def normalise_for_check(s: Optional[str]) -> str:
    """anti-fabrication 比對用的正規化：NFKC + 去標點空白 + 小寫。"""
    n = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"[\s\r\n。，、：:「」『』【】（）()]", "", n).lower()


def content_found_in_scope(scope: str, original_content: str) -> bool:
    """
    ★ anti-fabrication 驗證：LLM 提取結果必須落在 snippet 範圍內。
      取結果的 3 個片段（頭 / 中 / 尾各 15 字）比對，全部命中才算合法。
    """
    if not original_content or not original_content.strip():
        return False
    scope_norm = normalise_for_check(scope)
    text = normalise_for_check(original_content)
    if not text:
        return False

    step = len(text) // 3
    spans: list[str] = []
    if step >= 10:
        spans.append(text[0:15])
        spans.append(text[step: step + 15])
        spans.append(text[-15:])
    else:
        spans.append(text[:30])

    return all(sp and sp in scope_norm for sp in spans if sp)


def infer_strong_source_type(title: str, hint_type: Optional[str] = None) -> Optional[str]:
    """
    Base44 2026-08-24 authoritative section classifier.
    Classification authority comes from the local section heading only; body
    words (e.g. a Product section mentioning a 1-year warranty) must not
    reclassify the whole section.
    """
    t = (title or "").strip()
    if not t:
        return None
    # FAQ/Q&A syntax has structural precedence over topic words in the question.
    if hint_type == "faq_qa" or re.search(r"常見問題|FAQ|^(?:Q|問)\s*[:：\d-]", t, re.I):
        return "FAQ"
    if re.search(r"退換貨|退貨|退款|換貨|return|refund|exchange", t, re.I):
        return "ReturnPolicy"
    if re.search(r"配送|送貨|運費|物流|delivery|shipping", t, re.I):
        return "DeliveryPolicy"
    if re.search(r"保固|保修|保養|warranty", t, re.I):
        return "WarrantyPolicy"
    if re.search(r"付款|付費|支付|payment", t, re.I):
        return "PaymentPolicy"
    if re.search(r"私隱|隱私|privacy", t, re.I):
        return "PrivacyPolicy"
    if re.search(r"條款|細則|使用條件|terms(?:\s*(?:and|&)\s*conditions?)?", t, re.I):
        return "TermsAndConditions"
    if re.search(r"標準作業|操作流程|服務流程|\bSOP\b", t, re.I):
        return "ServiceSOP"
    if re.search(r"尺寸指南|尺碼|size\s*guide", t, re.I):
        return "SizeGuide"
    if re.search(r"產品規格|產品資料|商品規格|型號|product(?:\s*(?:spec|info))?", t, re.I):
        return "Product"
    if re.search(r"政策|policy|守則|須知", t, re.I):
        return "Policy"
    return None


def resolve_section_source_type(title: str, content: str, fallback: Optional[str]) -> str:
    """
    Per-section deterministic resolver ported from live kbExtractStep.
    `content` is intentionally not used for type authority.
    """
    strong = infer_strong_source_type(title)
    if strong:
        return strong
    return fallback if fallback in SOURCE_TYPE_TO_KNOWLEDGE_TYPE else "Other"


def guess_source_type(title: str, hint_type: Optional[str] = None) -> str:
    """Heading-only fallback classifier; no batch/body flattening."""
    return infer_strong_source_type(title, hint_type) or "Other"



def split_into_chunks(text: str, max_chunk_chars: int = 3000) -> list[str]:
    """legacy path 用：把長文切成 LLM 可消化的塊。"""
    trimmed = (text or "").strip()
    if len(trimmed) <= max_chunk_chars:
        return [trimmed]

    break_pattern = r"(?=\n(?:#{1,4}\s|【|[一二三四五六七八九十]+[、.]\s|\d+[\.、]\s))"
    parts = [p for p in re.split(break_pattern, trimmed) if p.strip()]
    if len(parts) <= 1:
        parts = [p for p in re.split(r"\n\s*\n", trimmed) if p.strip()]

    chunks: list[str] = []
    current = ""
    for part in parts:
        combined = (current + "\n\n" + part) if current else part
        if len(combined) <= max_chunk_chars:
            current = combined
        else:
            if current:
                chunks.append(current)
            if len(part) > max_chunk_chars:
                for i in range(0, len(part), max_chunk_chars):
                    chunks.append(part[i: i + max_chunk_chars])
                current = ""
            else:
                current = part
    if current:
        chunks.append(current)
    return chunks


def get_title_variants(title: str) -> list[str]:
    """legacy path 邊界搜尋用：標題的各種變體。"""
    t = (title or "").strip()
    variants = [t]
    stripped = re.sub(r"^#{1,4}\s+", "", t)
    stripped = re.sub(r"^【([^】]*)】\s*", r"\1", stripped)
    stripped = re.sub(r"^\d+[\.、）)]\s*", "", stripped)
    stripped = re.sub(r"^[一二三四五六七八九十百]+[、.．:：]\s*", "", stripped)
    if stripped != t:
        variants.append(stripped)
    variants.append(re.sub(r"\s+", "", t))
    seen, out = set(), []
    for v in variants:
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def find_title_position(raw: str, title: str, from_index: int = 0) -> int:
    """legacy path：先從 from_index 找，找不到再全文找。"""
    for v in get_title_variants(title):
        pos = raw.find(v, from_index)
        if pos != -1:
            return pos
    for v in get_title_variants(title):
        pos = raw.find(v)
        if pos != -1:
            return pos
    return -1



# ══════════════════════════════════════════════════════════════════════════════
# legacy/raw-content candidate detection (ported from live kbImportStart)
# ══════════════════════════════════════════════════════════════════════════════
_CONTINUATION_LABELS = (
    "例外", "但", "此外", "如", "如果", "除非", "因此", "包括", "其中", "同時",
    "並且", "然而", "注意", "備註", "說明", "例如", "比如", "即", "否則", "而且",
    "但是", "另外", "另",
)
_POLICY_RE = re.compile(
    r"政策|條款|守則|SOP|須知|注意事項|Policy|Terms|Privacy|Warranty|Delivery|Return|"
    r"配送|送貨|運費|退貨|退換|保固|保修|付款|付費|隱私|服務|關於我們|聯絡", re.I,
)
_HEADING_PATTERNS = (
    (re.compile(r"^FAQ[-\s]?\d+", re.I), "faq_nn"),
    (re.compile(r"^[A-Za-z]{1,6}[-\s]?\d+[\s:：.．、)）]?"), "alpha_numeral"),
    (re.compile(r"^#{1,4}\s+.{2,}"), "heading"),
    (re.compile(r"^【.{1,40}】"), "bracket_heading"),
    (re.compile(r"^[一二三四五六七八九十百]+[、.．:：]\s*.{2,}"), "cn_numeral"),
    (re.compile(r"^\d+[\.、）)]\s*.{2,}"), "numeral"),
    (re.compile(r"^[A-Za-z][\.、]\s*.{2,}"), "letter_numeral"),
    (re.compile(r"^[A-Z][A-Z\s]{4,60}$"), "caps_heading"),
    (re.compile(r"^(Q\s*[\d]*\s*[:\s：]|問\s*[\d]*\s*[:\s：]|FAQ\s*\d*\s*[:\s：])", re.I), "faq_qa"),
)


def _is_continuation_label(line: str) -> bool:
    t = (line or "").strip()
    if not t or len(t) > 30:
        return False
    m = re.match(r"^([^：:]{1,10})[：:]\s*$", t)
    if m:
        label = m.group(1).strip()
        return any(label == c or c in label for c in _CONTINUATION_LABELS)
    if not re.match(r"^(#{1,4}\s|\d+[\.、]|【|[一二三四五六七八九十百])", t):
        return any(t.startswith(c) and len(t) <= 20 for c in _CONTINUATION_LABELS)
    return False


def _is_list_item(line: str) -> bool:
    t = (line or "").strip()
    return bool(t) and (t.endswith(("；", ";", "，", ",")) or bool(re.match(r"^[•●○◦▪▸▹\-]\s", t)))


def _is_list_introduction(line: str) -> bool:
    t = (line or "").strip()
    if not t.endswith(("：", ":")):
        return False
    if len(t) <= 8:
        return False
    return bool(re.search(r"以下|包括|如下|使用|用途|目的|方式|步驟|程序|說明|情況|條件", t)) or len(t) > 15


def _is_unnumbered_heading(lines: list[str], idx: int, line: str) -> bool:
    if len(line) < 2 or len(line) > 30:
        return False
    if idx > 0 and lines[idx - 1].strip():
        return False
    if re.search(r"[。，、；;,\.！！？？]$", line) or _is_continuation_label(line):
        return False
    if re.match(r"^[•●○◦▪▸▹\-]\s", line):
        return False
    for j in range(idx + 1, min(idx + 4, len(lines))):
        nxt = lines[j].strip()
        if not nxt:
            continue
        return len(nxt) >= len(line) or (len(nxt) > 3 and bool(re.search(r"[。，；;,。]$", nxt))) or bool(re.match(r"^[•●○◦▪▸▹\-]\s", nxt))
    return False


def detect_legacy_candidates(text: str) -> list[dict]:
    """Deterministic coverage floor for raw/manual/legacy imports.

    This is a faithful Python port of the live rule-based heading scan. It never
    interprets rows inside «TABLE» fences as headings and globally de-duplicates
    normalised titles. LLM extraction remains in ``_extract_legacy`` and is
    constrained by anti-fabrication checks.
    """
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    candidates: list[dict] = []
    in_table = False
    for i, raw_line in enumerate(lines):
        line = raw_line.strip()
        if line == "«TABLE»":
            in_table = True
            continue
        if line == "«/TABLE»":
            in_table = False
            continue
        if in_table or len(line) < 2 or len(line) > 150:
            continue

        # Table caption immediately before a preserved table fence.
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j < len(lines) and lines[j].strip() == "«TABLE»":
            if not _is_continuation_label(line):
                candidates.append({"title": line, "line_idx": i, "hint_type": "table_caption"})
            continue

        if re.match(r"^\s*\$?\d+([.,]\d+)*\s*(元|HKD|USD|匹|mm|cm|kg|w|W)?\s*$", line, re.I):
            continue

        matched = False
        for pattern, hint in _HEADING_PATTERNS:
            if pattern.search(line):
                matched = True
                if not _is_continuation_label(line) and not _is_list_item(line) and not line.endswith("。"):
                    candidates.append({"title": line, "line_idx": i, "hint_type": hint})
                break

        starts_block = i == 0 or not lines[i - 1].strip()
        if not matched and _POLICY_RE.search(line) and len(line) <= 60 and starts_block:
            if not line.endswith(("。", "，", ",", "；", ";")) and not _is_list_item(line) and not _is_list_introduction(line):
                candidates.append({"title": line, "line_idx": i, "hint_type": "policy_keyword"})
        elif not matched and not _POLICY_RE.search(line) and _is_unnumbered_heading(lines, i, line):
            candidates.append({"title": line, "line_idx": i, "hint_type": "unnumbered_heading"})

    seen: set[str] = set()
    result: list[dict] = []
    for c in candidates:
        key = normalise_title_key(c["title"])
        if key and key not in seen:
            seen.add(key)
            result.append(c)
    return result


def create_legacy_skeleton_items(db: Session, batch_id: str, candidates: list[dict], source_format: str) -> int:
    for idx, candidate in enumerate(candidates):
        title = candidate["title"]
        industry, industries, sub_industries = classify_industry(title)
        row = KBImportItem(
            id=_new_id(), batch_id=batch_id, item_index=idx,
            extracted_title=title, original_section_title="",
            source_type=guess_source_type(title, candidate.get("hint_type")),
            source_chunk_index=0, approx_start_marker=title[:40], approx_end_marker="",
            original_content="", ai_suggested_content="", final_content="",
            industry=industry, industries=industries, sub_industries=sub_industries,
            status="enumerated", human_decision="pending", review_status="not_started",
            suggested_action="create_new", risk_level="low",
            source_metadata={
                "source_format": source_format,
                "source_block_type": "legacy_heading",
                "original_order": idx,
                "line_index": candidate.get("line_idx"),
                "hint_type": candidate.get("hint_type"),
                # no raw_block_content: kbExtractStep intentionally uses title boundaries
            },
        )
        db.add(row)
    db.commit()
    return len(candidates)

# ══════════════════════════════════════════════════════════════════════════════
# 拆分结果后处理（structured / legacy 两条路径都套用）
# ══════════════════════════════════════════════════════════════════════════════
def _split_title(it: dict) -> str:
    """structured 用 text；legacy candidates 用 title。"""
    return (it.get("text") or it.get("title") or "").strip()


def _split_content(it: dict) -> str:
    """content 优先取 original_content，其次 raw_block_content。"""
    c = (it.get("original_content") or "").strip()
    if c:
        return c
    return (it.get("raw_block_content") or "").strip()


def _is_plain_paragraph(it: dict) -> bool:
    sbt = it.get("source_block_type")
    return sbt in (None, "paragraph", "text")


def _has_semantic_grouping(it: dict) -> bool:
    """已有语意分组的 block 一律不参与标题合并（避免二次合并）。"""
    if it.get("section_heading") or it.get("merged_section_headings"):
        return True
    php = it.get("parent_heading_path")
    if isinstance(php, list) and php:
        return True
    gs = it.get("grouping_strategy")
    if isinstance(gs, str) and gs and gs.upper() != "STANDALONE":
        return True
    return False


def _is_heading_like(it: dict) -> bool:
    """短标题行：不带句末标点、非续接标签、非列表项。"""
    t = _split_title(it)
    if not t or len(t) > 40:
        return False
    if t.endswith(("。", "，", ",", "；", ";", "、", "？", "?", "！", "!")):
        return False
    if _is_continuation_label(t) or _is_list_item(t) or _is_list_introduction(t):
        return False
    return True


def _merge_split_pair(head: dict, body: dict) -> dict:
    """把「标题条目」与「正文条目」合并为一条，保留 head 的 metadata 与位置。

    raw_block_content = 标题 + 正文（供 kbExtractStep 后续提取用）
    original_content   = 标题 + 正文（初始骨架，kbExtractStep 会覆盖）
    """
    merged = dict(head)
    title = _split_title(head)
    body_content = _split_content(body)
    body_raw = (body.get("raw_block_content") or "").strip()
    head_raw = (merged.get("raw_block_content") or "").strip()

    # raw_block_content 必须包含标题+正文，否则 kbExtractStep 只有标题 fragment 提取失败
    if body_raw:
        merged["raw_block_content"] = (head_raw + "\n\n" + body_raw).strip() if head_raw else body_raw
    elif not head_raw:
        merged["raw_block_content"] = body_content

    merged["original_content"] = title + "\n\n" + body_content

    warnings = merged.get("warnings") or []
    for w in body.get("warnings") or []:
        if w not in warnings:
            warnings.append(w)
    if warnings:
        merged["warnings"] = warnings
    return merged


# ══════════════════════════════════════════════════════════════════════════════
# ★ 內容級章節切割／合併（按內容語意，非按 HTML 標籤）
# ══════════════════════════════════════════════════════════════════════════════
# 章節邊界：中文明確編號「第一節/第二章/第三部分…」或英文 Section/Part/Chapter
_CONTENT_SECTION_RE = re.compile(
    r"^第\s*[0-9一二三四五六七八九十百千]+\s*(?:節|章|部分|篇)[：:\s]"
)
_CONTENT_SECTION_EN_RE = re.compile(
    r"^(?:Section|Part|Chapter)\s+\d+\s*[：:.\s]", re.I,
)
# 次要邊界：文件尾段的「查詢／聯絡」開頭（後續幾行需有電話／電郵佐證）
_CONTACT_HEADING_RE = re.compile(
    r"^如有(?:任何)?(?:查詢|問題)[，,、:：]|^(?:聯絡我們|聯絡方式|Contact\s*Us)",
    re.I,
)
_CONTACT_METHOD_RE = re.compile(r"📞|📧|電話|電郵|email|phone|Tel\b|Email", re.I)


def _content_section_heading(line: str) -> bool:
    """是否為「內容章節」標題（第X節/章/部分 或 Section/Part/Chapter N）。"""
    t = (line or "").strip()
    if not t:
        return False
    return bool(_CONTENT_SECTION_RE.match(t)
                or _CONTENT_SECTION_EN_RE.match(t))


def _is_verbatim_table_block(it: dict) -> bool:
    """
    是否為真正 verbatim 表格／程式碼區塊（內容不得做章節切割/合併）。

    atomic_section 同時涵蓋「NOTE_SECTION（純文字）」與表格語意區塊；
    只有 table_semantic_type 明確標示 TABLE 時才視為表格，否則允許切割。
    """
    sbt = it.get("source_block_type")
    if sbt in {"table", "table_section", "code"}:
        return True
    if sbt == "atomic_section":
        tst = (it.get("table_semantic_type") or "").upper()
        if tst and tst != "NOTE_SECTION" and "TABLE" in tst:
            return True
    return False


def _find_section_boundaries(lines: list[str]) -> list[int]:
    """找出 block 內所有「內容章節」起點行索引（含聯絡／查詢尾段）。"""
    n = len(lines)
    idxs: list[int] = []
    for i, ln in enumerate(lines):
        t = ln.strip()
        if not t:
            continue
        if _content_section_heading(t):
            idxs.append(i)
            continue
        if _CONTACT_HEADING_RE.match(t):
            window = " ".join(
                lines[j].strip() for j in range(i + 1, min(i + 6, n))
            )
            if _CONTACT_METHOD_RE.search(window):
                idxs.append(i)
    return idxs


def _strip_oc_trailing_heading(it: dict, heading: str) -> None:
    """best-effort：若 original_content 尾行是該標題（含 markdown # 前綴），移除。"""
    oc = (it.get("original_content") or "").rstrip()
    if not oc:
        return
    h = re.sub(r"^[#*\s_]+|[#*\s_]+$", "", heading.strip())
    lines = oc.split("\n")
    for j in range(len(lines) - 1, -1, -1):
        cand = re.sub(r"^#+\s*[*_]*|[*_]*\s*$", "", lines[j]).strip()
        if cand == h or cand.endswith(h):
            it["original_content"] = "\n".join(lines[:j]).rstrip("\n")
            return


def _split_section_headings(it: dict) -> list[dict]:
    """
    把 block 內誤混入的「內容章節標題」拆成獨立章節 block。

    前端若按 HTML 標籤切割，常把「第一節：…」「第二節：…」整行附在前一段
    raw_block_content 尾端（或混在中段）。此處以內容語意為邊界重新切割：
    每個章節標題成為一個新 block，其後的文字併入該章節。
    """
    if _is_verbatim_table_block(it):
        return [it]                     # verbatim 表格/程式碼不做內容切割
    rbc = (it.get("raw_block_content") or "").strip()
    if not rbc:
        return [it]
    lines = rbc.split("\n")
    boundaries = _find_section_boundaries(lines)
    if not boundaries:
        return [it]

    out: list[dict] = []
    head_idx = boundaries[0]
    before = "\n".join(lines[:head_idx]).strip()
    if before:
        clone = dict(it)
        clone["raw_block_content"] = before
        _strip_oc_trailing_heading(clone, lines[head_idx])
        out.append(clone)

    for k, h in enumerate(boundaries):
        end = boundaries[k + 1] if k + 1 < len(boundaries) else len(lines)
        title = lines[h].strip()
        body = "\n".join(lines[h + 1:end]).strip()
        content = title + ("\n\n" + body if body else "")
        out.append({
            "text": title,
            "raw_block_content": content,
            "original_content": content,
            "source_block_type": "atomic_section",
            "section_heading": title,
            "grouping_strategy": "SECTION_MERGE",
            "merged_section_headings": [],
            "is_section_root": True,     # 內容章節根：合併時作為邊界
            "warnings": it.get("warnings") or [],
        })
    return out


def _absorb_blocks(section: dict, blocks: list[dict]) -> dict:
    """把章節下的子 block（如 ⚖️🚫🔐）併入章節 item。"""
    out = dict(section)
    title = _split_title(out)
    parts_raw = [out.get("raw_block_content") or title]
    parts_oc = [out.get("original_content") or title]
    headings = list(out.get("merged_section_headings") or [])
    warnings = list(out.get("warnings") or [])
    for b in blocks:
        bt = _split_title(b)
        bc = _split_content(b)
        if bt and bt != title and bt not in headings:
            headings.append(bt)
        # raw_block_content 常以自身標題開頭 → 移除重複的標題首行
        if bt and bc:
            stripped = bc.strip()
            if stripped.startswith(bt):
                stripped = stripped[len(bt):].lstrip("\n").strip()
            block_txt = (bt + "\n\n" + stripped).strip() if stripped else bt
        elif bc:
            block_txt = bc
        elif bt:
            block_txt = bt
        if block_txt:
            parts_raw.append(block_txt)
            parts_oc.append(block_txt)
        for w in b.get("warnings") or []:
            if w not in warnings:
                warnings.append(w)
    out["raw_block_content"] = "\n\n".join(parts_raw)
    out["original_content"] = "\n\n".join(parts_oc)
    out["merged_section_headings"] = headings
    if warnings:
        out["warnings"] = warnings
    return out


def _merge_into_sections(items: list[dict]) -> list[dict]:
    """
    以「內容章節標題」為邊界，把隸屬該章節的後續小塊合併回章節 item。
    表格類 / code 不併入（維持 verbatim 獨立）。
    """
    out: list[dict] = []
    i, n = 0, len(items)
    while i < n:
        cur = items[i]
        if _content_section_heading(_split_title(cur)) or cur.get("is_section_root"):
            absorbed: list[dict] = []
            j = i + 1
            while j < n:
                nxt = items[j]
                if (_content_section_heading(_split_title(nxt))
                        or nxt.get("is_section_root")):
                    break
                if _is_verbatim_table_block(nxt):
                    break
                absorbed.append(nxt)
                j += 1
            if absorbed:
                out.append(_absorb_blocks(cur, absorbed))
                i = j
                continue
        out.append(cur)
        i += 1
    return out


def normalize_split_items(items: list) -> list:
    """
    拆分结果后处理（structured / legacy 都套用）：
      0. 內容級章節切割與合併：把誤混入 block 的「第X節/章…」標題拆出，
         並將章節下的子區塊（如 ⚖️🚫🔐）合併回章節 item（按內容語意切割）。
      1. 丢弃 title 与 content 都为空的条目
      2. title-only + 紧接 content-only 的条目合并为一条
      3. 朴素段落拆分兜底：短标题段落 + 后接正文段落 → 合并为「小标题 + 内文」
      4. 文件开头的无正文标题行（下一条仍是标题行）→ 视为文件标题丢弃
      5. 重编 item_index / chunk_index 连续，保持原始顺序
    """
    clean = [it for it in (items or []) if isinstance(it, dict)]
    kept = [it for it in clean if _split_title(it) or _split_content(it)]

    # ★ Pass 0a：拆出誤附在 block 內容裡的章節標題
    expanded: list[dict] = []
    for it in kept:
        expanded.extend(_split_section_headings(it))
    # ★ Pass 0b：以章節標題為邊界，合併章節下的子區塊
    sectioned = _merge_into_sections(expanded)

    merged: list[dict] = []
    i, n = 0, len(sectioned)
    while i < n:
        cur = sectioned[i]
        t, c = _split_title(cur), _split_content(cur)
        nxt = sectioned[i + 1] if i + 1 < n else None
        nt = _split_title(nxt) if nxt else ""
        nc = _split_content(nxt) if nxt else ""

        # ① 文件标题行：第一个 block、无正文（下一条仍是标题行）→ 丢弃
        if (i == 0 and t and c and _is_heading_like(cur)
                and nxt and nt and nc and _is_heading_like(nxt)
                and _is_plain_paragraph(cur) and _is_plain_paragraph(nxt)
                and not _has_semantic_grouping(cur)):
            i += 1
            continue

        # ② title-only + content-only 相邻 → 合并
        if t and not c and nxt and nc and not nt:
            merged.append(_merge_split_pair(cur, nxt))
            i += 2
            continue

        # ③ 短标题段落 + 后接正文段落 → 合并（仅限无语意分组的朴素拆分）
        if (t and c and nxt and nc
                and _is_heading_like(cur) and not _is_heading_like(nxt)
                and _is_plain_paragraph(cur) and _is_plain_paragraph(nxt)
                and not _has_semantic_grouping(cur) and not _has_semantic_grouping(nxt)):
            merged.append(_merge_split_pair(cur, nxt))
            i += 2
            continue

        merged.append(cur)
        i += 1

    for idx, it in enumerate(merged):
        it["order"] = idx
        it["item_index"] = idx
        it["chunk_index"] = idx
        it["source_chunk_index"] = idx
    return merged


# ══════════════════════════════════════════════════════════════════════════════
# structured path：建立 skeleton items
# ══════════════════════════════════════════════════════════════════════════════
def build_source_metadata(item: dict, idx: int, source_format: str) -> dict:
    """
    ★ 統一 structured-item 契約：所有格式的 metadata 都落進 source_metadata。
      kbExtractStep 與 UI 靠它重建 provenance。
    """
    return {
        "source_format": source_format,
        "source_block_type": item.get("source_block_type"),
        "source_block_id": item.get("block_id"),
        "source_table_id": item.get("table_id"),
        "source_section_id": item.get("section_id"),
        "table_mode": item.get("table_mode"),
        "table_confidence": item.get("table_confidence"),
        "source_row_range": item.get("row_range") or item.get("source_row_range"),
        "source_row_index": (item.get("row_index")
                             if item.get("row_index") is not None
                             else item.get("source_row_index")),
        "source_column_headers": (item.get("column_headers")
                                  or item.get("source_headers")),
        "original_order": item.get("order") if item.get("order") is not None else idx,
        "raw_block_content": item.get("raw_block_content") or "",
        "extraction_warnings": item.get("warnings") or [],
        # JSON
        "json_path": item.get("json_path"),
        "record_index": item.get("record_index"),
        "record_key": item.get("record_key"),
        "parent_path": item.get("parent_path"),
        # CSV
        "delimiter": item.get("delimiter"),
        "original_headers": item.get("original_headers"),
        # TXT
        "source_start_offset": item.get("source_start_offset"),
        "source_end_offset": item.get("source_end_offset"),
        "list_metadata": item.get("list_metadata"),
        # MD
        "markdown_node_type": item.get("markdown_node_type"),
        "heading_path": item.get("heading_path"),
        # ★ v1.2.1 語意分組（DOCX ATOMIC_SECTION）
        "parent_heading_path": item.get("parent_heading_path"),
        "section_heading": item.get("section_heading"),
        "table_caption": item.get("table_caption"),
        "table_semantic_type": item.get("table_semantic_type"),
        "grouping_strategy": item.get("grouping_strategy"),
        "related_following_block_ids": item.get("related_following_block_ids"),
        "merged_section_headings": item.get("merged_section_headings"),
    }


def create_skeleton_items(
    db: Session, batch_id: str, structured_items: list[dict], source_format: str,
) -> int:
    """
    建立 skeleton KBImportItem（只有標題，內容留空）。
    回傳 warning 總數。
    """
    warning_count = 0
    for idx, item in enumerate(structured_items):
        sbt = item.get("source_block_type")
        hint_type = ("table_caption" if sbt in TABLE_LIKE_BLOCK_TYPES else sbt)
        # atomic_section 也視為表格類 caption（v1.2.1）
        warnings = item.get("warnings") or []
        warning_count += len(warnings)

        industry, industries, sub_industries = classify_industry(
            item.get("text") or "",
            (item.get("original_content") or "") + "\n"
            + (item.get("raw_block_content") or ""),
        )

        row = KBImportItem(
            id=_new_id(),
            batch_id=batch_id,
            item_index=idx,
            extracted_title=item.get("text") or "",
            original_section_title="",
            source_type=("Product" if item.get("route_type") == "PRODUCT"
                         else guess_source_type(item.get("text") or "", hint_type)),
            source_chunk_index=0,
            approx_start_marker="",
            approx_end_marker="",
            original_content=item.get("original_content") or "",
            ai_suggested_content="",
            final_content="",
            industry=industry,
            industries=industries,
            sub_industries=sub_industries,
            status="enumerated",
            human_decision="pending",
            review_status="not_started",
            suggested_action="create_new",
            risk_level="low",
            source_metadata=build_source_metadata(item, idx, source_format),
        )
        db.add(row)
    db.commit()
    return warning_count


# ══════════════════════════════════════════════════════════════════════════════
# boundary-safe extraction（kbExtractStep 核心）
# ══════════════════════════════════════════════════════════════════════════════
REFORMAT_PROMPT_TABLE = (
    "你是知識庫整理員。以下是價目表／規格表原文（tab 分隔的表格行，已無內部標記）。"
    "請在不增刪任何事實、不更改任何數字與單位的前提下，"
    "整理成清晰易讀的 Markdown 表格或條列，保留全部項目。\n\n"
    "【原文】\n{raw}\n\n只回覆整理後內容（純文字，不要 JSON）。"
)

REFORMAT_PROMPT_RECORD = (
    "你是知識庫整理員。以下是結構化資料原文（欄位名稱與值）。"
    "請在不增刪任何事實、不更改任何數字與單位的前提下，"
    "整理成清晰易讀的條列或表格，保留全部欄位與項目。\n\n"
    "【原文】\n{raw}\n\n只回覆整理後內容（純文字，不要 JSON）。"
)

EXTRACT_PROMPT = (
    "你是知識庫內容提取員。從以下原文片段中，"
    "提取標題「{title}」對應的完整內容。\n\n"
    "【原文片段】（唯一合法來源，不可引用此範圍以外任何文字）：\n{raw}\n\n"
    "只回覆提取到的內容本文（純文字，不要 JSON、不要標題、不要解釋）。"
)


def pick_next_item(items: list[KBImportItem]) -> Optional[KBImportItem]:
    """
    ★ 每次只挑 1 條：
        1. 第一個 status='enumerated'
        2. 或卡住超過 5 分鐘的 status='extracting'（可安全重取）
    """
    items = sorted(items, key=lambda i: (i.item_index or 0))
    now = _now()
    for it in items:
        if it.status == "enumerated":
            return it
        if it.status == "extracting":
            last = it.updated_date or it.created_date
            if last:
                if last.tzinfo is None:
                    last = last.replace(tzinfo=timezone.utc)
                if (now - last).total_seconds() * 1000 > STALLED_EXTRACTING_MS:
                    return it
    return None


def extract_one_item(db: Session, item: KBImportItem, batch: KBImportBatch) -> dict:
    """
    對單一 item 執行提取。

    回傳 {
        ok, verbatim, boundary_source, status, needs_manual_check, error
    }

    ★ 三條分支：
        A. code           → 完全逐字，不呼叫 LLM
        B. verbatim item  → original_content 逐字，LLM 只做 ai_suggested_content
        C. 其他           → LLM 從 raw_block_content 提取 + anti-fabrication 驗證
        D. legacy         → 無 raw_block_content，退回標題位置邊界搜尋
    """
    sm = item.source_metadata or {}
    rbc = (sm.get("raw_block_content") or "").strip()
    sbt = sm.get("source_block_type")
    # Re-resolve at extraction time from the local section boundary. This
    # prevents stale/batch defaults from flattening mixed documents.
    source_type = resolve_section_source_type(
        item.extracted_title or "", rbc, item.source_type or "Other"
    )
    knowledge_type = SOURCE_TYPE_TO_KNOWLEDGE_TYPE.get(source_type, "other")

    # ── D. legacy path：無 raw_block_content ──
    if not rbc:
        return _extract_legacy(db, item, batch, source_type, knowledge_type)

    # ── A. code：完全逐字，不呼叫 LLM（避免竄改）──
    if sbt == "code":
        item.original_content = rbc
        item.ai_suggested_content = rbc
        item.final_content = rbc
        item.source_type = source_type
        item.knowledge_type = knowledge_type
        item.review_status = "not_started"
        item.status = "pending"
        db.add(item)
        db.commit()
        return {"ok": True, "verbatim": True,
                "boundary_source": "raw_block_content", "status": "pending"}

    # ── B. verbatim item：表格 / atomic_section / JSON record / CSV row ──
    if sbt in VERBATIM_BLOCK_TYPES:
        is_table_like = sbt in TABLE_LIKE_BLOCK_TYPES
        prompt = (REFORMAT_PROMPT_TABLE if is_table_like
                  else REFORMAT_PROMPT_RECORD).format(raw=rbc)
        ai_suggested = _llm_text(prompt)

        item.original_content = rbc                       # ★ 永遠逐字
        item.ai_suggested_content = ai_suggested or rbc
        # ★ anti-fabrication：verbatim 內容「不增刪任何事實」是硬約束。
        #   重排版若抽樣片段無法在原文找到，一律退回逐字、不得採用 LLM 產出，
        #   並標 needs_manual_check（同 branch C 的防偽造守則）。
        candidate = (ai_suggested or "").strip()
        grounded = (not candidate
                    or content_found_in_scope(rbc, candidate))
        item.final_content = candidate if grounded else rbc
        item.source_type = source_type
        item.knowledge_type = knowledge_type
        item.review_status = "not_started"
        item.status = "pending" if grounded else "needs_manual_check"
        db.add(item)
        db.commit()
        if not grounded:
            return {"ok": True, "verbatim": True,
                    "table_verbatim": is_table_like,
                    "rbc_matches_oc": True,
                    "boundary_source": "raw_block_content",
                    "status": "needs_manual_check",
                    "needs_manual_check": True,
                    "error": "reformatted content not found in scope "
                             "(possible fabrication)"}
        return {"ok": True, "verbatim": True,
                "table_verbatim": is_table_like,
                "rbc_matches_oc": True,
                "boundary_source": "raw_block_content", "status": "pending"}

    # ── C. 非表格：LLM 提取 + anti-fabrication ──
    title = (item.extracted_title or "").strip()
    extracted = _llm_text(EXTRACT_PROMPT.format(title=title, raw=rbc))

    if not extracted:
        item.status = "failed"
        item.review_status = "not_started"
        db.add(item)
        db.commit()
        return {"ok": False, "status": "failed",
                "boundary_source": "raw_block_content",
                "error": "LLM returned empty"}

    # ★ anti-fabrication：結果必須落在 raw_block_content 範圍內
    if not content_found_in_scope(rbc, extracted):
        item.original_content = rbc                       # 退回逐字，不採用 LLM
        item.ai_suggested_content = extracted
        item.final_content = rbc
        item.source_type = source_type
        item.knowledge_type = knowledge_type
        item.review_status = "not_started"
        item.status = "needs_manual_check"
        db.add(item)
        db.commit()
        return {"ok": True, "verbatim": False,
                "boundary_source": "raw_block_content",
                "status": "needs_manual_check",
                "needs_manual_check": True,
                "error": "content not found in scope (possible fabrication)"}

    item.original_content = extracted
    # ★ 合并 item 后处理：若 raw_block_content 以标题开头（= 拆分合并产物），
    #    但 LLM 照 prompt 指令去掉了标题，则补回 title + \n\n
    if title and rbc.strip().startswith(title) and not extracted.strip().startswith(title):
        item.original_content = title + "\n\n" + extracted
    item.ai_suggested_content = extracted
    item.final_content = extracted
    item.source_type = source_type
    item.knowledge_type = knowledge_type
    item.review_status = "not_started"
    item.status = "pending"
    db.add(item)
    db.commit()
    return {"ok": True, "verbatim": False,
            "boundary_source": "raw_block_content", "status": "pending"}


def _extract_legacy(db: Session, item: KBImportItem, batch: KBImportBatch,
                    source_type: str, knowledge_type: str) -> dict:
    """
    legacy path：無 raw_block_content，用標題位置做邊界搜尋。
    舊 batch 與 CSV/TXT/MD 未走 structured 時使用。
    """
    raw = batch.raw_content or ""
    title = (item.extracted_title or "").strip()

    start = find_title_position(raw, title, 0)
    if start == -1:
        item.status = "needs_manual_check"
        db.add(item)
        db.commit()
        return {"ok": True, "status": "needs_manual_check",
                "boundary_source": "title_search",
                "needs_manual_check": True,
                "error": "title not found in raw_content"}

    # 下一個 item 的標題位置作為邊界
    next_items = (
        db.query(KBImportItem)
        .filter(KBImportItem.batch_id == batch.id,
                KBImportItem.item_index > (item.item_index or 0))
        .order_by(KBImportItem.item_index.asc())
        .all()
    )
    end = len(raw)
    for nxt in next_items:
        p = find_title_position(raw, (nxt.extracted_title or "").strip(), start + 1)
        if p > start:
            end = p
            break

    snippet = raw[start:end].strip()
    if is_formatting_only(snippet):
        item.status = "needs_manual_check"
        db.add(item)
        db.commit()
        return {"ok": True, "status": "needs_manual_check",
                "boundary_source": "title_search",
                "needs_manual_check": True,
                "error": "snippet is formatting-only"}

    extracted = _llm_text(EXTRACT_PROMPT.format(title=title, raw=snippet))
    if not extracted or not content_found_in_scope(snippet, extracted):
        item.original_content = snippet
        item.ai_suggested_content = extracted or ""
        item.final_content = snippet
        item.status = "needs_manual_check"
    else:
        item.original_content = extracted
        item.ai_suggested_content = extracted
        item.final_content = extracted
        item.status = "pending"

    item.source_type = source_type
    item.knowledge_type = knowledge_type
    item.review_status = "not_started"
    db.add(item)
    db.commit()
    return {"ok": True, "verbatim": False,
            "boundary_source": "title_search", "status": item.status}


# ══════════════════════════════════════════════════════════════════════════════
# 計數
# ══════════════════════════════════════════════════════════════════════════════
def tally_items(db: Session, batch_id: str) -> dict:
    """統計 batch 內各狀態的 item 數。"""
    items = db.query(KBImportItem).filter(KBImportItem.batch_id == batch_id).all()
    return {
        "total": len(items),
        "extracted": sum(1 for i in items if i.status in ("pending", "saved")),
        "failed": sum(1 for i in items if i.status == "failed"),
        "needs_manual_check": sum(1 for i in items if i.status == "needs_manual_check"),
        "still_enumerated": sum(1 for i in items if i.status == "enumerated"),
        "pending": sum(1 for i in items if i.status == "pending"),
    }
