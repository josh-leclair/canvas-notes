"""Columns: a titled container that stacks cards vertically.

A column is a card, so it can be linked, shared and placed like anything
else. Membership lives on the *placement* rather than the card, because being
in a column is a fact about where a card sits on this canvas — the same card
can be loose on another board.

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-17

"""
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("alter type card_type add value if not exists 'column';")
    op.execute("""
alter table placements
  add column parent_id uuid references placements(id) on delete set null,
  add column sort integer not null default 0;

create index on placements (parent_id);
""")


def downgrade() -> None:
    op.execute("""
alter table placements drop column sort;
alter table placements drop column parent_id;
""")
