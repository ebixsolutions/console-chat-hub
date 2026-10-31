"""
KB 核心業務服務（server-authoritative，deterministic 部分）

移植自 app_logic/services 的多個檔案：
  chunkingService.js          → chunk_content / generate_chunks
  versioningService.js        → calc_next_version / should_be_major / bump_version
  documentScoreService.js     → compute_holistic_score
  detectionStatusService.js   → compute_detection_state
  duplicateSimilarityService  → duplicate_summary / is_unresolved_duplicate
  activePublishScopeService   → resolve_active_publish_scope
  knowledgeFileStateService   → derive_publish_status / resolve_knowledge_file_state
  industryStandardsService    → load_industry_standards / is_real_rule_id

這些是純邏輯 + entity 讀寫，不含 UI。LLM 呼叫透過 app.core.llm.invoke_llm。
"""
from __future__ import annotations
import hashlib
import math
import re
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models import (
    KBDocument, KBDocumentVersion, KBVectorChunk, KBImportItem, KBImportBatch,
    KBConfig,
)


def _now():
    return datetime.now(timezone.utc)


def _new_id():
    import uuid
    return uuid.uuid4().hex


# ══════════════════════════════════════════════════════════════════════════
# Chunking（chunkingService.js）
# ══════════════════════════════════════════════════════════════════════════
def estimate_tokens(text: str) -> int:
    """粗估：英文 ~4 char/token，中文 ~1.5 char/token。"""
    if not text:
        return 0
    cjk = len(re.findall(r'[\u4e00-\u9fff]', text))
    other = len(text) - cjk
    return int(cjk / 1.5 + other / 4) + 1


def hash_content(text: str) -> str:
    return hashlib.sha256((text or "").strip().encode("utf-8")).hexdigest()


def extract_faq_pairs(content: str) -> list[dict]:
    pairs = []
    # Q: ... A: ... 模式
    blocks = re.split(r'(?=Q[:：])', content or "")
    for b in blocks:
        m = re.match(r'Q[:：]\s*(.+?)\s*A[:：]\s*(.+)', b, re.S)
        if m:
            pairs.append({"q": m.group(1).strip(), "a": m.group(2).strip()})
    return pairs


def chunk_content(content: str, chunk_size: int = 512, overlap: int = 50,
                  source_type: str = "") -> list[dict]:
    """逐行對照 chunkingService.chunkContent。"""
    if not content or not content.strip():
        return []

    # FAQ 特殊處理
    if source_type in ("FAQ", "ManualQA"):
        pairs = extract_faq_pairs(content)
        if pairs:
            chunks = []
            for pair in pairs:
                text = f"Q: {pair['q']}\nA: {pair['a']}"
                tokens = estimate_tokens(text)
                if tokens <= chunk_size:
                    chunks.append({"text": text, "tokens": tokens, "type": "faq_pair"})
                else:
                    for s in chunk_content(text, chunk_size, overlap, ""):
                        chunks.append({**s, "type": "faq_pair"})
            return chunks

    paragraphs = [p.strip() for p in re.split(r'\n{2,}', content) if p.strip()]
    chunks = []
    current = ""
    cur_tokens = 0

    def flush_overlap():
        nonlocal current, cur_tokens
        chunks.append({"text": current.strip(), "tokens": cur_tokens,
                       "type": "full_content"})
        words = current.split()
        keep = words[-max(1, int(overlap / 1.3)):]
        current = " ".join(keep)
        cur_tokens = estimate_tokens(current)

    for para in paragraphs:
        p_tokens = estimate_tokens(para)
        if p_tokens > chunk_size:
            if current.strip():
                flush_overlap()
            sentences = re.split(r'(?<=[。！？.!?])\s*', para)
            for sentence in sentences:
                s_tokens = estimate_tokens(sentence)
                if cur_tokens + s_tokens > chunk_size and current.strip():
                    flush_overlap()
                current += (" " if current else "") + sentence
                cur_tokens += s_tokens
        elif cur_tokens + p_tokens > chunk_size:
            if current.strip():
                flush_overlap()
            current += ("\n\n" if current else "") + para
            cur_tokens += p_tokens
        else:
            current += ("\n\n" if current else "") + para
            cur_tokens += p_tokens

    if current.strip():
        chunks.append({"text": current.strip(), "tokens": cur_tokens,
                       "type": "full_content"})

    return chunks or [{"text": content.strip(),
                       "tokens": estimate_tokens(content), "type": "full_content"}]


