"""行業分類字典 DB 化 — kb_industry_category / kb_industry_category_log

將原 `app/services/industry_groups.py` 的 `INDUSTRY_GROUPS` 常數遷移至資料庫：
  1. 建 kb_industry_category（主分類 level=1、次分類 level=2、parent_id 自我參照）
  2. 建 kb_industry_category_log（LLM 自動新增分類的稽核日誌）
  3. 呼叫 seed_categories() 冪等寫入預設字典（18 個主分類 + 各次分類）

非 Base44 39 個 production entity（不列入 contract），故獨立 migration。

Revision ID: 0008_industry_category
down_revision: 0007_sub_industries_array_format
"""
from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0008_industry_category"
down_revision = "0007_sub_industries_array_format"
branch_labels = None
depends_on = None

JSONB = postgresql.JSONB(astext_type=sa.Text())
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        'kb_industry_category',
        sa.Column('id', sa.String(), primary_key=True),
        sa.Column('value', sa.String(), nullable=False),
        sa.Column('label', sa.String(), nullable=False),
        sa.Column('description', sa.Text()),
        sa.Column('parent_id', sa.String()),
        sa.Column('level', sa.Numeric(), server_default='1'),
        sa.Column('source', sa.String(), server_default='seed'),
        sa.Column('is_active', sa.Boolean(), server_default=sa.true()),
        sa.Column('sort_order', sa.Numeric(), server_default='0'),
        sa.Column('created_date', TS),
        sa.Column('updated_date', TS),
        sa.Column('created_by', sa.String()),
        sa.Column('tenant_id', sa.String()),
        sa.Column('company_id', sa.Numeric()),
        sa.UniqueConstraint('value', name='uq_kb_industry_category_value'),
    )
    op.create_index('ix_kb_industry_category_parent_id',
                    'kb_industry_category', ['parent_id'])
    op.create_index('ix_kb_industry_category_level',
                    'kb_industry_category', ['level'])

    op.create_table(
        'kb_industry_category_log',
        sa.Column('id', sa.String(), primary_key=True),
        sa.Column('category_id', sa.String()),
        sa.Column('category_value', sa.String(), nullable=False),
        sa.Column('category_label', sa.String()),
        sa.Column('parent_value', sa.String()),
        sa.Column('action', sa.String(), nullable=False),
        sa.Column('source', sa.String(), nullable=False),
        sa.Column('reason', sa.Text()),
        sa.Column('payload', JSONB),
        sa.Column('created_date', TS),
        sa.Column('updated_date', TS),
        sa.Column('created_by', sa.String()),
        sa.Column('tenant_id', sa.String()),
        sa.Column('company_id', sa.Numeric()),
    )
    op.create_index('ix_kb_industry_category_log_category_value',
                    'kb_industry_category_log', ['category_value'])
    op.create_index('ix_kb_industry_category_log_action',
                    'kb_industry_category_log', ['action'])

    # 資料遷移：冪等寫入預設字典（沿用執行期同一份寫入邏輯）
    # 離線模式（alembic upgrade --sql）無實際連線，無法執行資料匯入，故略過。
    if context.is_offline_mode():
        print("[0008_industry_category] 離線模式：略過種子資料匯入，"
              "請以 online 模式執行 migration 以完成資料遷移")
        return

    from app.services.industry_groups import seed_categories

    created = seed_categories(op.get_bind())
    print(f"[0008_industry_category] 匯入行業分類種子資料 {created} 筆")


def downgrade() -> None:
    op.drop_index('ix_kb_industry_category_log_action',
                  table_name='kb_industry_category_log')
    op.drop_index('ix_kb_industry_category_log_category_value',
                  table_name='kb_industry_category_log')
    op.drop_table('kb_industry_category_log')

    op.drop_index('ix_kb_industry_category_level',
                  table_name='kb_industry_category')
    op.drop_index('ix_kb_industry_category_parent_id',
                  table_name='kb_industry_category')
    op.drop_table('kb_industry_category')
