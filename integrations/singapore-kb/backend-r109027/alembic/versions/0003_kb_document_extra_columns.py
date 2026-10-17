"""kb_document 補齊舊版 knowledge-base 服務使用的欄位

背景：本地與伺服器共用同一 PostgreSQL 資料庫，且同時被
舊版 knowledge-base 服務與本服務（nexus_fastapi）存取。
舊版 knowledge-base 的 KBDocument model 比 0001_initial 多出：
  - knowledge_purpose  TEXT
  - consumer_apps     JSONB
  - review_path       TEXT
缺列會導致舊服務查詢時報
`column kb_document.knowledge_purpose does not exist`。
此 migration 在既有表上補列，一次性修復兩邊。

Revision ID: 0003_kb_document_extra_columns
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0003_kb_document_extra_columns"
down_revision = "0003_analytics_event"
branch_labels = None
depends_on = None


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    if not _is_postgres():
        return
    op.add_column("kb_document", sa.Column("knowledge_purpose", sa.Text(), nullable=True))
    op.add_column("kb_document", sa.Column("consumer_apps", postgresql.JSONB(), nullable=True))
    op.add_column("kb_document", sa.Column("review_path", sa.Text(), nullable=True))


def downgrade() -> None:
    if not _is_postgres():
        return
    op.drop_column("kb_document", "review_path")
    op.drop_column("kb_document", "consumer_apps")
    op.drop_column("kb_document", "knowledge_purpose")