def generate_chunks(db: Session, doc: KBDocument, environment: str = "staging") -> int:
    """為文件產生 chunk 並落地 KBVectorChunk。回傳 chunk 數。"""
    content = doc.raw_content or ""
    chunks = chunk_content(content, source_type=doc.source_type or "")
    # supersede 舊 staging chunk
    old = (db.query(KBVectorChunk)
           .filter(KBVectorChunk.document_id == doc.id,
                   KBVectorChunk.environment == environment,
                   KBVectorChunk.status == "active").all())
    for c in old:
        c.status = "superseded"
        db.add(c)
    vid = doc.active_version_id or (doc.version or "1.0")
    for i, ch in enumerate(chunks):
        db.add(KBVectorChunk(
            id=_new_id(), document_id=doc.id, version_id=vid, chunk_index=i,
            chunk_text=ch["text"], token_count=ch["tokens"],
            chunk_type=ch["type"], environment=environment,
            status="active", embedding_status="pending",
            created_date=_now(),
            company_id=doc.company_id,
        ))
    db.commit()
    return len(chunks)


# ══════════════════════════════════════════════════════════════════════════
# Versioning（versioningService.js）
# ══════════════════════════════════════════════════════════════════════════
def calc_next_version(current: str, is_major: bool = False) -> str:
    v = float(current or "1.0")
    if is_major:
        return f"{math.floor(v) + 1}.0"
    major = math.floor(v)
    minor = round((v - major) * 10)
    return f"{major}.{minor + 1}"


def should_be_major(diff: dict) -> bool:
    total = (diff.get("added", 0) + diff.get("modified", 0)
             + diff.get("duplicate", 0))
    if total == 0:
        return False
    changed = diff.get("modified", 0)
    existing = diff.get("total_existing", 1) or 1
    return changed / existing > 0.5


def bump_document_version(db: Session, doc: KBDocument, change_type: str,
                          change_summary: str, diff: Optional[dict] = None) -> str:
    diff = diff or {}
    is_major = should_be_major(diff)
    next_v = calc_next_version(doc.version or "1.0", is_major)
    # snapshot
    db.add(KBDocumentVersion(
        id=_new_id(), document_id=doc.id, version=doc.version or "1.0",
        version_type="major" if is_major else "minor",
        change_type=change_type, change_summary=change_summary,
        raw_content_snapshot=(doc.raw_content or "")[:10000],
        content_hash=hash_content(doc.raw_content or ""),
        review_status="pending", vector_status="not_generated",
        created_by="version_service", created_date=_now(),
    ))
    doc.version = next_v
    db.add(doc)
    db.commit()
    return next_v


# ══════════════════════════════════════════════════════════════════════════
# Document scoring（documentScoreService.js）
# ══════════════════════════════════════════════════════════════════════════
def get_item_content_for_score(item, projected: bool = False) -> str:
    if projected:
        return (item.final_content or item.ai_suggested_content
                or item.original_content or "")
    return item.original_content or ""


def compute_holistic_document_score(items: list) -> dict:
    """
    5 維平均分（completeness / accuracy / clarity / quality / rag_readiness）。
    無 LLM 版：以規則估分（有內容、長度、結構）。
    """
    if not items:
        return {"completeness_score": 0, "accuracy_score": 0, "clarity_score": 0,
                "quality_score": 0, "rag_readiness_score": 0, "overall": 0}

    def score_item(it):
        content = get_item_content_for_score(it, projected=True)
        if not content.strip():
            return 0
        length_score = min(100, len(content) / 5)
        has_structure = 20 if re.search(r'[。\n]', content) else 0
        return min(100, length_score * 0.7 + has_structure + 20)

    scores = [score_item(it) for it in items]
    avg = sum(scores) / len(scores) if scores else 0
    return {
        "completeness_score": round(avg),
        "accuracy_score": round(avg),
        "clarity_score": round(avg),
        "quality_score": round(avg),
        "rag_readiness_score": round(avg * 0.9),
        "overall": round(avg),
    }


