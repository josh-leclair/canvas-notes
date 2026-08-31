"""Hub cards belong to the canvas.

A hub folds its children down to titles. That is presentation, but it is the
*canvas's* presentation: everyone looking at the board should see the same
arrangement, and it should survive changing machine. Per placement rather
than per card, so the same card can be a hub on one canvas and an ordinary
card on another.

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-17

"""
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "alter table placements add column is_hub boolean not null default false;"
    )


def downgrade() -> None:
    op.execute("alter table placements drop column is_hub;")
