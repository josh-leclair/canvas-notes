"""Make the reasoning written on a link findable.

A link already carried a note — the *why* two cards are connected, which is
often the most concentrated thinking on a board, because it gets written at
the moment you understood something. None of it was reachable: `search_text`
is a generated column on `cards` over title, body, unfurl description and
transcript, and a generated column cannot read another table.

So the note was write-only. You could record why two things connect and then
never find it again. This indexes it so search can return links beside cards.

Revision ID: 0017
Revises: 0016
Create Date: 2026-08-19

"""
from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
create index if not exists ix_links_note_fts
  on links using gin (to_tsvector('english', coalesce(note, '')));
"""
    )


def downgrade() -> None:
    op.execute("drop index if exists ix_links_note_fts;")
