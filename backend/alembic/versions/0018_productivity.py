"""Daily cards and the focus shelf.

Revision ID: 0018
Revises: 0017
Create Date: 2026-08-21
"""
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
create table focus_items (
  user_id uuid not null references users(id) on delete cascade,
  card_id uuid not null references cards(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, card_id)
);
create index ix_focus_items_user_created on focus_items(user_id, created_at);

create unique index uq_cards_owner_daily_date
  on cards(owner_id, ((payload->'daily_card'->>'date')))
  where payload ? 'daily_card';
"""
    )


def downgrade() -> None:
    op.execute("drop index if exists uq_cards_owner_daily_date;")
    op.execute("drop table if exists focus_items;")
