"""production vector store — pgvector extension + kb_prod_vec table

Revision ID: 0002_pgvector
回應 QA gap #1：production vector 為真實 pgvector 落地，deploy 時由 alembic 一次建好。
pgvector 不可用時（如測試用 sqlite）安全跳過，改由 vector_store 執行 JSONB fallback。
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_pgvector"
down_revision = "0001_initial"
branch_labels = None
depends_on = None

EMBED_DIMS = 768


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    if not _is_postgres():
        return
    bind = op.get_bind()
    bind.execute(sa.text("CREATE EXTENSION IF NOT EXISTS vector"))
    bind.execute(sa.text(f"""
        CREATE TABLE IF NOT EXISTS kb_prod_vec (
            chunk_id      text PRIMARY KEY,
            document_id   text NOT NULL,
            version_id    text,
            tenant_id     text,
            chunk_index   integer,
            chunk_type    text,
            chunk_text    text,
            embedding     vector({EMBED_DIMS}) NOT NULL,
            created_at    timestamptz DEFAULT now()
        )
    """))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS kb_prod_vec_doc_idx "
        "ON kb_prod_vec (document_id)"))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS kb_prod_vec_tenant_idx "
        "ON kb_prod_vec (tenant_id)"))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS kb_prod_vec_ann_idx "
        "ON kb_prod_vec USING ivfflat (embedding vector_cosine_ops) "
        "WITH (lists = 100)"))


def downgrade() -> None:
    if not _is_postgres():
        return
    op.get_bind().execute(sa.text("DROP TABLE IF EXISTS kb_prod_vec"))
