"""行業分類自動識別（DB 驅動）。

原 `INDUSTRY_GROUPS` 常數已遷移至資料庫表 `kb_industry_category`
（主分類 level=1、次分類 level=2、parent_id 自我參照），
預設資料見 `app.services.industry_seed_data`。

讀取路徑：
  1. 記憶體快取（TTL 由 settings.industry_catalog_cache_ttl_seconds 控制）
  2. 資料庫 kb_industry_category
  3. 降級：DB 無資料或不可用時，暫用內建種子字典（唯讀，不回寫）

提供：
- load_catalog / get_industry_groups：讀取分類字典
- label_for_industry / label_for_subcategory：value → label
- classify_industry：rule-based keyword matching
- build_classification_prompt / normalize_classification_result：LLM 分類
- ensure_seeded：冪等寫入種子分類（啟動 / 遷移用）
- verify_and_register_categories：LLM 未知分類的驗證 + 自動新增 + 稽核日誌
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import KBIndustryCategory, KBIndustryCategoryLog
from app.services.industry_seed_data import SEED_INDUSTRY_GROUPS

logger = logging.getLogger("nexus_kb.industry_groups")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ── 分類層級 ──
LEVEL_MAIN = 1
LEVEL_SUB = 2

# ── 分類來源 ──
SOURCE_SEED = "seed"
SOURCE_LLM_AUTO = "llm_auto"
SOURCE_MANUAL = "manual"

# ── 日誌動作 ──
ACTION_CREATED = "created"
ACTION_DUPLICATE = "duplicate_skipped"
ACTION_INVALID = "rejected_invalid"
ACTION_DISABLED = "rejected_disabled"

# 自動新增分類的格式限制：英文字母開頭，僅英數與底線（如 HomeAppliance_AirCon）
CATEGORY_VALUE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{1,63}$")
CATEGORY_VALUE_MAX_LEN = 64
AUTO_CATEGORY_DESCRIPTION = "由 LLM 分類自動識別新增（待人工校訂）"
AUTO_CATEGORY_SORT_ORDER = 1000

CLASSIFICATION_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "industry": {"type": "string"},
        "sub_industries": {"type": "array", "items": {"type": "string"}},
        "new_sub_industries": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "value": {"type": "string"},
                    "label": {"type": "string"},
                },
                "required": ["value", "label"],
            },
        },
    },
    "required": ["industry", "sub_industries"],
}


# ══════════════════════════════════════════════════════════════════════════════
# 分類字典（DB 快照）
# ══════════════════════════════════════════════════════════════════════════════
def _level_of(row: dict[str, Any]) -> int:
    level = row.get("level")
    if level is None:
        return LEVEL_SUB if row.get("parent_id") else LEVEL_MAIN
    return int(level)


def _is_active(row: dict[str, Any]) -> bool:
    return row.get("is_active") is not False


@dataclass(frozen=True)
class IndustryCatalog:
    """kb_industry_category 的唯讀快照。"""

    groups: tuple[dict[str, Any], ...] = ()
    by_value: dict[str, dict[str, Any]] = field(default_factory=dict)
    value_to_label: dict[str, str] = field(default_factory=dict)
    sub_to_main: dict[str, str] = field(default_factory=dict)
    main_values: frozenset[str] = frozenset()
    sub_values: frozenset[str] = frozenset()
    from_db: bool = False


def _build_catalog(rows: list[dict[str, Any]], *, from_db: bool) -> IndustryCatalog:
    """把分類列組成 {label, value, subcategories} 樹狀字典。

    只收錄 is_active 的分類；孤兒次分類（父分類不存在）仍納入 label 查詢，
    但不列入樹狀結構與分類匹配目標。
    """
    ordered = sorted(rows, key=lambda r: (r.get("sort_order") or 0, r.get("value") or ""))
    by_value = {r["value"]: r for r in ordered}
    active = [r for r in ordered if _is_active(r)]
    main_by_id = {r["id"]: r for r in active if _level_of(r) == LEVEL_MAIN}

    value_to_label: dict[str, str] = {}
    sub_to_main: dict[str, str] = {}
    sub_values: set[str] = set()
    subs_by_main: dict[str, list[dict[str, Any]]] = {}

    for r in active:
        if _level_of(r) == LEVEL_MAIN:
            continue
        value_to_label[r["value"]] = r["label"]
        sub_values.add(r["value"])
        parent = main_by_id.get(r.get("parent_id"))
        if parent is not None:
            sub_to_main[r["value"]] = parent["value"]
            subs_by_main.setdefault(parent["id"], []).append(r)

    groups: list[dict[str, Any]] = []
    main_values: set[str] = set()
    for r in active:
        if _level_of(r) != LEVEL_MAIN:
            continue
        main_values.add(r["value"])
        value_to_label[r["value"]] = r["label"]
        groups.append({
            "label": r["label"],
            "value": r["value"],
            "subcategories": [
                {"label": s["label"], "value": s["value"]}
                for s in subs_by_main.get(r["id"], [])
            ],
        })

    return IndustryCatalog(
        groups=tuple(groups),
        by_value=by_value,
        value_to_label=value_to_label,
        sub_to_main=sub_to_main,
        main_values=frozenset(main_values),
        sub_values=frozenset(sub_values),
        from_db=from_db,
    )


def _row_dict(r: KBIndustryCategory) -> dict[str, Any]:
    return {
        "id": r.id,
        "value": r.value,
        "label": r.label,
        "description": r.description,
        "parent_id": r.parent_id,
        "level": _level_of({"level": r.level, "parent_id": r.parent_id}),
        "source": r.source,
        "is_active": r.is_active is not False,
        "sort_order": int(r.sort_order or 0),
    }


def _seed_rows() -> list[dict[str, Any]]:
    """內建種子字典 → 與 DB 列同構的清單（僅供降級路徑使用）。"""
    rows: list[dict[str, Any]] = []
    for gi, group in enumerate(SEED_INDUSTRY_GROUPS):
        gid = f"seed:{group['value']}"
        rows.append({
            "id": gid, "value": group["value"], "label": group["label"],
            "description": None, "parent_id": None, "level": LEVEL_MAIN,
            "source": SOURCE_SEED, "is_active": True, "sort_order": gi,
        })
        for si, sub in enumerate(group.get("subcategories") or []):
            rows.append({
                "id": f"seed:{sub['value']}", "value": sub["value"],
                "label": sub["label"], "description": None, "parent_id": gid,
                "level": LEVEL_SUB, "source": SOURCE_SEED, "is_active": True,
                "sort_order": si,
            })
    return rows


# ── 快取 ──
_cache: Optional[IndustryCatalog] = None
_cache_at: float = 0.0
_cache_lock = threading.Lock()


def invalidate_catalog_cache() -> None:
    """清空分類字典快取（新增/停用分類後呼叫）。"""
    global _cache, _cache_at
    with _cache_lock:
        _cache = None
        _cache_at = 0.0


def _cache_ttl() -> float:
    try:
        return max(0, int(settings.industry_catalog_cache_ttl_seconds))
    except (TypeError, ValueError):
        return 300.0


def _fetch_rows(db: Session) -> list[dict[str, Any]]:
    rows = (
        db.query(KBIndustryCategory)
        .order_by(KBIndustryCategory.sort_order.asc(),
                  KBIndustryCategory.value.asc())
        .all()
    )
    return [_row_dict(r) for r in rows]


def load_catalog(db: Session | None = None, *, force: bool = False) -> IndustryCatalog:
    """取得分類字典快照。

    - force=True 或快取過期 → 重新讀取資料庫；
    - 讀取失敗或表為空 → 降級使用內建種子字典（記錄 warning，不中斷流程）。
    """
    global _cache, _cache_at

    if not force:
        with _cache_lock:
            cached, cached_at = _cache, _cache_at
        if cached is not None and (time.monotonic() - cached_at) < _cache_ttl():
            return cached

    catalog: Optional[IndustryCatalog] = None
    session = db
    owned = False
    if session is None:
        session, owned = SessionLocal(), True
    try:
        rows = _fetch_rows(session)
        if rows:
            catalog = _build_catalog(rows, from_db=True)
    except Exception as e:                       # 表不存在 / DB 不可用
        logger.warning("讀取行業分類字典失敗（%s），暫時改用內建種子資料", e)
    finally:
        if owned:
            session.close()

    if catalog is None:
        catalog = _build_catalog(_seed_rows(), from_db=False)

    with _cache_lock:
        _cache = catalog
        _cache_at = time.monotonic()
    return catalog


def get_industry_groups(db: Session | None = None) -> list[dict[str, Any]]:
    """取代舊 `INDUSTRY_GROUPS` 常數：[{label, value, subcategories:[...]}]。"""
    return [
        {"label": g["label"], "value": g["value"],
         "subcategories": [dict(s) for s in g["subcategories"]]}
        for g in load_catalog(db).groups
    ]


# ══════════════════════════════════════════════════════════════════════════════
# 種子資料寫入（冪等）
# ══════════════════════════════════════════════════════════════════════════════
def seed_categories(bind, *, commit: bool = False) -> int:
    """冪等寫入種子分類（已存在的 value 略過）。回傳新增筆數。

    bind 可為 Session（應用/腳本）或 Connection（Alembic migration）；
    Connection 模式只送 INSERT，交由外層交易提交。
    """
    tbl = KBIndustryCategory.__table__
    existing: dict[str, Optional[str]] = {
        value: cid for cid, value in
        bind.execute(select(tbl.c.id, tbl.c.value)).all()
    }
    created = 0
    for gi, group in enumerate(SEED_INDUSTRY_GROUPS):
        gid = existing.get(group["value"])
        if gid is None:
            gid = uuid.uuid4().hex
            bind.execute(tbl.insert().values(
                id=gid, value=group["value"], label=group["label"],
                description=None, parent_id=None, level=LEVEL_MAIN,
                source=SOURCE_SEED, is_active=True, sort_order=gi,
                created_by="system", created_date=_utcnow(), updated_date=_utcnow(),
            ))
            existing[group["value"]] = gid
            created += 1
        for si, sub in enumerate(group.get("subcategories") or []):
            if sub["value"] in existing:
                continue
            bind.execute(tbl.insert().values(
                id=uuid.uuid4().hex, value=sub["value"], label=sub["label"],
                description=None, parent_id=gid, level=LEVEL_SUB,
                source=SOURCE_SEED, is_active=True, sort_order=si,
                created_by="system", created_date=_utcnow(), updated_date=_utcnow(),
            ))
            existing[sub["value"]] = None
            created += 1
    if commit:
        bind.commit()
    return created


def ensure_seeded(db: Session | None = None) -> int:
    """冪等補齊種子分類（啟動或表為空時的修復）。例外不外拋。"""
    session = db
    owned = False
    if session is None:
        session, owned = SessionLocal(), True
    try:
        created = seed_categories(session, commit=owned)
        if created:
            invalidate_catalog_cache()
            logger.info("行業分類字典寫入 %d 筆種子資料", created)
        return created
    except Exception as e:
        logger.warning("寫入行業分類種子資料失敗（%s）", e)
        if owned:
            try:
                session.rollback()
            except Exception:
                pass
        return 0
    finally:
        if owned:
            session.close()


# ══════════════════════════════════════════════════════════════════════════════
# label 查詢
# ══════════════════════════════════════════════════════════════════════════════
def label_for_industry(value: str | None, db: Session | None = None) -> str:
    """依 industry value 回傳同級的 label；找不到回 ""。"""
    if not value:
        return ""
    return load_catalog(db).value_to_label.get(value, "")


def label_for_subcategory(industry_value: str | None, sub_value: str | None,
                          db: Session | None = None) -> str:
    """組合成「主分類.次分類」label（如「家庭電器.冷氣機」）。

    缺主分類或次分類時退化成另一方；兩者皆缺回 ""。
    """
    labels = load_catalog(db).value_to_label
    main = labels.get(industry_value or "", "")
    sub = labels.get(sub_value or "", "")
    if main and sub:
        return f"{main}.{sub}"
    return sub or main


# ══════════════════════════════════════════════════════════════════════════════
# Rule-based 分類（保留，供測試/參考）
# ══════════════════════════════════════════════════════════════════════════════
def _tokens(label: str) -> set[str]:
    parts = re.split(r"[/、,，\s]+", (label or "").strip())
    return {p for p in parts if p}


def _usable(token: str) -> bool:
    if len(token) < 2:
        return False
    # 純 ASCII 短詞（如 "it" / "tv"）太容易誤中，至少 3 字元才納入
    if token.isascii() and len(token) < 3:
        return False
    return True


def classify_industry(title: str = "", content: str = "",
                      db: Session | None = None) -> tuple[str, dict, list]:
    """回傳 (industry, industries, sub_industries)。

    - industry：單一 main group value；未識別回 ""。
    - industries：{"values": [main_value]}；未識別回 {"values": []}。
    - sub_industries：string array（如 ["HomeAppliance_AirCon"]）；未識別回 []。
    """
    text = f"{title or ''}\n{content or ''}".lower()

    best_value = ""
    best_score = 0
    best_subs: list[str] = []

    for group in load_catalog(db).groups:
        score = 0
        subs: list[tuple[int, str]] = []
        for sub in group["subcategories"]:
            hits = 0
            for token in _tokens(sub["label"]):
                if _usable(token) and token.lower() in text:
                    hits += 1
            if hits:
                score += hits
                subs.append((hits, sub["value"]))
        # main group label 作為較弱的訊號（商品正文較少直接出現「家庭電器」這類詞）
        for token in _tokens(group["label"]):
            if _usable(token) and token.lower() in text:
                score += 1

        if score > best_score:
            best_score = score
            best_value = group["value"]
            # 命中數降序（相同命中數保持字典序），確保只留最相關的 sub
            subs.sort(key=lambda x: (-x[0], x[1]))
            best_subs = [v for _, v in subs]

    if best_value:
        return (
            best_value,
            {"values": [best_value]},
            # ★ sub_industries 僅保留最相關的 1 個（格式仍為 array）
            best_subs[:1],
        )
    return "", {"values": []}, []


# ══════════════════════════════════════════════════════════════════════════════
# 分類驗證 + 自動新增（LLM 回傳未知分類時）
# ══════════════════════════════════════════════════════════════════════════════
def validate_category_value(raw: Any) -> tuple[bool, str, str]:
    """驗證分類代碼格式。回傳 (是否合法, 正規化後 value, 失敗原因)。"""
    if not isinstance(raw, str):
        return False, "", "分類代碼必須是字串"
    value = raw.strip()
    if not value:
        return False, "", "分類代碼不可為空"
    if len(value) > CATEGORY_VALUE_MAX_LEN:
        return False, value[:CATEGORY_VALUE_MAX_LEN], (
            f"分類代碼長度不可超過 {CATEGORY_VALUE_MAX_LEN} 字元")
    if not CATEGORY_VALUE_RE.match(value):
        return False, value, "分類代碼須為英文字母開頭，僅含英數與底線"
    return True, value, ""


def _write_logs(session: Session, entries: list[dict[str, Any]]) -> None:
    for e in entries:
        session.add(KBIndustryCategoryLog(
            id=uuid.uuid4().hex,
            category_id=e.get("category_id"),
            category_value=e["category_value"],
            category_label=e.get("category_label"),
            parent_value=e.get("parent_value"),
            action=e["action"],
            source=e["source"],
            reason=e.get("reason"),
            payload=e.get("payload"),
            created_by=e.get("created_by"),
            company_id=e.get("company_id"),
        ))


def _insert_category(session: Session, value: str, *, source: str,
                     created_by: str | None, company_id: int | None,
                     label: str | None = None) -> tuple[str, Optional[str]]:
    """新增單一分類。回傳 (新分類 id, 父分類 value)。

    次分類以底線前綴嘗試掛到既有主分類下（如 NewThing_A 掛到 NewThing）；
    找不到對應主分類時仍建立，但 parent_id 為 NULL。label 由 LLM 提供
    （繁體中文），未提供則退回 value 本身。
    """
    level = LEVEL_SUB if "_" in value else LEVEL_MAIN
    parent = None
    if level == LEVEL_SUB:
        prefix = value.split("_", 1)[0]
        # SessionLocal 為 autoflush=False：先 flush 讓同批次稍早新增的主分類可被查得
        session.flush()
        parent = (session.query(KBIndustryCategory)
                  .filter(KBIndustryCategory.value == prefix,
                          KBIndustryCategory.parent_id.is_(None))
                  .first())
    row = KBIndustryCategory(
        id=uuid.uuid4().hex, value=value,
        label=(label or value).strip() or value,
        description=AUTO_CATEGORY_DESCRIPTION,
        parent_id=parent.id if parent is not None else None,
        level=level, source=source, is_active=True,
        sort_order=AUTO_CATEGORY_SORT_ORDER,
        created_by=created_by, company_id=company_id,
    )
    session.add(row)
    return row.id, (parent.value if parent is not None else None)


def _persist_registrations(
    db: Session | None, values: list[str], log_entries: list[dict[str, Any]],
    *, source: str, created_by: str | None, company_id: int | None,
    label_map: dict[str, str] | None = None,
) -> list[str]:
    """寫入新分類與日誌，回傳實際新增成功的 value 清單。

    有外部 session → 以 SAVEPOINT 包住（失敗只回滾本次新增，不影響呼叫方交易）；
    無外部 session → 自建 session 並獨立提交，確保稽核日誌落地。
    """

    def _apply(session: Session) -> list[str]:
        created: list[str] = []
        for value in values:
            category_id, parent_value = _insert_category(
                session, value, source=source,
                created_by=created_by, company_id=company_id,
                label=(label_map or {}).get(value) if label_map else None)
            created.append(value)
            for entry in log_entries:
                if (entry["action"] == ACTION_CREATED
                        and entry["category_value"] == value):
                    entry["category_id"] = category_id
                    entry["parent_value"] = parent_value
        _write_logs(session, log_entries)
        session.flush()
        return created

    if db is not None:
        try:
            with db.begin_nested():
                return _apply(db)
        except Exception as e:
            logger.warning("自動新增行業分類失敗（%s），已回滾本次新增", e)
            return []

    session = SessionLocal()
    try:
        created = _apply(session)
        session.commit()
        return created
    except Exception as e:
        session.rollback()
        logger.warning("自動新增行業分類失敗（%s），已回滾", e)
        return []
    finally:
        session.close()


def verify_and_register_categories(
    db: Session | None,
    values: Iterable[Any],
    *,
    source: str = SOURCE_LLM_AUTO,
    created_by: str | None = None,
    company_id: int | None = None,
    label_map: dict[str, str] | None = None,
) -> list[str]:
    """檢查分類是否存在於字典；不存在者驗證後自動新增並寫入稽核日誌。

    回傳「最終可用」的分類代碼（已存在或成功新增）；格式不合法 / 自動新增
    被停用 / 寫入失敗者會被排除。外部 session 模式下由呼叫方提交交易。
    """
    catalog = load_catalog(db)
    # 大小寫不敏感索引（避免重複新增，如 homeappliance vs HomeAppliance）
    lower_index = {known.lower(): known for known in catalog.by_value}

    result: list[str] = []
    pending: list[str] = []
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()

    for raw in values:
        ok, value, reason = validate_category_value(raw)
        if not ok:
            entries.append({
                "category_value": value or str(raw)[:CATEGORY_VALUE_MAX_LEN],
                "action": ACTION_INVALID, "source": source, "reason": reason,
                "payload": {"raw": raw if isinstance(raw, (str, int, float)) else None},
                "created_by": created_by, "company_id": company_id,
            })
            continue
        if value in seen:
            continue
        seen.add(value)

        if value in catalog.by_value:
            result.append(value)
            continue
        duplicate = lower_index.get(value.lower())
        if duplicate is not None:
            # 避免重複添加：沿用既有分類（僅大小寫不同）
            entries.append({
                "category_value": value, "category_label": duplicate,
                "action": ACTION_DUPLICATE, "source": source,
                "reason": f"已存在大小寫不敏感的同義分類 {duplicate}，不重複新增",
                "payload": {"value": value, "existing_value": duplicate},
                "created_by": created_by, "company_id": company_id,
            })
            result.append(duplicate)
            continue
        if not settings.industry_auto_register_enabled:
            entries.append({
                "category_value": value, "action": ACTION_DISABLED,
                "source": source, "reason": "自動新增分類功能已停用",
                "payload": {"value": value},
                "created_by": created_by, "company_id": company_id,
            })
            continue
        pending.append(value)
        entries.append({
            "category_value": value,
            "category_label": (label_map or {}).get(value) or value,
            "action": ACTION_CREATED, "source": source,
            "reason": "LLM 回傳字典中不存在的分類，已自動新增",
            "payload": {"value": value,
                        "label": (label_map or {}).get(value) or value},
            "created_by": created_by, "company_id": company_id,
        })

    if pending or entries:
        created = _persist_registrations(
            db, pending, entries, source=source,
            created_by=created_by, company_id=company_id,
            label_map=label_map)
        if created:
            invalidate_catalog_cache()
            logger.info("自動新增行業分類：%s（來源=%s）", created, source)
        result.extend(created)
    return result


# ══════════════════════════════════════════════════════════════════════════════
# AI（LLM）分類：prompt / schema / 結果正規化
# ══════════════════════════════════════════════════════════════════════════════
def build_classification_prompt(title: str = "", content: str = "",
                                db: Session | None = None) -> str:
    """建立 AI 分類 prompt，內嵌資料庫中的分類字典（value 必須原樣回傳）。"""
    options = json.dumps(get_industry_groups(db), ensure_ascii=False)
    text = f"{title or ''}\n{content or ''}".strip()
    return (
        "你是電商知識庫的行業分類器。請判斷下方內容最符合的行業。\n"
        "行業字典（value 必須原樣回傳，label 僅供人類參考）：\n"
        f"{options}\n\n"
        "待分類內容：\n"
        f"{text[:4000] or '(空)'}\n\n"
        "要求：\n"
        "1. industry 必須是字典中某個「主分類」的 value（例如 \"HomeAppliance\"）。\n"
        "2. sub_industries 是該主分類底下「次分類」的 value 字串陣列，"
        "例如 [\"HomeAppliance_AirCon\"]，可為空陣列。\n"
        "3. 若無法判斷，industry 回空字串 \"\"、sub_industries 回空陣列 []。\n"
        "4. 若字典已有高度接近的主分類，industry 選用該主分類；次分類優先從字典中選。\n"
        "5. 當字典的該主分類底下「沒有」可供描述的次分類時，可提出新的次分類：\n"
        "     - sub_industries 仍需加入它的 value（格式「主分類英文代碼_新詞英數底線」，"
        "例如 \"HomeAppliance_VentilationFan\"）；\n"
        "     - 同時在 new_sub_industries 以物件 {value, label} 提供同一 value 與對應的"
        "繁體中文 label（例如 {\"value\": \"HomeAppliance_VentilationFan\", "
        "\"label\": \"通風扇/抽氣扇\"}）。\n"
        "     - 只在確實缺少時才提出，不要為了填滿而自創；"
        "若有能對應的既有次分類則一律優先沿用，不要放進 new_sub_industries。\n"
        "     - 既有次分類不得出現在 new_sub_industries，只有字典中不存在的新代碼才可放入。"
    )


def normalize_classification_result(
    result: Any,
    db: Session | None = None,
    *,
    source: str = SOURCE_LLM_AUTO,
    created_by: str | None = None,
    company_id: int | None = None,
) -> tuple[str, dict, list]:
    """把 LLM 回傳結果收斂成 (industry, industries, sub_industries)。

    值必須存在於 kb_industry_category；LLM 回傳字典中不存在的分類時，
    先經驗證自動新增到資料庫（並寫入日誌），再納入結果。
    非法或缺失回空。
    """
    if not isinstance(result, dict):
        return "", {"values": []}, []

    industry = result.get("industry")
    subs = result.get("sub_industries")
    if not isinstance(industry, str):
        industry = ""
    if not isinstance(subs, list):
        subs = []
    industry = industry.strip()
    raw_subs = [s.strip() for s in subs if isinstance(s, str) and s.strip()]

    # ── 解析 LLM 提出的新次分類（附繁體中文 label）──
    label_map: dict[str, str] = {}
    new_items = result.get("new_sub_industries")
    if isinstance(new_items, list):
        for item in new_items:
            if not isinstance(item, dict):
                continue
            v, l = item.get("value"), item.get("label")
            if isinstance(v, str) and v.strip():
                raw_subs.append(v)
                if isinstance(l, str) and l.strip():
                    label_map[v.strip()] = l.strip()

    # ── 分類驗證 + 未知分類自動新增 ──
    candidates = ([industry] if industry else []) + raw_subs
    if candidates:
        accepted = set(verify_and_register_categories(
            db, candidates, source=source,
            created_by=created_by, company_id=company_id,
            label_map=label_map))
    else:
        accepted = set()

    catalog = load_catalog(db, force=True)

    valid_subs = [s for s in raw_subs
                  if s in accepted and s in catalog.sub_values]

    # industry 非法時，嘗試從合法次分類反推主分類
    if industry not in catalog.main_values:
        industry = catalog.sub_to_main[valid_subs[0]] if valid_subs else ""

    # 只保留隸屬該主分類的次分類
    if industry:
        valid_subs = [s for s in valid_subs
                      if catalog.sub_to_main.get(s) == industry]

    # ★ sub_industries 僅保留最相關的 1 個（格式仍為 array）
    return industry, {"values": [industry] if industry else []}, valid_subs[:1]
