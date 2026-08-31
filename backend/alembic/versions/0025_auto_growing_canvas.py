"""Use screen-sized defaults for auto-growing canvases.

Revision ID: 0025
Revises: 0024
"""

from alembic import op
import sqlalchemy as sa


revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Do not resize rows: existing/legacy canvases keep their geometry. This
    # only changes the fallback for new rows created outside the API.
    op.alter_column("canvases", "width", server_default=sa.text("1920"))
    op.alter_column("canvases", "height", server_default=sa.text("1080"))


def downgrade() -> None:
    op.alter_column("canvases", "height", server_default=sa.text("3100"))
    op.alter_column("canvases", "width", server_default=sa.text("5500"))
