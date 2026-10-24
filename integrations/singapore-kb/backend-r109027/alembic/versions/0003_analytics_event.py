"""kb_analytics_event — 前端 analytics 埋點事件表

Revision ID: 0003_analytics_event
對應 POST /api/apps/{app_id}/analytics/track/batch 的持久化。
非 Base44 39 個 production entity（不列入 contract），故獨立 migration。
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0003_analytics_event"
down_revision = "0002_pgvector"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        'kb_analytics_event',
        sa.Column('id', sa.String(), primary_key=True),
        sa.Column('app_id', sa.String()),
        sa.Column('event_name', sa.String()),
        sa.Column('event_type', sa.String()),
        sa.Column('user_id', sa.String()),
        sa.Column('session_id', sa.String()),
        sa.Column('page_url', sa.String()),
        sa.Column('referrer', sa.String()),
        sa.Column('properties', JSONB),
        sa.Column('timestamp', TS),
        sa.Column('created_date', TS),
        sa.Column('updated_date', TS),
        sa.Column('created_by', sa.String()),
        sa.Column('tenant_id', sa.String()),
        sa.Column('company_id', sa.Numeric()),
    )


def downgrade() -> None:
    op.drop_table('kb_analytics_event')
