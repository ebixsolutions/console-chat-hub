"""行業分類公共 API（無需 token 驗證）。

提供對外開放的行業分類字典查詢端點，供前端 / 第三方系統直接取用：

  GET /api/v1/public/industry-categories              分類清單（主分類含次分類）
  GET /api/v1/public/industry-categories/{value}      單一分類詳情

設計要點：
  - ★ 不掛載任何認證依賴（無 Authorization / api_key），標籤為 public。
  - 資料一律來自資料庫表 kb_industry_category（見 migration 0008）。
  - 統一 JSON 封套：{"success": bool, "data": ..., "meta": ...}；
    錯誤為 {"success": false, "error": {"code", "message"}}。
  - 參數以 FastAPI Query 驗證；資料庫不可用時回 503。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import KBIndustryCategory

logger = logging.getLogger("nexus_kb.industry_public")

router = APIRouter(prefix="/api/v1/public", tags=["public-industry"])

MAX_Q_LEN = 64


# ══════════════════════════════════════════════════════════════════════════
# Pydantic 模型（同時作為 OpenAPI 文件 schema）
# ══════════════════════════════════════════════════════════════════════════
class IndustryCategoryItem(BaseModel):
    id: str = Field(..., description="分類唯一識別碼")
    value: str = Field(..., description="分類代碼（唯一，供程式引用，如 HomeAppliance）")
    label: str = Field(..., description="分類名稱（如 家庭電器）")
    description: Optional[str] = Field(None, description="分類說明，未填為 null")
    parent_id: Optional[str] = Field(None, description="父分類 id；主分類為 null")
    parent_value: Optional[str] = Field(None, description="父分類代碼；主分類為 null")
    level: int = Field(..., description="層級：1=主分類、2=次分類")
    sort_order: int = Field(0, description="排序權重（升冪）")
    source: str = Field("seed", description="來源：seed（內建）/ llm_auto（LLM 自動新增）/ manual")
    is_active: bool = Field(True, description="是否啟用；停用分類預設不回傳")
    subcategories: list["IndustryCategoryItem"] = Field(
        default_factory=list, description="所屬次分類（僅主分類會填入；次分類恆為空陣列）")


class CategoryListMeta(BaseModel):
    total: int = Field(..., description="回傳筆數（含嵌套的次分類）")
    level: Optional[int] = Field(None, description="實際套用的層級篩選")
    parent: Optional[str] = Field(None, description="實際套用的父分類代碼篩選")
    q: Optional[str] = Field(None, description="實際套用的關鍵字篩選")
    include_inactive: bool = Field(False, description="是否包含停用分類")
    generated_at: str = Field(..., description="回應產生時間（UTC, ISO 8601）")


class IndustryCategoryListResponse(BaseModel):
    success: bool = Field(True, description="固定為 true")
    data: list[IndustryCategoryItem] = Field(..., description="分類清單")
    meta: CategoryListMeta = Field(..., description="查詢條件與筆數後設資料")


class IndustryCategoryDetailResponse(BaseModel):
    success: bool = Field(True, description="固定為 true")
    data: IndustryCategoryItem = Field(..., description="分類詳情")


class ErrorBody(BaseModel):
    code: str = Field(..., description="錯誤代碼（invalid_request / category_not_found / catalog_unavailable）")
    message: str = Field(..., description="錯誤訊息")


class IndustryCategoryErrorResponse(BaseModel):
    success: bool = Field(False, description="固定為 false")
    error: ErrorBody = Field(..., description="錯誤內容")


_ERROR_RESPONSES = {
    404: {"model": IndustryCategoryErrorResponse, "description": "找不到指定分類"},
    422: {"description": "請求參數驗證失敗（FastAPI 標準格式：{\"detail\": [...]}）"},
    503: {"model": IndustryCategoryErrorResponse, "description": "分類字典暫時無法取得"},
}


# ══════════════════════════════════════════════════════════════════════════
# 內部工具
# ══════════════════════════════════════════════════════════════════════════
def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status,
                        content={"success": False,
                                 "error": {"code": code, "message": message}})


def _level_of(row: KBIndustryCategory) -> int:
    if row.level is None:
        return 2 if row.parent_id else 1
    return int(row.level)


def _to_item(row: KBIndustryCategory, parent_value: Optional[str]) -> dict:
    return {
        "id": row.id,
        "value": row.value,
        "label": row.label,
        "description": row.description,
        "parent_id": row.parent_id,
        "parent_value": parent_value,
        "level": _level_of(row),
        "sort_order": int(row.sort_order or 0),
        "source": row.source or "seed",
        "is_active": row.is_active is not False,
        "subcategories": [],
    }


def _fetch_active(db: Session, include_inactive: bool) -> list[KBIndustryCategory]:
    query = db.query(KBIndustryCategory)
    if not include_inactive:
        query = query.filter(KBIndustryCategory.is_active.isnot(False))
    return (query.order_by(KBIndustryCategory.sort_order.asc(),
                           KBIndustryCategory.value.asc())
            .all())


def _matches_q(row: KBIndustryCategory, q: str) -> bool:
    needle = q.strip().lower()
    return needle in (row.label or "").lower() or needle in (row.value or "").lower()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ══════════════════════════════════════════════════════════════════════════
# 端點：分類清單
# ══════════════════════════════════════════════════════════════════════════
@router.get(
    "/industry-categories",
    response_model=IndustryCategoryListResponse,
    responses=_ERROR_RESPONSES,
    summary="取得行業分類清單（公開）",
    description=(
        "回傳行業分類字典。預設回傳全部「主分類」，並在 `subcategories` 帶出其下「次分類」。\n\n"
        "- `level=2` 或指定 `parent` 時，回傳的為次分類（其 `subcategories` 為空陣列）。\n"
        "- `q` 以不分大小寫的子字串比對 `label` 與 `value`。\n"
        "- 停用分類（`is_active=false`）預設不回傳，可用 `include_inactive=true` 納入。\n\n"
        "★ 本端點為公開端點，無需 Authorization token 或 api_key。"
    ),
)
def list_industry_categories(
    level: Optional[int] = Query(
        None, ge=1, le=2,
        description="層級篩選：1=僅主分類、2=僅次分類；未給則回傳主分類（含次分類）"),
    parent: Optional[str] = Query(
        None, min_length=1, max_length=64,
        description="父分類代碼（value），回傳該主分類下的次分類"),
    q: Optional[str] = Query(
        None, max_length=MAX_Q_LEN,
        description="關鍵字，不分大小寫比對分類代碼與名稱"),
    include_inactive: bool = Query(
        False, description="是否包含已停用分類"),
    db: Session = Depends(get_db),
):
    try:
        rows = _fetch_active(db, include_inactive)
    except Exception as e:
        logger.warning("公共 API 讀取行業分類失敗：%s", e)
        return _err(503, "catalog_unavailable", "行業分類字典暫時無法取得，請稍後再試")

    value_by_id = {r.id: r.value for r in rows}
    q_norm = (q or "").strip() or None

    parent_row: Optional[KBIndustryCategory] = None
    if parent:
        parent_row = next((r for r in rows if r.value == parent), None)
        if parent_row is None:
            return _err(404, "category_not_found", f"找不到父分類 {parent}")

    if parent_row is not None:
        selected = [r for r in rows if r.parent_id == parent_row.id]
    elif level is not None:
        selected = [r for r in rows if _level_of(r) == level]
    else:
        selected = [r for r in rows if _level_of(r) == 1]

    if q_norm:
        selected = [r for r in selected if _matches_q(r, q_norm)]

    # 主分類才組裝次分類（次分類的 subcategories 恆為空）
    children_by_parent: dict[str, list[KBIndustryCategory]] = {}
    for r in rows:
        if r.parent_id:
            children_by_parent.setdefault(r.parent_id, []).append(r)

    items: list[dict] = []
    for r in selected:
        item = _to_item(r, value_by_id.get(r.parent_id) if r.parent_id else None)
        if _level_of(r) == 1:
            children = children_by_parent.get(r.id, [])
            if q_norm:
                children = [c for c in children if _matches_q(c, q_norm)]
            item["subcategories"] = [
                _to_item(c, r.value) for c in children
            ]
        items.append(item)

    total = sum(1 + len(i["subcategories"]) for i in items)
    return {
        "success": True,
        "data": items,
        "meta": {
            "total": total,
            "level": level,
            "parent": parent,
            "q": q_norm,
            "include_inactive": include_inactive,
            "generated_at": _now_iso(),
        },
    }


# ══════════════════════════════════════════════════════════════════════════
# 端點：分類詳情
# ══════════════════════════════════════════════════════════════════════════
@router.get(
    "/industry-categories/{value}",
    response_model=IndustryCategoryDetailResponse,
    responses=_ERROR_RESPONSES,
    summary="取得單一行業分類詳情（公開）",
    description=(
        "依分類代碼 `value` 回傳單一分類。若為主分類，`subcategories` 會帶出其下"
        "所有次分類（受 `include_inactive` 控制）。\n\n"
        "★ 本端點為公開端點，無需 Authorization token 或 api_key。"
    ),
)
def get_industry_category(
    value: str = Path(..., min_length=1, max_length=64,
                      description="分類代碼（value），如 HomeAppliance"),
    include_inactive: bool = Query(False, description="是否包含已停用的次分類"),
    db: Session = Depends(get_db),
):
    try:
        rows = _fetch_active(db, include_inactive)
    except Exception as e:
        logger.warning("公共 API 讀取行業分類失敗：%s", e)
        return _err(503, "catalog_unavailable", "行業分類字典暫時無法取得，請稍後再試")

    row = next((r for r in rows if r.value == value), None)
    if row is None:
        return _err(404, "category_not_found", f"找不到分類 {value}")

    value_by_id = {r.id: r.value for r in rows}
    item = _to_item(row, value_by_id.get(row.parent_id) if row.parent_id else None)
    if _level_of(row) == 1:
        item["subcategories"] = [
            _to_item(c, row.value) for c in rows if c.parent_id == row.id
        ]
    return {"success": True, "data": item}
