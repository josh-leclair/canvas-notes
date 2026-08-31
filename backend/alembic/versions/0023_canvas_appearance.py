"""Retired canvas appearance experiment compatibility revision.

Revision ID: 0023
Revises: 0022

Some development databases were upgraded to this revision while canvas
appearance was briefly persisted on the server. Appearance is now a local,
reversible UI study, but the revision must remain in Alembic's graph so those
databases can still start. The leftover nullable-independent column is benign
and deliberately left in place; fresh databases simply pass through this
compatibility revision without changing their schema.
"""

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
