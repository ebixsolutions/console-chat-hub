"""kb_firecrawl_log — Firecrawl API 呼叫日誌表

記錄每次 Firecrawl 呼叫（POST /v1/scrape、/v1/crawl、GET /v1/crawl/{id}、
GET /v1/team/credit-usage 等）的請求/回應/錯誤/耗時/credits。

schema 對齊舊版 knowledge-base 服務的 KBFirecrawlLog（共用同一張表）。
若資料庫已存在此表（由舊服務建立），此 migration 不需執行。

Revision ID: 0004_firecrawl_log
非 Base44 39 個 production entity（不列入 contract），故獨立 migration。
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0004_firecrawl_log"
down_revision = "0003_kb_document_extra_columns"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        'kb_firecrawl_log',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('webhook_id', sa.String(length=100)),
        sa.Column('success', sa.Boolean()),
        sa.Column('type', sa.String(length=25)),
        sa.Column('data', JSONB),
        sa.Column('company_id', sa.Integer()),
        sa.Column('created_at', sa.Integer()),
        sa.Column('updated_at', sa.Integer()),
        sa.Column('status', sa.Integer()),
        sa.Column('credits_used', sa.Integer()),
    )


def downgrade() -> None:
    op.drop_table('kb_firecrawl_log')
