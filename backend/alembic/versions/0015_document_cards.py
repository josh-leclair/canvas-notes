"""Documents as a card type rather than a mode a note is switched into.

A document was `payload.display = "document"` on a text card, on the reasoning
that the data shape is identical — both are markdown in `body`, and only the
editing surface differs. That held right up until documents needed to be
something you drag onto a board. You cannot drag on a thing that only exists
by converting something else afterwards, and "make a note, then change it" is
not how any of the other objects work.

The storage is still a body of markdown, so search, embeddings, splitting and
export are untouched. What the type buys is a thing you can pick up.

Adding the value and using it are two migrations on purpose: Postgres refuses
to use a new enum value in the transaction that added it, so the rows already
converted the old way move over in 0016.

Revision ID: 0015
Revises: 0014
Create Date: 2026-08-19

"""
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("alter type card_type add value if not exists 'document';")


def downgrade() -> None:
    # Postgres cannot remove a value from an enum; the type keeps 'document'.
    pass
