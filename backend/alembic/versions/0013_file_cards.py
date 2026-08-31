"""File cards: any attachment as an object on the canvas.

Audio and images already had upload routes; everything else had nowhere to
go. A file card holds one arbitrary attachment and shows its name, type and
size, so a spec, a spreadsheet or a scan can sit beside the notes about it.

The files table gains the original filename. It was never stored — audio and
images are addressed by id and rendered, never downloaded — but a file card
is downloaded by definition, and it has to come back with the name it went in
with.

Revision ID: 0013
Revises: 0012
Create Date: 2026-08-18

"""
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("alter type card_type add value if not exists 'file';")
    op.execute("alter table files add column if not exists name text;")


def downgrade() -> None:
    # Postgres cannot drop a value from an enum, so the type keeps 'file'.
    op.execute("alter table files drop column if exists name;")
