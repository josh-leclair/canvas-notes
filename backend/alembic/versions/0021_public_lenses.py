"""Frozen public lens publications.

Revision ID: 0021
Revises: 0020
Create Date: 2026-08-22
"""
from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
create table public_lenses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  canvas_id uuid references canvases(id) on delete set null,
  slug text not null unique,
  title text not null,
  description text,
  snapshot jsonb not null,
  revision integer not null default 1,
  published_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ix_public_lenses_owner_updated
  on public_lenses(owner_id, updated_at desc);

create table public_lens_assets (
  id uuid primary key default gen_random_uuid(),
  lens_id uuid not null references public_lenses(id) on delete cascade,
  source_file_id uuid,
  revision integer not null,
  path text not null,
  mime text not null,
  name text,
  bytes bigint not null,
  created_at timestamptz not null default now()
);
create index ix_public_lens_assets_lens_revision
  on public_lens_assets(lens_id, revision);
"""
    )


def downgrade() -> None:
    op.execute("drop table if exists public_lens_assets;")
    op.execute("drop table if exists public_lenses;")
