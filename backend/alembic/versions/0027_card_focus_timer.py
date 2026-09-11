"""Add focus timer state and deadline reminder to cards.

Revision ID: 0027
Revises: 0026
"""

from alembic import op
import sqlalchemy as sa


revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cards",
        sa.Column("timer_started_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "cards",
        sa.Column(
            "timer_elapsed_seconds",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column("cards", sa.Column("reminder_minutes", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("cards", "reminder_minutes")
    op.drop_column("cards", "timer_elapsed_seconds")
    op.drop_column("cards", "timer_started_at")
