"""
Nexus KB FastAPI — 主應用組裝

啟動：
    uvicorn app.main:app --host 0.0.0.0 --port 8000

Singapore 獨立運行，取代 Base44 平台。
"""
from __future__ import annotations
import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import settings
import app.core.tenant_ctx  # noqa: F401  (registers before_insert tenant stamp)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("nexus_kb")

app = FastAPI(
    title=settings.app_name,
    version="2026.08.04",
    description="Nexus Knowledge Core — standalone FastAPI backend (Singapore)",
)

_origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,          # 明確白名單，不用 "*"
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Service-Role-Secret"],
)


@app.get("/health")
def health():
    return {"status": "ok", "service": settings.app_name,
            "app_id": settings.app_id}


@app.middleware("http")
async def _tenant_context_mw(request, call_next):
    """
    在 request async scope 設定 tenant context（best-effort，不阻擋請求）。
    因 sync 端點跑在 threadpool，contextvar 必須在此設定才會被 context copy 帶入。
    真正的 401/403 授權仍由 get_current_user 依賴強制執行。
    """
    from app.core.tenant_ctx import set_tenant_context
    set_tenant_context(None, None, None)
    auth = request.headers.get("authorization")
    if auth and auth.lower().startswith("bearer "):
        try:
            import jwt as _jwt
            claims = _jwt.decode(
                auth.split(" ", 1)[1].strip(), settings.jwt_secret,
                algorithms=[settings.jwt_algorithm],
                options={"verify_aud": False, "verify_iss": False,
                         "verify_exp": False})
            uid = claims.get("sub") or claims.get("user_id") or claims.get("uid")
            tid = claims.get("tenant_id") or uid
            cid = claims.get("company_id")
            try:
                cid = int(cid) if cid is not None else None
            except (TypeError, ValueError):
                cid = None
            if uid:
                set_tenant_context(tid, uid, cid)
        except Exception:
            pass
    return await call_next(request)


# ══════════════════════════════════════════════════════════════════════════
# LLM 註冊（import_pipeline 需要）
# ══════════════════════════════════════════════════════════════════════════
from app.core.llm import invoke_llm                     # noqa: E402
from app.services.import_pipeline import register_llm    # noqa: E402
register_llm(lambda prompt, **kw: invoke_llm(prompt, **kw))


# ══════════════════════════════════════════════════════════════════════════
# Function 端點（30 個 Backend Functions）
# ══════════════════════════════════════════════════════════════════════════
from app.routers.publish_ops import router as publish_router        # noqa: E402
from app.routers.publish_ops import app_router as publish_app_router  # noqa: E402
from app.routers.lifecycle_ops import router as lifecycle_router     # noqa: E402
from app.routers.lifecycle_ops import app_router as lifecycle_app_router  # noqa: E402
from app.routers.import_ops import router as import_router          # noqa: E402
from app.routers.import_ops import app_router as import_app_router   # noqa: E402
from app.routers.platform_ops import router as platform_router       # noqa: E402
from app.routers.platform_ops import app_router as platform_app_router  # noqa: E402
from app.routers.website_ops import router as website_router         # noqa: E402
from app.routers.website_ops import app_router as website_app_router  # noqa: E402

app.include_router(publish_router)      # 6：publish 狀態機
app.include_router(publish_app_router)  # 6：publish 狀態機（/api/apps/{app_id}/functions 相容）
app.include_router(lifecycle_router)    # 6：文件/批次生命週期
app.include_router(lifecycle_app_router)  # 6：文件/批次生命週期（/api/apps/{app_id}/functions 相容）
app.include_router(import_router)       # 4：import pipeline
app.include_router(import_app_router)   # 4：import pipeline（/api/apps/{app_id}/functions 相容）
app.include_router(platform_router)     # 11：vertex/firecrawl/storage/template/embed/維護
app.include_router(platform_app_router) # 11：vertex/firecrawl/storage/template/embed/維護（/api/apps/{app_id}/functions 相容）
app.include_router(website_router)      # 3：website 爬取匯入
app.include_router(website_app_router)  # 3：website 爬取匯入（/api/apps/{app_id}/functions 相容）
# 合計 30 個 Backend Functions

