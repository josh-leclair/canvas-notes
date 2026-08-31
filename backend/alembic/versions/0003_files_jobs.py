"""Files and background jobs.

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-17

"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
create table files (
  id         uuid primary key default gen_random_uuid(),
  card_id    uuid        not null references cards(id) on delete cascade,
  path       text        not null,
  mime       text        not null,
  bytes      bigint      not null,
  created_at timestamptz not null default now()
);
create index on files (card_id);

create table jobs (
  id         uuid primary key default gen_random_uuid(),
  kind       text        not null,
  payload    jsonb       not null default '{}'::jsonb,
  status     text        not null default 'queued',
  attempts   integer     not null default 0,
  last_error text,
  run_at     timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on jobs (status, run_at);
""")


def downgrade() -> None:
    op.execute("drop table jobs; drop table files;")
