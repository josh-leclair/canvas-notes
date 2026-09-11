"""Add due dates and effort estimates to cards.

Revision ID: 0026
Revises: 0025
"""

from alembic import op
import sqlalchemy as sa


revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("cards", sa.Column("due_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("cards", sa.Column("eta_minutes", sa.Integer(), nullable=True))
    op.create_index(
        "ix_cards_owner_due_at",
        "cards",
        ["owner_id", "due_at"],
        postgresql_where=sa.text("due_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_cards_owner_due_at", table_name="cards")
    op.drop_column("cards", "eta_minutes")
    op.drop_column("cards", "due_at")
