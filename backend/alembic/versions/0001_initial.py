"""Initial Canvas Notes schema.

Revision ID: 0001
Revises:
Create Date: 2026-08-17

"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
create extension if not exists pgcrypto;
create extension if not exists citext;

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         citext      not null unique,
  password_hash text        not null,
  display_name  text        not null,
  is_admin      boolean     not null default false,
  created_at    timestamptz not null default now()
);

create table invites (
  id         uuid primary key default gen_random_uuid(),
  code       text        not null unique,
  created_by uuid        not null references users(id) on delete cascade,
  used_by    uuid                 references users(id) on delete set null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid        not null references users(id) on delete cascade,
  token_hash   text        not null unique,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index on sessions (user_id);

create table canvases (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid        not null references users(id) on delete cascade,
  name       text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on canvases (owner_id, created_at desc);

create type card_type as enum ('text', 'link', 'youtube', 'audio');

create table cards (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid        not null references users(id) on delete cascade,
  type       card_type   not null default 'text',
  title      text,
  body       text,
  payload    jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on cards (owner_id, created_at desc);

create table placements (
  id         uuid primary key default gen_random_uuid(),
  card_id    uuid        not null references cards(id)    on delete cascade,
  canvas_id  uuid        not null references canvases(id) on delete cascade,
  x          double precision not null,
  y          double precision not null,
  w          double precision not null default 280,
  h          double precision not null default 180,
  z          integer          not null default 0,
  updated_at timestamptz      not null default now(),
  unique (card_id, canvas_id)
);
create index on placements (canvas_id);
create index on placements (card_id);
""")


def downgrade() -> None:
    op.execute("""
drop table placements;
drop table cards;
drop type card_type;
drop table canvases;
drop table sessions;
drop table invites;
drop table users;
""")
