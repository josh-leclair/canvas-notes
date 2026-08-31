"""Add optional finite canvas bounds.

Revision ID: 0024
Revises: 0023
"""

from alembic import op
import sqlalchemy as sa


revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing canvases must remain infinite. The application explicitly sets
    # false for canvases created after this migration.
    op.add_column(
        "canvases",
        sa.Column("is_infinite", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "canvases",
        sa.Column("width", sa.Double(), nullable=False, server_default="5500"),
    )
    op.add_column(
        "canvases",
        sa.Column("height", sa.Double(), nullable=False, server_default="3100"),
    )


def downgrade() -> None:
    op.drop_column("canvases", "height")
    op.drop_column("canvases", "width")
    op.drop_column("canvases", "is_infinite")
