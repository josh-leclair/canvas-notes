"""Embeddings and full-text search.

Full text search works on every instance. The embedding column requires
pgvector; compose ships `pgvector/pgvector:pg16`, which is data-compatible
with the plain postgres:16 image. Dimension is fixed per instance by
EMBEDDING_DIM at migration time.

Revision ID: 0006
Revises: 0005
Create Date: 2026-08-17

"""
from alembic import op

from app.config import settings

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The searchable text of a card: user prose plus machine-derived content.
    op.execute("""
alter table cards add column search_text text
  generated always as (
    coalesce(title, '') || ' ' ||
    coalesce(body, '') || ' ' ||
    coalesce(payload #>> '{unfurl,description}', '') || ' ' ||
    coalesce(payload ->> 'transcript', '')
  ) stored;

create index cards_fts_idx on cards
  using gin (to_tsvector('english', search_text));
""")

    op.execute("create extension if not exists vector;")
    op.execute(
        f"alter table cards add column embedding vector({settings.embedding_dim});"
    )
    # HNSW keeps the distance query fast into the hundreds of thousands of rows.
    op.execute(
        "create index cards_embedding_idx on cards "
        "using hnsw (embedding vector_cosine_ops);"
    )


def downgrade() -> None:
    op.execute("""
drop index if exists cards_embedding_idx;
alter table cards drop column if exists embedding;
drop index if exists cards_fts_idx;
alter table cards drop column if exists search_text;
""")