# ══════════════════════════════════════════════════════════════════════════
# Detection status（detectionStatusService.js）
# ══════════════════════════════════════════════════════════════════════════
DETECTION_TYPES = ["completeness", "accuracy", "conflict", "duplicate",
                   "hallucination", "grounding"]


def get_eligible_items(items: list) -> list:
    """排除已刪除 / ignored 的 item。"""
    return [it for it in items
            if it.status not in ("ignored", "deleted")
            and not getattr(it, "is_deleted_from_publish", False)]


def compute_detection_state(items: list, docs: Optional[list] = None,
                            batch=None) -> dict:
    eligible = get_eligible_items(items)
    total = len(eligible)
    if total == 0:
        return {"total": 0, "checked": 0, "risk_level": "none", "complete": True}
    scored = sum(1 for it in eligible
                 if it.review_status in ("completed", "passed"))
    high_risk = sum(1 for it in eligible if it.risk_level == "high")
    risk = ("high" if high_risk > 0
            else "medium" if scored < total else "low")
    return {
        "total": total, "checked": scored,
        "risk_level": risk, "complete": scored >= total,
        "high_risk_count": high_risk,
    }


# ══════════════════════════════════════════════════════════════════════════
# Duplicate（duplicateSimilarityService.js）
# ══════════════════════════════════════════════════════════════════════════
def is_unresolved_duplicate(item) -> bool:
    return (getattr(item, "duplicate_status", "none") in ("duplicate", "similar")
            and getattr(item, "duplicate_action", "pending") == "pending")


def get_duplicate_summary(items: list) -> dict:
    dupes = [it for it in items if is_unresolved_duplicate(it)]
    return {
        "total_items": len(items),
        "unresolved_duplicates": len(dupes),
        "has_unresolved": len(dupes) > 0,
    }


# ══════════════════════════════════════════════════════════════════════════
# Active publish scope（activePublishScopeService.js）
# ══════════════════════════════════════════════════════════════════════════
def resolve_active_publish_scope(items: list, docs: list, batch=None) -> dict:
    """
    決定發布 scope：排除 is_deleted_from_publish 的 item，
    映射到其 document，回傳 active document_ids + active_item_ids。
    """
    active_items = [it for it in items
                    if not getattr(it, "is_deleted_from_publish", False)
                    and it.status not in ("ignored", "deleted")]
    active_item_ids = [it.id for it in active_items]

    doc_ids = set()
    for it in active_items:
        did = getattr(it, "saved_document_id", None) or \
            getattr(it, "created_document_id", None) or \
            getattr(it, "original_document_id", None)
        if did:
            doc_ids.add(did)

    return {
        "active_item_ids": active_item_ids,
        "active_document_ids": list(doc_ids),
        "excluded_item_ids": [it.id for it in items
                              if getattr(it, "is_deleted_from_publish", False)],
        "total_active": len(active_item_ids),
    }


# ══════════════════════════════════════════════════════════════════════════
# Knowledge file state（knowledgeFileStateService.js）
# ══════════════════════════════════════════════════════════════════════════
def derive_publish_status_from_batch_status(status: str) -> str:
    mapping = {
        "uploaded": "not_published", "analyzed": "not_published",
        "reviewing": "in_review", "confirmed": "ready",
        "published": "published", "rolled_back": "rolled_back",
        "archived": "archived",
    }
    return mapping.get(status, "not_published")


def compute_publish_status_from_docs(docs: list) -> str:
    if not docs:
        return "empty"
    published = sum(1 for d in docs if d.status == "published")
    if published == len(docs):
        return "published"
    if published > 0:
        return "partially_published"
    return "not_published"


# ══════════════════════════════════════════════════════════════════════════
# Industry standards（industryStandardsService.js）
# ══════════════════════════════════════════════════════════════════════════
def is_real_rule_id(rule_id: str, standards: dict) -> bool:
    """rule_id 必須真實存在於 standards（防 LLM 捏造規則 id）。"""
    if not rule_id or not standards:
        return False
    all_rules = standards.get("rules", []) or []
    return any(r.get("id") == rule_id for r in all_rules)