# ══════════════════════════════════════════════════════════════════════════
# Publish 背景管線：註冊 Celery 續跑排程器（import 即完成）
# ★ 必須在 API 進程 import —— kbPublishStart 透過 core._chain() 排程
#   run_publish_step 到 Celery。未 import 時 _schedule_continuation 為 None，
#   操作會永遠卡在 preparing（發布無反應）。
# ══════════════════════════════════════════════════════════════════════════
from app.tasks import publish_tasks   # noqa: E402,F401  (core.register_continuation_scheduler)
from app.tasks import import_tasks    # noqa: E402,F401  (Celery 任務註冊，供排程消費)
from app.tasks import website_tasks   # noqa: E402,F401  (Celery 任務註冊，供排程消費)


# ══════════════════════════════════════════════════════════════════════════
# Entity CRUD（39 個 production entity × 9 method × 2 path）
# ══════════════════════════════════════════════════════════════════════════
from app.routers.entities import register_entity_routes    # noqa: E402
register_entity_routes(app)


# ══════════════════════════════════════════════════════════════════════════
# 私有簽名檔案服務（local storage）+ RAG context-search（AI Chatbot 用）
# ══════════════════════════════════════════════════════════════════════════
from app.routers.files import router as files_router     # noqa: E402
from app.routers.rag_ops import router as rag_router      # noqa: E402
from app.routers.app_compat import router as app_compat_router  # noqa: E402
app.include_router(files_router)
app.include_router(rag_router)
app.include_router(app_compat_router)


# ══════════════════════════════════════════════════════════════════════════
# KB API Contract（PM1）— REST 風格跨系統 API（api_key header 認證）
#   放在 tasks import 之後，確保 publish 續跑排程器（core._schedule_continuation）
#   已註冊，kb_publish_start 委派的管線才能實際排程。
# ══════════════════════════════════════════════════════════════════════════
from app.routers.kb_contract import router as kb_contract_router  # noqa: E402
app.include_router(kb_contract_router)


# ══════════════════════════════════════════════════════════════════════════
# 公共 API（無需 token）— 行業分類字典查詢（/api/v1/public/...）
# ══════════════════════════════════════════════════════════════════════════
from app.routers.industry_public import router as industry_public_router  # noqa: E402
app.include_router(industry_public_router)


# ══════════════════════════════════════════════════════════════════════════
# 外部導入 API（api_key 認證）— /api/v1/public/externalImport
# ══════════════════════════════════════════════════════════════════════════
from app.routers.external_import import router as external_import_router  # noqa: E402
app.include_router(external_import_router)


# ══════════════════════════════════════════════════════════════════════════
# 全域異常處理 — 記錄 API 異常/報錯到 logs/uvicorn/YYYY_MM_DD.txt
# ══════════════════════════════════════════════════════════════════════════
from app.core.error_log import BodyCaptureMiddleware, log_api_error  # noqa: E402

# 需在其它 middleware 之後註冊，使其位於最外層（ServerErrorMiddleware 內側），
# 才能在錯誤發生時於 scope 中保留完整 request body 供日誌記錄。
app.add_middleware(BodyCaptureMiddleware)


@app.exception_handler(StarletteHTTPException)
async def _http_exc_handler(request: Request, exc: StarletteHTTPException):
    await log_api_error(request, exc)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(RequestValidationError)
async def _validation_exc_handler(request: Request, exc: RequestValidationError):
    await log_api_error(request, exc)
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


@app.exception_handler(Exception)
async def _unhandled_exc_handler(request: Request, exc: Exception):
    await log_api_error(request, exc)
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


@app.on_event("startup")
def _startup():
    logger.info("Nexus KB FastAPI started (env=%s)", settings.env)
    # 行業分類字典：冪等補齊種子資料（表不存在 / DB 不可用時僅記錄 warning，不阻擋啟動）
    from app.services.industry_groups import ensure_seeded
    ensure_seeded()

# C3: exact request-byte binding before sync RAG/provider execution.
from app.core.c3_accounting import RequestDigestMiddleware
app.add_middleware(RequestDigestMiddleware)
