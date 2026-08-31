"""Links: milestone 3.

Endpoints are nullable and set-null on card delete: a link survives the loss
of its endpoints and renders as a tombstone from its snapshot.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-17

"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
create table links (
  id                   uuid primary key default gen_random_uuid(),
  creator_id           uuid not null references users(id) on delete cascade,
  source_card_id       uuid references cards(id)    on delete set null,
  target_card_id       uuid references cards(id)    on delete set null,
  link_type            text,
  note                 text,
  created_on_canvas_id uuid references canvases(id) on delete set null,
  source_snapshot      jsonb not null default '{}'::jsonb,
  target_snapshot      jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index on links (source_card_id);
create index on links (target_card_id);
create index on links (creator_id);
""")


def downgrade() -> None:
    op.execute("drop table links;")
