"""Add dedicated timer cards.

Revision ID: 0028
Revises: 0027
"""

from alembic import op


revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("alter type card_type add value if not exists 'timer'")
    # Earlier releases allowed a focus clock to run on any card. Freeze those
    # sessions at migration time so no hidden legacy timer keeps accumulating
    # after controls move to the dedicated card type.
    op.execute(
        """
        update cards
        set timer_elapsed_seconds = timer_elapsed_seconds + greatest(
              0,
              extract(epoch from (now() - timer_started_at))::integer
            ),
            timer_started_at = null
        where timer_started_at is not null
        """
    )


def downgrade() -> None:
    # PostgreSQL enum values cannot be removed safely while rows may use them.
    pass
