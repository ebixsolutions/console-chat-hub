"""kb_integration_key — AI Chatbot 專用 Integration Key 表

完整 key 只在建立當次回傳一次；DB 絕不存 plaintext，
只存 key_id / name / key_hash(SHA-256) / key_prefix(前12字元)。

Revision ID: 0005_integration_key
down_revision: 0004_firecrawl_log
非 Base44 39 個 production entity（不列入 contract），故獨立 migration。
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0005_integration_key"
down_revision = "0004_firecrawl_log"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "kb_integration_key",
        sa.Column("key_id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("key_hash", sa.String(), nullable=False),
        sa.Column("key_prefix", sa.String(), nullable=False),
        sa.Column("client", sa.String()),
        sa.Column("status", sa.String()),
        sa.Column("company_id", sa.Numeric()),
        sa.Column("created_by", sa.String()),
        sa.Column("created_at", TS),
        sa.Column("last_used_at", TS),
        sa.Column("revoked_at", TS),
    )


def downgrade() -> None:
    op.drop_table("kb_integration_key")
