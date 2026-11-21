"""
通用 Entity CRUD router — 取代 base44.entities.X.*

為 39 個 production entity 各生成 9 個端點：
  list / filter / get / create / update / delete / bulkCreate / bulkUpdate / deleteMany

雙路徑：
  /api/entities/{Entity}
  /api/apps/{APP_ID}/entities/{Entity}
"""
from __future__ import annotations
import json
from typing import Any

from fastapi import APIRouter, Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from app.core.auth import AuthContext, get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.models import ALL_MODELS
from app.repositories.base import Repository

# ── 為每個 model 建 repository ──
REPOS: dict[str, Repository] = {
    m.__name__: Repository(m, m.__name__) for m in ALL_MODELS
}

RESERVED = {"_sort", "_limit", "_skip", "sort", "limit", "skip"}


def _parse_qp(qp: dict, repo: Repository) -> dict:
    return {k: v for k, v in qp.items()
            if k in repo.cols and k not in RESERVED}


def build_entity_router(name: str, repo: Repository, prefix: str) -> APIRouter:
    r = APIRouter(prefix=f"{prefix}/{name}", tags=[f"entity:{name}"])

    @r.get("")
    def list_(request: Request, db=Depends(get_db),
              user: AuthContext = Depends(get_current_user)):
        qp = dict(request.query_params)
        sort = qp.get("_sort") or qp.get("sort")
        filters = _parse_qp(qp, repo)
        # Base44 兼容：前端用 ?q={JSON} 传过滤条件（与旧版 knowledge-base 一致）
        if "q" in qp:
            try:
                q_filters = json.loads(qp["q"])
            except (ValueError, TypeError):
                raise HTTPException(400, "q must be JSON")
            if not isinstance(q_filters, dict):
                raise HTTPException(400, "q must be a JSON object")
            # 前端发 batch_id，但 KBImportBatch 主键是 id
            if "batch_id" in q_filters and "batch_id" not in repo.cols:
                q_filters["id"] = q_filters.pop("batch_id")
            filters.update(q_filters)

        # ★ 分頁模式：请求带 page / pageSize（page_size 亦可）才回分頁包裝；
        #   不带则维持纯数组（向后兼容，不影响旧调用方）。
        if any(p in qp for p in ("page", "pageSize", "page_size")):
            try:
                page = int(qp.get("page") or 1)
                page_size = int(qp.get("pageSize") or qp.get("page_size") or 20)
            except ValueError:
                raise HTTPException(400, "page/pageSize must be integers")
            if page < 1:
                raise HTTPException(400, "page must be >= 1")
            if not 1 <= page_size <= 500:
                raise HTTPException(400, "pageSize must be within 1..500")
            total = repo.count(db, user, filters=filters)
            rows = repo.list(db, user, filters=filters, sort=sort,
                             limit=page_size, skip=(page - 1) * page_size)
            return {"items": rows, "total": total,
                    "page": page, "pageSize": page_size}

        limit = int(qp.get("_limit") or qp.get("limit") or 1000)
        skip = int(qp.get("_skip") or qp.get("skip") or 0)
        return repo.list(db, user, filters=filters, sort=sort,
                         limit=limit, skip=skip)

    @r.post("/query")
    def query_(payload: dict = Body(default_factory=dict), db=Depends(get_db),
               user: AuthContext = Depends(get_current_user)):
        """複雜 filter（含 $in 等操作符）用 POST body。"""
        filters = payload.get("filters") or payload.get("where") or {}
        return repo.list(db, user, filters=filters,
                         sort=payload.get("sort"),
                         limit=payload.get("limit", 1000),
                         skip=payload.get("skip", 0))

    # ★ /bulk 與 /delete-many 必須在 /{rid} 之前註冊，否則 {rid} 會吃掉 "bulk"
    @r.post("/bulk")
    def bulk_create_(payload: Any = Body(...), db=Depends(get_db),
                     user: AuthContext = Depends(get_current_user)):
        records = payload if isinstance(payload, list) \
            else (payload or {}).get("records", [])
        return repo.bulk_create(db, user, records)

    @r.patch("/bulk")
    def bulk_update_patch(payload: Any = Body(...), db=Depends(get_db),
                          user: AuthContext = Depends(get_current_user)):
        records = payload if isinstance(payload, list) \
            else (payload or {}).get("records", [])
        return repo.bulk_update(db, user, records)

    @r.put("/bulk")
    def bulk_update_put(payload: Any = Body(...), db=Depends(get_db),
                        user: AuthContext = Depends(get_current_user)):
        records = payload if isinstance(payload, list) \
            else (payload or {}).get("records", [])
        return repo.bulk_update(db, user, records)

    @r.post("/delete-many")
    def delete_many_(payload: dict = Body(default_factory=dict), db=Depends(get_db),
                     user: AuthContext = Depends(get_current_user)):
        return repo.delete_many(db, user, payload)

    @r.delete("")
    def delete_many_del(payload: dict = Body(default_factory=dict), db=Depends(get_db),
                        user: AuthContext = Depends(get_current_user)):
        return repo.delete_many(db, user, payload)

    # ── 單筆（{rid} 動態段放最後）──
    @r.get("/{rid}")
    def get_(rid: str, db=Depends(get_db),
             user: AuthContext = Depends(get_current_user)):
        return repo.get(db, user, rid)

    @r.post("")
    def create_(payload: dict = Body(...), db=Depends(get_db),
                user: AuthContext = Depends(get_current_user)):
        return repo.create(db, user, payload)

    @r.patch("/{rid}")
    def patch_(rid: str, payload: dict = Body(...), db=Depends(get_db),
               user: AuthContext = Depends(get_current_user)):
        return repo.update(db, user, rid, payload)

    @r.put("/{rid}")
    def put_(rid: str, payload: dict = Body(...), db=Depends(get_db),
             user: AuthContext = Depends(get_current_user)):
        return repo.update(db, user, rid, payload)

    @r.delete("/{rid}")
    def delete_(rid: str, db=Depends(get_db),
                user: AuthContext = Depends(get_current_user)):
        repo.delete(db, user, rid)
        return JSONResponse(status_code=204, content=None)

    return r


def register_entity_routes(app: FastAPI) -> None:
    prefixes = ["/api/entities", f"/api/apps/{settings.app_id}/entities"]
    for prefix in prefixes:
        for name, repo in REPOS.items():
            app.include_router(build_entity_router(name, repo, prefix))
