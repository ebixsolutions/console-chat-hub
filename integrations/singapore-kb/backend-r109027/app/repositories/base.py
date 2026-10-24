"""
Repository 層 — 統一 CRUD + tenant isolation（取代 Base44 平台 RLS）

隔離模型（依 08-04 schema 實測）：
  TENANT_SCOPED    有 tenant_id：KBPublishOperation, KBAuditEvent,
                   KBUserPublishConfirmation → 強制 tenant 過濾，跨租戶 fail-closed
  OWNER_SCOPED     有 created_by：KBDocument, KBDocumentVersion, KBImportBatch,
                   TemplateGenerationJob, WebsiteImportJob → 預設全租戶可讀，
                   寫入記 created_by（KB 是協作知識庫，讀不隔離、審計靠 created_by）
  GLOBAL           無 ownership：config / registry / platform LLM → 全域共享

查詢語意保留：
  - list/filter 預設 -created_date 排序
  - 查無回 []（非 404）
  - filter 支援 $in / $nin / $gte / $lte / $gt / $lt / $ne
  - bulkUpdate 裸 array（每元素含 id）
  - deleteMany 查詢條件語意（非 ids）
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Any, Optional, Type

from fastapi import HTTPException
from sqlalchemy import String
from sqlalchemy.orm import Session

from app.models import Base, TemplateGenerationJob
from app.models.enums import ENTITY_ENUMS
from app.services.industry_groups import label_for_industry

# ── 隔離分類 ──
# GLOBAL：平台級共享 config / registry / logs（跨租戶共用，非業務資料）
GLOBAL_ENTITIES = {
    "PlatformLLMCreditBudget", "PlatformLLMModelOption",
    "PlatformLLMProviderConfig", "PlatformLLMRoutingPolicy",
    "PlatformLLMRequestLog", "PlatformLLMRoutingDecisionLog",
    "KBConfig", "FirecrawlConfig",
    "IndustryTemplateSkeleton",
    "WebsiteContentCleaningRule", "KBIndustryTemplate", "User",
}
# COMPANY_SCOPED_ONLY：只按 company_id 隔離、不套 tenant 隔離。
# system 範本 company_id=0、tenant_id=NULL；company/new 複製後 tenant_id 保留建立者值，
# 與搜尋者 tenant 未必一致 → 硬套 tenant 過濾會查不到。
COMPANY_SCOPED_ONLY = {"KBAgentRegistry", "KBCategorySchema"}
# 其餘全部視為 TENANT_SCOPED（KB 業務資料），用 user.tenant_id 隔離。
IMMUTABLE = {"KBAuditEvent"}                       # 禁止 update/delete


def _now():
    return datetime.now(timezone.utc)


def _new_id():
    return uuid.uuid4().hex


def _cols(model) -> set[str]:
    return {c.name for c in model.__table__.columns}


# 需依 industry value 附帶同級 label 的 entity
INDUSTRY_LABEL_ENTITIES = {"KBImportItem", "KBDocument"}


def _row(obj) -> dict:
    if obj is None:
        return None
    out = {}
    for c in obj.__table__.columns:
        v = getattr(obj, c.name)
        if isinstance(v, datetime):
            v = v.isoformat()
        out[c.name] = v
    if type(obj).__name__ in INDUSTRY_LABEL_ENTITIES:
        out["sub_industry_label"] = label_for_industry(out.get("industry"))
    return out


def _norm_industries(v):
    """industries 必須 dict：array → {"values":[...]}；None → {"values":[]}"""
    if isinstance(v, dict):
        return v
    if isinstance(v, list):
        return {"values": v}
    return {"values": []}


def _norm_sub_industries(v):
    """sub_industries 必須 string array：dict → 取 values；None → []"""
    if isinstance(v, list):
        return [x for x in v if isinstance(x, str)]
    if isinstance(v, dict):
        vals = v.get("values") or []
        return [x for x in vals if isinstance(x, str)]
    return []


def _normalize_industry_fields(data: dict) -> None:
    """KBImportItem/KBDocument 的行業 JSONB 欄位統一正規化。

    industries 保持 dict 格式；sub_industries 為 string array。
    """
    if "industries" in data:
        data["industries"] = _norm_industries(data["industries"])
    if "sub_industries" in data:
        data["sub_industries"] = _norm_sub_industries(data["sub_industries"])


def _validate_industry_fields(name: str, data: dict) -> None:
    """KBImportItem/KBDocument 的 industry / sub_industries 寫入驗證。

    - industry：非空字串
    - sub_industries：非空 string array
    （僅在欄位出現於 payload 時驗證，避免破壞 PATCH 局部更新語意。）
    """
    if name not in INDUSTRY_LABEL_ENTITIES:
        return
    if "industry" in data:
        v = data["industry"]
        if not isinstance(v, str) or not v.strip():
            raise HTTPException(422, "industry must be a non-empty string")
    if "sub_industries" in data:
        v = data["sub_industries"]
        if (not isinstance(v, list) or not v
                or not all(isinstance(x, str) and x.strip() for x in v)):
            raise HTTPException(
                422, "sub_industries must be a non-empty array of strings")


def _content_hash(text: str) -> str:
    """與 kb_services.hash_content / publish_candidate_adapter 相同的 canonical hash。"""
    import hashlib
    return hashlib.sha256((text or "").strip().encode("utf-8")).hexdigest()


def _kbdocument_version_snapshot(db: Session, doc, content: str,
                                 summary: str, actor_id: Optional[str] = None) -> None:
    """內容覆寫前留一份歷史快照（P0-01/P1-01：草稿存檔必須產生 edit 版本行）。"""
    from app.models import KBDocumentVersion
    db.add(KBDocumentVersion(
        id=_new_id(),
        document_id=doc.id,
        version=doc.version or "1.0",
        version_type="minor",
        change_type="content_edit",
        change_summary=summary or "草稿編輯儲存",
        raw_content_snapshot=(content or "")[:10000],
        snapshot_reason="content_edit_snapshot",
        content_hash=_content_hash(content or ""),
        review_status="pending",
        vector_status="not_generated",
        created_by=actor_id or getattr(doc, "created_by", None) or "version_service",
        created_date=_now(),
    ))


class Repository:
    """單一 entity 的 tenant-aware CRUD。"""

    def __init__(self, model: Type[Base], name: str):
        self.model = model
        self.name = name
        self.cols = _cols(model)
        # 除 GLOBAL 平台 config 外，凡有 tenant_id / company_id 欄位者一律隔離
        # （COMPANY_SCOPED_ONLY 只套 company_id、不套 tenant）
        self.tenant_scoped = (name not in GLOBAL_ENTITIES
                              and "tenant_id" in self.cols
                              and name not in COMPANY_SCOPED_ONLY)
        self.company_scoped = (name not in GLOBAL_ENTITIES
                               and "company_id" in self.cols)
        self.immutable = name in IMMUTABLE
        self.enums = ENTITY_ENUMS.get(name, {})

    def _validate_enums(self, data: dict):
        """寫入時強制 enum（回應 QA gap B：enum 真實 enforcement，非僅註解）。"""
        for field, allowed in self.enums.items():
            if field in data and data[field] is not None and data[field] != "":
                if data[field] not in allowed:
                    raise HTTPException(
                        422, f"invalid enum value for {self.name}.{field}: "
                             f"{data[field]!r} not in {allowed}")

    # ── 隔離過濾（用 tenant_id / company_id，只有 service-role 可跨租戶）──
    def _scope(self, query, user):
        if self.tenant_scoped and not getattr(user, "is_service_role", False):
            query = query.filter(self.model.tenant_id == user.tenant_id)
        if (self.company_scoped
                and not getattr(user, "is_service_role", False)
                and getattr(user, "company_id", None)):
            query = query.filter(self.model.company_id == user.company_id)
        return query

    def _owns(self, obj, user) -> bool:
        if not self.tenant_scoped and not self.company_scoped:
            return True
        if getattr(user, "is_service_role", False):
            return True
        tenant_ok = (not self.tenant_scoped
                     or getattr(obj, "tenant_id", None) == user.tenant_id)
        company_ok = (not self.company_scoped
                      or not getattr(user, "company_id", None)
                      or getattr(obj, "company_id", None) == user.company_id)
        return tenant_ok and company_ok

    # ── filter 操作符 ──
    def _apply_filters(self, query, filters: dict):
        for k, v in (filters or {}).items():
            if k not in self.cols:
                continue
            col = getattr(self.model, k)
            if isinstance(v, dict):
                if "$in" in v:   query = query.filter(col.in_(v["$in"]))
                if "$nin" in v:  query = query.filter(~col.in_(v["$nin"]))
                if "$gte" in v:  query = query.filter(col >= v["$gte"])
                if "$lte" in v:  query = query.filter(col <= v["$lte"])
                if "$gt" in v:   query = query.filter(col > v["$gt"])
                if "$lt" in v:   query = query.filter(col < v["$lt"])
                if "$ne" in v:   query = query.filter(col != v["$ne"])
                # 模糊查詢（不分大小寫子字串）；對 JSONB 欄位 cast 成 text 後比對
                if "$contains" in v:
                    query = query.filter(
                        col.cast(String).ilike(f"%{v['$contains']}%")
                    )
            else:
                query = query.filter(col == v)
        return query

    def _sort(self, query, sort: Optional[str]):
        s = sort or "-created_date"
        desc = s.startswith("-")
        field = s[1:] if desc else s
        if field not in self.cols:
            field = "created_date" if "created_date" in self.cols else None
        if not field:
            return query
        col = getattr(self.model, field)
        return query.order_by(col.desc() if desc else col.asc())

    # ── IndustryTemplateSkeleton 特有：附帶最新「未存稿」draft id 與檔案數 ──
    def _attach_skeleton_draft_info(self, db: Session, user, rows: list[dict]) -> list[dict]:
        """依每筆 skeleton 的 industry_key 查 kb_template_generation_job，
        取尚未存稿（kb_import_batch_id 為 NULL）的最新一筆，附上：
          - unsaved_draft_id：該 job 的 id
          - unsaved_draft_file_count：該 job 的 total_templates

        查詢沿用 TemplateGenerationJob 自身 Repository 的 tenant/company 隔離
        （與其 list 端點語意一致），避免跨租戶/跨公司撈到別人的草稿。
        """
        keys = {r.get("industry_key") for r in rows if r.get("industry_key")}
        best: dict[str, TemplateGenerationJob] = {}
        if keys:
            job_repo = Repository(TemplateGenerationJob, "TemplateGenerationJob")
            q = job_repo._scope(db.query(TemplateGenerationJob), user)
            jobs = (q.filter(TemplateGenerationJob.industry_key.in_(keys),
                             TemplateGenerationJob.kb_import_batch_id.is_(None))
                    .order_by(TemplateGenerationJob.created_date.desc())
                    .all())
            # created_date 已降冪排序 → 每 industry 取第一筆即為最新未存稿
            for j in jobs:
                best.setdefault(j.industry_key, j)
        for r in rows:
            j = best.get(r.get("industry_key"))
            r["unsaved_draft_id"] = j.id if j else None
            r["unsaved_draft_file_count"] = j.total_templates if j else None
        return rows

    # ── 公開 API ──
    def list(self, db: Session, user, *, filters=None, sort=None,
             limit=1000, skip=0) -> list[dict]:
        q = db.query(self.model)
        q = self._scope(q, user)
        q = self._apply_filters(q, filters or {})
        q = self._sort(q, sort)
        rows = q.offset(skip).limit(limit).all()
        result = [_row(o) for o in rows]      # 查無回 []
        if self.model.__name__ == "IndustryTemplateSkeleton":
            result = self._attach_skeleton_draft_info(db, user, result)
        return result

    def count(self, db: Session, user, *, filters=None) -> int:
        """符合隔離 scope + filters 的總筆數（分頁 total 用）。"""
        q = db.query(self.model)
        q = self._scope(q, user)
        q = self._apply_filters(q, filters or {})
        return q.count()

    def get(self, db: Session, user, rid: str) -> dict:
        # User/me：以 JWT sub（integer）查 system_users，與 Base44 舊版一致
        if self.name == "User" and rid == "me":
            try:
                rid = int(user.id)
            except (TypeError, ValueError):
                raise HTTPException(404, "Not found1")
        o = db.query(self.model).filter(self.model.id == rid).first()
        if not o or not self._owns(o, user):
            raise HTTPException(404, "Not found")   # fail-closed
        result = _row(o)
        if self.model.__name__ == "IndustryTemplateSkeleton":
            self._attach_skeleton_draft_info(db, user, [result])
        return result

    def get_obj(self, db: Session, rid: str):
        return db.query(self.model).filter(self.model.id == rid).first()

    def create(self, db: Session, user, data: dict) -> dict:
        clean = {k: v for k, v in data.items() if k in self.cols}
        self._validate_enums(clean)
        _validate_industry_fields(self.name, clean)
        clean.setdefault("id", _new_id())
        _normalize_industry_fields(clean)
        if "tenant_id" in self.cols and not clean.get("tenant_id"):
            clean["tenant_id"] = user.tenant_id
        if "company_id" in self.cols and not clean.get("company_id"):
            clean["company_id"] = user.company_id
        if "created_by" in self.cols and not clean.get("created_by"):
            clean["created_by"] = user.id
        now = _now()
        if "created_date" in self.cols:
            clean.setdefault("created_date", now)
        if "updated_date" in self.cols:
            clean["updated_date"] = now
        if "created_at" in self.cols and not clean.get("created_at"):
            clean["created_at"] = now
        if "updated_at" in self.cols:
            clean["updated_at"] = now
        o = self.model(**clean)
        db.add(o)
        db.commit()
        db.refresh(o)
        return _row(o)

    def update(self, db: Session, user, rid: str, data: dict) -> dict:
        if self.immutable:
            # 審計表：只允許改特定欄位（如 publish_result）
            data = {k: v for k, v in data.items() if k in {"publish_result"}}
        o = db.query(self.model).filter(self.model.id == rid).first()
        if not o or not self._owns(o, user):
            raise HTTPException(404, "Not found")
        if self.name == "KBUserPublishConfirmation":
            data = {k: v for k, v in data.items() if k == "publish_result"}
        self._validate_enums({k: v for k, v in data.items() if k in self.cols})
        _validate_industry_fields(self.name, data)
        is_kbdoc = self.name == "KBDocument"
        before = _row(o) if is_kbdoc else None
        for k, v in data.items():
            if k in self.cols and k != "id":
                if k == "industries":
                    v = _norm_industries(v)
                elif k == "sub_industries":
                    v = _norm_sub_industries(v)
                setattr(o, k, v)
        if "updated_date" in self.cols:
            o.updated_date = _now()
        if "updated_at" in self.cols:
            o.updated_at = _now()
        db.add(o)
        if is_kbdoc:
            self._reconcile_kbdocument_write(db, o, before, data, user)
        db.commit()
        db.refresh(o)
        return _row(o)

    def _reconcile_kbdocument_write(self, db: Session, o, before: dict,
                                    data: dict, user) -> None:
        """P0-01/P1-01/P1-02 修復：通用 KBDocument 寫入的領域守衛。

        - 對具版本/權威身份的文件覆寫內容前，先留一筆 edit 歷史快照；
        - raw_content 改變時同步 content_hash；
        - 狀態降為非 published 時撤銷 Live console / production 旗標，
          避免 draft + production/indexed/available-to-Live 的自我矛盾。
        """
        content_changed = ("raw_content" in data
                           and (data.get("raw_content") or "") != (before.get("raw_content") or ""))
        had_identity = bool(
            before.get("active_version_id")
            or (before.get("version") and before.get("version") != "1.0")
            or before.get("published_at")
            or before.get("status") in ("published", "approved")
            or before.get("available_to_live_console") is True
            or before.get("production_status") == "production"
        )
        if content_changed and had_identity:
            _kbdocument_version_snapshot(
                db, o, before.get("raw_content") or "",
                "草稿編輯儲存",
                getattr(user, "id", None))
            # 保持 doc.version 前進，避免草稿存檔後版本指標原地踏步
            try:
                cur = float(o.version or "1.0")
                major = int(cur)
                minor = round((cur - major) * 10)
                o.version = f"{major}.{minor + 1}"
            except (TypeError, ValueError):
                pass
        if content_changed:
            o.content_hash = _content_hash(data.get("raw_content") or "")
        # Live 一致性：非 published 的狀態不得保留 production/live 可用旗標
        new_status = data.get("status") or getattr(o, "status", None) or "draft"
        liveish = (getattr(o, "available_to_live_console", None) is True
                   or getattr(o, "production_status", None) == "production"
                   or getattr(o, "production_vector_status", None) == "indexed")
        if liveish and new_status != "published":
            o.available_to_live_console = False
            o.production_status = "not_published"

    def delete(self, db: Session, user, rid: str) -> None:
        if self.immutable:
            raise HTTPException(403, f"{self.name} is immutable")
        o = db.query(self.model).filter(self.model.id == rid).first()
        if not o or not self._owns(o, user):
            raise HTTPException(404, "Not found")
        db.delete(o)
        db.commit()

    def bulk_create(self, db: Session, user, records: list) -> list[dict]:
        out = []
        try:
            for rec in records:
                clean = {k: v for k, v in rec.items() if k in self.cols}
                self._validate_enums(clean)
                _validate_industry_fields(self.name, clean)
                clean.setdefault("id", _new_id())
                _normalize_industry_fields(clean)
                if "tenant_id" in self.cols and not clean.get("tenant_id"):
                    clean["tenant_id"] = user.tenant_id
                if "company_id" in self.cols and not clean.get("company_id"):
                    clean["company_id"] = user.company_id
                if "created_by" in self.cols and not clean.get("created_by"):
                    clean["created_by"] = user.id
                now = _now()
                if "created_date" in self.cols:
                    clean.setdefault("created_date", now)
                if "updated_date" in self.cols:
                    clean["updated_date"] = now
                o = self.model(**clean)
                db.add(o)
                out.append(o)
            db.commit()                       # 單一交易
            for o in out:
                db.refresh(o)
            return [_row(o) for o in out]
        except Exception as e:
            db.rollback()
            raise HTTPException(500, f"bulkCreate failed: {e}")

    def bulk_update(self, db: Session, user, records: list) -> list[dict]:
        """★ 裸 array，每元素含 id。單一交易。"""
        out = []
        try:
            for rec in records:
                rid = rec.get("id")
                if not rid:
                    continue
                o = db.query(self.model).filter(self.model.id == rid).first()
                if not o or not self._owns(o, user):
                    continue
                self._validate_enums({k: v for k, v in rec.items() if k in self.cols})
                _validate_industry_fields(self.name, rec)
                for k, v in rec.items():
                    if k in self.cols and k != "id":
                        if k == "industries":
                            v = _norm_industries(v)
                        elif k == "sub_industries":
                            v = _norm_sub_industries(v)
                        setattr(o, k, v)
                if "updated_date" in self.cols:
                    o.updated_date = _now()
                db.add(o)
                out.append(o)
            db.commit()
            for o in out:
                db.refresh(o)
            return [_row(o) for o in out]
        except Exception as e:
            db.rollback()
            raise HTTPException(500, f"bulkUpdate failed: {e}")

    def delete_many(self, db: Session, user, query: dict) -> dict:
        """★ 查詢條件語意（相容 {"ids":[...]}）。"""
        if self.immutable:
            raise HTTPException(403, f"{self.name} is immutable")
        q = db.query(self.model)
        if "ids" in query and isinstance(query["ids"], list):
            q = q.filter(self.model.id.in_(query["ids"]))
        else:
            filters = {k: v for k, v in query.items() if k in self.cols}
            if not filters:
                raise HTTPException(400, "deleteMany requires at least one filter")
            q = self._apply_filters(q, filters)
        q = self._scope(q, user)
        rows = q.all()
        count = 0
        try:
            for o in rows:
                db.delete(o)
                count += 1
            db.commit()
            return {"deleted_count": count}
        except Exception as e:
            db.rollback()
            raise HTTPException(500, f"deleteMany failed: {e}")
