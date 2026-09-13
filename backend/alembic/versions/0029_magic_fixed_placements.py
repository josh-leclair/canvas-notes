"""Keep individual placements fixed during Magic organize.

Revision ID: 0029
Revises: 0028
"""

from alembic import op


revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "alter table placements add column magic_fixed boolean not null default false;"
    )


def downgrade() -> None:
    op.execute("alter table placements drop column magic_fixed;")
