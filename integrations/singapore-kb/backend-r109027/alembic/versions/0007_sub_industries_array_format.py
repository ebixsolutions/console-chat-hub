"""sub_industries 由 dict（{"values": [...]}）改為 string array（["HomeAppliance_AirCon"]）。

遷移步驟：
  1. kb_document 新增 sub_industries(JSONB) 欄位，既有列預設為 []（空陣列）。
  2. kb_import_item.sub_industries 既有 dict 資料轉為 string array。

Revision ID: 0007_sub_industries_array_format
down_revision: 0006_move_industry_fields_to_item
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0007_sub_industries_array_format"
down_revision = "0006_move_industry_fields_to_item"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    if not _is_postgres():
        return

    # 1. kb_document 新增 sub_industries，既有列填入 []（空陣列）
    op.add_column(
        "kb_document",
        sa.Column("sub_industries", JSONB, nullable=True,
                  server_default=sa.text("'[]'::jsonb")),
    )

    # 2. kb_import_item.sub_industries：dict {"values": [...]} → array [...]
    op.execute(
        """
        UPDATE kb_import_item
        SET sub_industries = sub_industries->'values'
        WHERE sub_industries IS NOT NULL
          AND jsonb_typeof(sub_industries) = 'object'
          AND sub_industries ? 'values'
          AND jsonb_typeof(sub_industries->'values') = 'array'
        """
    )
    # 殘留的非陣列（無 values 的 object）→ 空陣列，維持資料完整性
    op.execute(
        """
        UPDATE kb_import_item
        SET sub_industries = '[]'::jsonb
        WHERE sub_industries IS NOT NULL
          AND jsonb_typeof(sub_industries) <> 'array'
        """
    )
    # NULL → 空陣列，統一為 array 格式
    op.execute(
        """
        UPDATE kb_import_item
        SET sub_industries = '[]'::jsonb
        WHERE sub_industries IS NULL
        """
    )


def downgrade() -> None:
    if not _is_postgres():
        return

    # 反向：kb_import_item.sub_industries array → dict {"values": [...]}
    op.execute(
        """
        UPDATE kb_import_item
        SET sub_industries = jsonb_build_object('values', sub_industries)
        WHERE sub_industries IS NOT NULL
          AND jsonb_typeof(sub_industries) = 'array'
        """
    )

    op.drop_column("kb_document", "sub_industries")
