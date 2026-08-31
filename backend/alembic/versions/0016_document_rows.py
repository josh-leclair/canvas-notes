"""Move the notes already converted into documents onto the new type.

Separate from 0015 because Postgres will not use an enum value in the same
transaction that added it.

Revision ID: 0016
Revises: 0015
Create Date: 2026-08-19

"""
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Alembic runs a whole upgrade in one transaction, so splitting this out
    # into its own migration was not enough on its own — 0015's ALTER TYPE and
    # this UPDATE still shared one. Closing the transaction here puts the new
    # enum value safely in the past before anything uses it.
    op.execute("COMMIT")
    op.execute(
        """
update cards
set type = 'document',
    payload = payload - 'display'
where type = 'text' and payload ->> 'display' = 'document';
"""
    )


def downgrade() -> None:
    op.execute(
        """
update cards
set type = 'text',
    payload = jsonb_set(payload, '{display}', '"document"')
where type = 'document';
"""
    )
