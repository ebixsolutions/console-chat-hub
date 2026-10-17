"""
Nexus KB FastAPI — 核心設定
Singapore 獨立運行，不依賴 Base44 平台。
"""
from __future__ import annotations
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# 載入專案根目錄 .env（優先於程式內建預設值，但不覆蓋已存在的環境變數）。
# 避免直接以 `uvicorn app.main:app` 啟動時漏載 JWT_SECRET 等設定。
BASE_DIR = Path(__file__).resolve().parent.parent.parent
load_dotenv(BASE_DIR / ".env", override=False)


@dataclass
class Settings:
    # ── App ──
    app_name: str = "knowledge-base"
    app_id: str = os.getenv("NEXUS_APP_ID", "6a12c8b68d8278b4c735e9eb")
    env: str = os.getenv("ENV", "production")

    # ── Database（Singapore PostgreSQL）──
    database_url: str = os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg://localhost/knowledge_base",
    )
    db_pool_size: int = int(os.getenv("DB_POOL_SIZE", "10"))
    db_max_overflow: int = int(os.getenv("DB_MAX_OVERFLOW", "20"))

    # ── Redis / Celery ──
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    celery_broker: str = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/1")
    celery_backend: str = os.getenv("CELERY_RESULT_BACKEND", "redis://localhost:6379/2")

    # ── Auth（JWT）──
    jwt_secret: str = os.getenv("JWT_SECRET", "change-me-in-production")
    jwt_algorithm: str = os.getenv("JWT_ALGORITHM", "HS256")
    # 前端 token 不含 aud/iss，audience/issuer 校验保持关闭（不要开启）
    jwt_audience: str = os.getenv("JWT_AUDIENCE", "nexus-kb")
    jwt_issuer: str = os.getenv("JWT_ISSUER", "nexus-platform")
    jwt_verify_aud: bool = os.getenv("JWT_VERIFY_AUD", "false").lower() == "true"
    jwt_verify_iss: bool = os.getenv("JWT_VERIFY_ISS", "false").lower() == "true"
    # service-role：獨立強憑證（非僅靠 header），繞過 tenant 過濾做平台級操作
    service_role_secret: str = os.getenv("SERVICE_ROLE_SECRET", "")

    # ── CORS（明確白名單；production 不可 * + credentials）──
    allowed_origins: str = os.getenv(
        "ALLOWED_ORIGINS", "https://nexus-kb-core.base44.app")

    # ── Production embedding fail-closed（G）──
    #   production 模式禁止未授權 local embedding fallback
    require_production_embedding: bool = os.getenv(
        "REQUIRE_PRODUCTION_EMBEDDING",
        "true" if os.getenv("ENV", "production") == "production" else "false"
    ).lower() == "true"

    # ── LLM providers ──
    vertex_project: str = os.getenv("VERTEX_PROJECT", "vertex-ai-api-491406")
    vertex_location: str = os.getenv("VERTEX_LOCATION", "us-central1")
    vertex_sa_json: str = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "")
    if vertex_sa_json and not Path(vertex_sa_json).is_absolute():
        vertex_sa_json = str(BASE_DIR / vertex_sa_json)
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    deepseek_api_key: str = os.getenv("DEEPSEEK_API_KEY", "")
    default_llm_model: str = os.getenv("DEFAULT_LLM_MODEL", "gemini-2.0-flash")
    # provider base URLs（可指向 contract test server 做真 HTTP 契約測試）
    openai_base_url: str = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    deepseek_base_url: str = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    vertex_base_url: str = os.getenv("VERTEX_BASE_URL", "")  # 空=用官方 region 端點
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "gemini-embedding-001")
    embedding_dims: int = int(os.getenv("EMBEDDING_DIMS", "768"))

    # ── Storage（Singapore object store）──
    storage_backend: str = os.getenv("STORAGE_BACKEND", "local")  # local | s3 | gcs
    storage_bucket: str = os.getenv("STORAGE_BUCKET", "nexus-kb")
    storage_local_path: str = os.getenv("STORAGE_LOCAL_PATH", "/data/kb-storage")
    storage_signed_url_ttl: int = int(os.getenv("STORAGE_SIGNED_URL_TTL", "3600"))

    # ── Firecrawl ──
    firecrawl_api_key: str = os.getenv("FIRECRAWL_API_KEY", "")
    firecrawl_base_url: str = os.getenv("FIRECRAWL_BASE_URL", "https://api.firecrawl.dev")

    # ── Credit usage reporting（外部平台計費：每次 Vertex AI / Firecrawl 呼叫後回報用量）──
    credit_report_enabled: bool = os.getenv(
        "CREDIT_REPORT_ENABLED", "true").lower() == "true"
    credit_api_url: str = os.getenv(
        "CREDIT_API_URL",
        "https://widget.ebixmall.com/su-platform-api/api/credit/transaction")
    credit_app_code: str = os.getenv("CREDIT_APP_CODE", "knowledge-hub")
    # credit token 過期＝相對 TTL（秒），由現在起算；勿用固定絕對時間戳（會過期）
    credit_token_exp: int = int(os.getenv("CREDIT_TOKEN_EXP", "3600"))

    # ── Publish 狀態機常數 ──
    publish_chunk_size: int = 5
    heartbeat_stale_ms: int = 45_000
    continuation_lock_ms: int = 90_000

    # ── Raw content 限制 ──
    raw_content_threshold: int = 18_000

    # ── 外部導入 API（POST /api/v1/public/externalImport）──
    #   同一 api_key 於 window 秒內最多 limit 次請求（in-process sliding window）
    external_import_rate_limit: int = int(
        os.getenv("EXTERNAL_IMPORT_RATE_LIMIT", "30"))
    external_import_rate_window_seconds: int = int(
        os.getenv("EXTERNAL_IMPORT_RATE_WINDOW_SECONDS", "60"))

    # ── 行業分類字典（kb_industry_category，DB 驅動）──
    # 分類字典記憶體快取 TTL（秒）；DB 讀取失敗時於此期間內沿用快照
    industry_catalog_cache_ttl_seconds: int = int(
        os.getenv("INDUSTRY_CATALOG_CACHE_TTL_SECONDS", "300"))
    # LLM 回傳字典中不存在的分類時，是否自動新增（含驗證與稽核日誌）
    industry_auto_register_enabled: bool = os.getenv(
        "INDUSTRY_AUTO_REGISTER_ENABLED", "true").lower() == "true"


settings = Settings()
