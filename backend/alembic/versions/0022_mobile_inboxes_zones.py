"""Board-routed inbox cards and spatial zones.

Revision ID: 0022
Revises: 0021
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cards",
        sa.Column("inbox_canvas_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_cards_inbox_canvas",
        "cards",
        "canvases",
        ["inbox_canvas_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_cards_inbox_canvas_id", "cards", ["inbox_canvas_id"])

    op.create_table(
        "zones",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "canvas_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("canvases.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("x", sa.Double(), nullable=False),
        sa.Column("y", sa.Double(), nullable=False),
        sa.Column("w", sa.Double(), server_default=sa.text("720"), nullable=False),
        sa.Column("h", sa.Double(), server_default=sa.text("520"), nullable=False),
        sa.Column("sort", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_zones_canvas_sort", "zones", ["canvas_id", "sort"])


def downgrade() -> None:
    op.drop_table("zones")
    op.drop_index("ix_cards_inbox_canvas_id", table_name="cards")
    op.drop_constraint("fk_cards_inbox_canvas", "cards", type_="foreignkey")
    op.drop_column("cards", "inbox_canvas_id")
