"""Add live portal cards.

Revision ID: 0020
Revises: 0019
Create Date: 2026-08-21
"""
from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("alter type card_type add value if not exists 'portal'")


def downgrade() -> None:
    # PostgreSQL enum values cannot be removed without rebuilding the type.
    # Leaving the unused value is safer than rewriting every card row.
    pass
