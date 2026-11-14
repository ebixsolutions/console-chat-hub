"""industry / industries / sub_industries 由 kb_import_batch 遷移至 kb_import_item

批次級手動選擇的行業欄位移到逐條 item 級（由後端自動識別填寫）。
遷移步驟：
  1. kb_import_item 新增 industry(String) / industries(JSONB) / sub_industries(JSONB)
  2. 將 kb_import_batch 上既有的值複製到所屬 items（batch_id 關聯）
  3. kb_import_batch 移除這三個欄位

Revision ID: 0006_move_industry_fields_to_item
down_revision: 0005_integration_key
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0006_move_industry_fields_to_item"
down_revision = "0005_integration_key"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    if not _is_postgres():
        return

    op.add_column("kb_import_item", sa.Column("industry", sa.String(), nullable=True))
    op.add_column("kb_import_item", sa.Column("industries", JSONB, nullable=True))
    op.add_column("kb_import_item", sa.Column("sub_industries", JSONB, nullable=True))

    # 資料遷移：batch 級值 → 所屬 items
    op.execute(
        """
        UPDATE kb_import_item AS i
        SET industry = b.industry,
            industries = b.industries,
            sub_industries = b.sub_industries
        FROM kb_import_batch AS b
        WHERE i.batch_id = b.id
        """
    )

    op.drop_column("kb_import_batch", "industry")
    op.drop_column("kb_import_batch", "industries")
    op.drop_column("kb_import_batch", "sub_industries")


def downgrade() -> None:
    if not _is_postgres():
        return

    op.add_column("kb_import_batch", sa.Column("industry", sa.String(), nullable=True))
    op.add_column("kb_import_batch", sa.Column("industries", JSONB, nullable=True))
    op.add_column("kb_import_batch", sa.Column("sub_industries", JSONB, nullable=True))

    # 反向複製：取該 batch 第一條 item 的行業值回填
    op.execute(
        """
        UPDATE kb_import_batch AS b
        SET industry = i.industry,
            industries = i.industries,
            sub_industries = i.sub_industries
        FROM kb_import_item AS i
        WHERE i.batch_id = b.id
          AND i.item_index = (SELECT MIN(item_index) FROM kb_import_item
                              WHERE batch_id = b.id)
        """
    )

    op.drop_column("kb_import_item", "industry")
    op.drop_column("kb_import_item", "industries")
    op.drop_column("kb_import_item", "sub_industries")
