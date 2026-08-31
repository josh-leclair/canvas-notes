"""A hard-deleted card takes its relationships with it.

`Remove from canvas` is the recoverable action: the card remains alive in the
inbox or on its other canvases. `Delete card` is intentionally final, so a
link to that card must not survive as a growing field of restore prompts.

Revision ID: 0019
Revises: 0018
Create Date: 2026-08-21
"""
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
delete from links where source_card_id is null or target_card_id is null;
alter table links alter column source_card_id set not null;
alter table links alter column target_card_id set not null;

alter table links drop constraint links_source_card_id_fkey;
alter table links
  add constraint links_source_card_id_fkey
  foreign key (source_card_id) references cards(id) on delete cascade;

alter table links drop constraint links_target_card_id_fkey;
alter table links
  add constraint links_target_card_id_fkey
  foreign key (target_card_id) references cards(id) on delete cascade;
"""
    )


def downgrade() -> None:
    op.execute(
        """
alter table links drop constraint links_source_card_id_fkey;
alter table links alter column source_card_id drop not null;
alter table links
  add constraint links_source_card_id_fkey
  foreign key (source_card_id) references cards(id) on delete set null;

alter table links drop constraint links_target_card_id_fkey;
alter table links alter column target_card_id drop not null;
alter table links
  add constraint links_target_card_id_fkey
  foreign key (target_card_id) references cards(id) on delete set null;
"""
    )
