"""
Source Grounding Validator — anti-fabrication 驗證（server-authoritative）

移植自 app_logic/services/sourceGroundingValidator.js（651 行）

核心：驗證 AI 建議內容（suggested）是否 grounded 於來源內容（source），
      逐句偵測「來源未支援的數字 / 日期 / 實體」= 幻覺 fabrication。

分層：
  Layer A  claim-level new-token reject：句子引入來源沒有的數字/日期/大寫實體 → 拒
  重疊比對：候選句 overlap ratio ≥ 門檻才視為有支撐
  矛盾偵測：claimCandidateRelationship → contradicts / supports /
            requires_semantic_validation
  Layer B  可選 semantic validator（LLM）處理需語意判斷者

fail-closed：hash / crypto 失敗 → technical_failure=True，不放行
"""
from __future__ import annotations
import hashlib
import re
import unicodedata
from typing import Any, Callable, Optional

CANDIDATE_MIN_OVERLAP = 0.5
PLACEHOLDER_RE = re.compile(r'\{\{[^}]+\}\}|\[[^\]]+\]|＿+|_{2,}|●+|\*{3,}')


class GroundingError(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


# ── hash（與前端 sha256 一致）──
def sha256(text: str) -> str:
    return hashlib.sha256((text or "").strip().encode("utf-8")).hexdigest()


# ── 文字工具 ──
def _normalize(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "")


def extract_numbers(text: str) -> set[str]:
    return set(re.findall(r'\d+(?:[.,]\d+)?', text or ""))


def extract_dates(text: str) -> set[str]:
    pats = [
        r'\d{4}[-/年]\d{1,2}[-/月]\d{1,2}',
        r'\d{1,2}[-/]\d{1,2}[-/]\d{2,4}',
        r'\d{4}\s*年',
    ]
    out = set()
    for p in pats:
        out |= set(re.findall(p, text or ""))
    return out


def content_words(text: str) -> set[str]:
    n = _normalize(text).lower()
    # 中文逐字 + 英文詞
    words = set(re.findall(r'[a-z0-9]+', n))
    words |= set(re.findall(r'[\u4e00-\u9fff]', n))
    return words


def split_sentences(text: str) -> list[dict]:
    """回傳 [{text, offset}]。"""
    if not text:
        return []
    parts = re.split(r'(?<=[。！？.!?\n])', text)
    out = []
    off = 0
    for p in parts:
        if p.strip():
            out.append({"text": p.strip(), "offset": off})
        off += len(p)
    return out


def mask_placeholders(text: str) -> str:
    return PLACEHOLDER_RE.sub(" ", text or "")


def is_placeholder_only(text: str) -> bool:
    return not mask_placeholders(text).strip()


def claim_candidate_relationship(claim: str, candidate: str) -> str:
    """
    簡化版 Layer A 關係判定：
      數字/日期衝突 → contradicts
      高重疊 → supports
      其餘 → requires_semantic_validation
    """
    c_nums = extract_numbers(claim)
    o_nums = extract_numbers(candidate)
    # claim 的數字若在 candidate 完全對不上但主題重疊 → 可能矛盾
    if c_nums and o_nums and c_nums != o_nums:
        common_ctx = content_words(claim) & content_words(candidate)
        if len(common_ctx) >= 2:
            return "contradicts"
    cw = content_words(claim)
    ow = content_words(candidate)
    if not cw:
        return "supports"
    overlap = len(cw & ow) / len(cw)
    if overlap >= 0.8:
        return "supports"
    return "requires_semantic_validation"


# ── 主驗證 ──
def validate_grounding(
    source_item_content: str,
    suggested_item_content: str,
    context: Optional[dict] = None,
) -> dict:
    context = context or {}
    base = {
        "grounded": False, "reasons": [], "unsupported_claims": [],
        "placeholders": [], "evidence": [], "failure_code": None,
        "technical_failure": False,
        "source_item_content_hash": None, "suggested_item_content_hash": None,
    }

    if not suggested_item_content or not suggested_item_content.strip():
        return {**base, "reasons": ["suggested_content 為空"]}

    try:
        source_hash = sha256(source_item_content or "")
        suggested_hash = sha256(suggested_item_content or "")
    except Exception as e:
        return {**base, "failure_code": "grounding_hash_failed",
                "technical_failure": True, "reasons": [str(e)]}

    unsupported = []
    evidence = []
    placeholders = PLACEHOLDER_RE.findall(suggested_item_content) or []
    masked = mask_placeholders(suggested_item_content)

    orig_nums = extract_numbers(source_item_content)
    orig_dates = extract_dates(source_item_content)
    orig_upper = set(re.findall(r'[A-Z][A-Za-z]{2,}', source_item_content or ""))

    orig_sentences = split_sentences(source_item_content)
    sug_sentences = split_sentences(masked)

    semantic_fn: Optional[Callable] = context.get("semantic_validator")

    for idx, sent in enumerate(sug_sentences):
        if is_placeholder_only(sent["text"]):
            continue
        sent_words = content_words(sent["text"])
        if not sent_words:
            continue

        # ── Layer A：new-token reject ──
        c_nums = extract_numbers(sent["text"])
        c_dates = extract_dates(sent["text"])
        c_ents = re.findall(r'[A-Z][A-Za-z]{2,}', sent["text"])
        has_new_token = (
            any(n not in orig_nums for n in c_nums)
            or any(d not in orig_dates for d in c_dates)
            or any(e not in orig_upper and e.lower() not in
                   {u.lower() for u in orig_upper} for e in c_ents)
        )

        if has_new_token:
            unsupported.append(
                f"聲明引入來源未支援的數字/日期/實體：{sent['text'][:60]}")
            continue

        # ── 重疊 + 關係 ──
        best_supports = None
        best_requires = None
        contradicted = False
        for os in orig_sentences:
            os_words = content_words(os["text"])
            if not os_words:
                continue
            ov = len(sent_words & os_words)
            ratio = ov / len(sent_words)
            if ratio < CANDIDATE_MIN_OVERLAP:
                continue
            rel = claim_candidate_relationship(sent["text"], os["text"])
            if rel == "contradicts":
                contradicted = True
                unsupported.append(f"聲明與來源矛盾：{sent['text'][:60]}")
                break
            elif rel == "supports":
                best_supports = os
            elif rel == "requires_semantic_validation":
                best_requires = os

        if contradicted:
            continue
        if best_supports:
            evidence.append({"claim": sent["text"][:80],
                             "source": best_supports["text"][:80]})
        elif best_requires and semantic_fn:
            try:
                ok = semantic_fn(sent["text"], best_requires["text"])
                if ok:
                    evidence.append({"claim": sent["text"][:80],
                                     "source": best_requires["text"][:80],
                                     "semantic": True})
                else:
                    unsupported.append(f"語意驗證未通過：{sent['text'][:60]}")
            except Exception:
                unsupported.append(f"語意驗證失敗（fail-closed）：{sent['text'][:60]}")
        elif best_requires:
            # 無 semantic validator → 保守視為未支援
            unsupported.append(f"需語意驗證但無驗證器：{sent['text'][:60]}")
        else:
            unsupported.append(f"找不到來源支撐：{sent['text'][:60]}")

    grounded = len(unsupported) == 0
    return {
        "grounded": grounded,
        "reasons": [] if grounded else ["存在未 grounded 的聲明"],
        "unsupported_claims": unsupported,
        "placeholders": placeholders,
        "evidence": evidence,
        "failure_code": None,
        "technical_failure": False,
        "source_item_content_hash": source_hash,
        "suggested_item_content_hash": suggested_hash,
    }
