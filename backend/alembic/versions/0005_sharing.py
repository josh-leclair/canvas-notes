"""Canvas sharing and membership.

Revision ID: 0005
Revises: 0004
Create Date: 2026-08-17

"""
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
create table canvas_members (
  canvas_id  uuid        not null references canvases(id) on delete cascade,
  user_id    uuid        not null references users(id)    on delete cascade,
  role       text        not null check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (canvas_id, user_id)
);
create index on canvas_members (user_id);
""")


def downgrade() -> None:
    op.execute("drop table canvas_members;")
