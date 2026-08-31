"""Capture: milestone 5.

Revision ID: 0004
Revises: 0003
Create Date: 2026-08-17

"""
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
create table api_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid        not null references users(id) on delete cascade,
  name         text        not null,
  token_hash   text        not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index on api_tokens (user_id);

create table bot_identities (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid        not null references users(id) on delete cascade,
  platform         text        not null,
  platform_user_id text        not null,
  created_at       timestamptz not null default now(),
  unique (platform, platform_user_id)
);
create index on bot_identities (user_id);

create table pairing_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references users(id) on delete cascade,
  code        text        not null unique,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);
""")


def downgrade() -> None:
    op.execute("drop table pairing_codes; drop table bot_identities; drop table api_tokens;")
