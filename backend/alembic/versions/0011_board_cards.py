"""Board cards: a card that stands for another canvas.

Nesting is derived, not stored. A canvas is "inside" another exactly when a
board card on that canvas points at it — the same trick the inbox uses
("cards with zero placements"), so the two can never disagree. It also means
a board can sit on several canvases at once, just as a card can.

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-17

"""
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("alter type card_type add value if not exists 'board';")


def downgrade() -> None:
    # Postgres cannot drop an enum value.
    pass
