"""Checklists and tables as card types of their own.

Both were possible already as markdown inside a text card, and both were
miserable that way: a checklist meant typing `- [ ]` and a table meant typing
pipes into a 280px textarea. A type of their own buys each one a purpose-built
editor and a rendering that is never ambiguous.

The structure lives in `payload` — `items` for a checklist, `rows` for a
table — and `body` holds a markdown mirror of it, regenerated on every write
and never hand-edited. That keeps `search_text` (a generated column over
title and body), embeddings, splitting and export all working untouched,
while the editor gets to work on a real list and a real grid.

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-19

"""
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("alter type card_type add value if not exists 'checklist';")
    op.execute("alter type card_type add value if not exists 'table';")


def downgrade() -> None:
    # Postgres cannot remove a value from an enum; the type keeps both.
    pass
