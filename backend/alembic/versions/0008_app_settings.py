"""Instance settings editable from the app.

Revision ID: 0008
Revises: 0007
Create Date: 2026-08-17

"""
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
create table app_settings (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);
""")


def downgrade() -> None:
    op.execute("drop table app_settings;")
