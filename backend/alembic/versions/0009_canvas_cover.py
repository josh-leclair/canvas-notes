"""Canvas cover images.

Stored as a path on the canvas rather than a `files` row: covers belong to a
canvas, and `files.card_id` is not nullable.

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-17

"""
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
alter table canvases add column cover_path text;
alter table canvases add column cover_mime text;
""")


def downgrade() -> None:
    op.execute("""
alter table canvases drop column cover_mime;
alter table canvases drop column cover_path;
""")
