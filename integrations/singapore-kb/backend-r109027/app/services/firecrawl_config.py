"""
Firecrawl 設定解析 — 動態讀取 kb_firecrawl_config 表

API key / base URL 不再固定讀 env，而是優先取 kb_firecrawl_config
中 is_active=True 的設定；無啟用設定或欄位為空時 fallback 到 env。
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import FirecrawlConfig


def resolve_firecrawl_config(db: Session):
    """回傳 (api_key, api_base_url)；優先 kb_firecrawl_config 啟用設定，fallback env。"""
    api_key = settings.firecrawl_api_key
    base_url = settings.firecrawl_base_url
    if db is not None:
        cfg = (
            db.query(FirecrawlConfig)
            .filter(FirecrawlConfig.is_active.is_(True))
            .first()
        )
        if cfg:
            if cfg.api_key:
                api_key = cfg.api_key
            if cfg.api_base_url:
                base_url = cfg.api_base_url
    return api_key, base_url
