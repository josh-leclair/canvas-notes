"""Image cards.

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-17

"""
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Postgres 12+ allows ADD VALUE inside a transaction as long as the new
    # value is not used in the same transaction.
    op.execute("alter type card_type add value if not exists 'image';")


def downgrade() -> None:
    # Postgres cannot drop an enum value. Rebuilding the type would require
    # rewriting every dependent column, which is not worth it for a downgrade.
    pass
