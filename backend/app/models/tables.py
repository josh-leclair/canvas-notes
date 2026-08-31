import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Double,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

CARD_TYPES = (
    "text", "link", "youtube", "audio", "image", "board", "column", "file",
    "checklist", "table", "document", "portal",
)


def uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )


def now_col() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = uuid_pk()
    email: Mapped[str] = mapped_column(CITEXT, nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    is_admin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = now_col()


class Invite(Base):
    __tablename__ = "invites"

    id: Mapped[uuid.UUID] = uuid_pk()
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    used_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = now_col()


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (Index("ix_sessions_user_id", "user_id"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    user_agent: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = now_col()
    last_seen_at: Mapped[datetime] = now_col()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Canvas(Base):
    __tablename__ = "canvases"
    __table_args__ = (
        Index("ix_canvases_owner_created", "owner_id", text("created_at DESC")),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # New canvases auto-grow from these bounds. The database default remains
    # infinite so older rows and out-of-band inserts retain legacy behaviour.
    is_infinite: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    width: Mapped[float] = mapped_column(
        Double, nullable=False, server_default=text("1920")
    )
    height: Mapped[float] = mapped_column(
        Double, nullable=False, server_default=text("1080")
    )
    cover_path: Mapped[str | None] = mapped_column(Text)
    cover_mime: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = now_col()
    updated_at: Mapped[datetime] = now_col()

    placements: Mapped[list["Placement"]] = relationship(
        back_populates="canvas", cascade="all, delete-orphan", passive_deletes=True
    )
    zones: Mapped[list["Zone"]] = relationship(
        back_populates="canvas", cascade="all, delete-orphan", passive_deletes=True
    )


class CanvasMember(Base):
    __tablename__ = "canvas_members"
    __table_args__ = (Index("ix_canvas_members_user_id", "user_id"),)

    canvas_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("canvases.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    role: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = now_col()


class Card(Base):
    __tablename__ = "cards"
    __table_args__ = (
        Index("ix_cards_owner_created", "owner_id", text("created_at DESC")),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # An unplaced card may be routed to one board's inbox. Inbox membership
    # itself remains derived from having zero placements; this only records
    # which contextual tray should show it.
    inbox_canvas_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("canvases.id", ondelete="SET NULL")
    )
    type: Mapped[str] = mapped_column(
        Enum(*CARD_TYPES, name="card_type"), nullable=False, server_default="text"
    )
    title: Mapped[str | None] = mapped_column(Text)
    body: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = now_col()
    updated_at: Mapped[datetime] = now_col()

    placements: Mapped[list["Placement"]] = relationship(
        back_populates="card", cascade="all, delete-orphan", passive_deletes=True
    )


class FocusItem(Base):
    """One user's temporary working set.

    Only identity is stored here. Card content remains canonical in `cards`,
    so the shelf cannot become a stale second copy of a note.
    """

    __tablename__ = "focus_items"
    __table_args__ = (
        Index("ix_focus_items_user_created", "user_id", "created_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cards.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = now_col()


class PublicLens(Base):
    """A frozen, anonymous publication of an explicitly reviewed selection."""

    __tablename__ = "public_lenses"
    __table_args__ = (
        Index("ix_public_lenses_owner_updated", "owner_id", text("updated_at DESC")),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    canvas_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("canvases.id", ondelete="SET NULL")
    )
    slug: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    published_at: Mapped[datetime] = now_col()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = now_col()
    updated_at: Mapped[datetime] = now_col()


class PublicLensAsset(Base):
    __tablename__ = "public_lens_assets"
    __table_args__ = (Index("ix_public_lens_assets_lens_revision", "lens_id", "revision"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    lens_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("public_lenses.id", ondelete="CASCADE"), nullable=False
    )
    source_file_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    mime: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str | None] = mapped_column(Text)
    bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = now_col()


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = now_col()
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )


class ApiToken(Base):
    __tablename__ = "api_tokens"
    __table_args__ = (Index("ix_api_tokens_user_id", "user_id"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = now_col()
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class BotIdentity(Base):
    __tablename__ = "bot_identities"
    __table_args__ = (
        UniqueConstraint("platform", "platform_user_id", name="uq_bot_identity"),
        Index("ix_bot_identities_user_id", "user_id"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    platform: Mapped[str] = mapped_column(Text, nullable=False)
    platform_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = now_col()


class PairingCode(Base):
    __tablename__ = "pairing_codes"

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = now_col()


class File(Base):
    __tablename__ = "files"
    __table_args__ = (Index("ix_files_card_id", "card_id"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cards.id", ondelete="CASCADE"), nullable=False
    )
    path: Mapped[str] = mapped_column(Text, nullable=False)
    mime: Mapped[str] = mapped_column(Text, nullable=False)
    bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # The name it was uploaded under, so a download comes back as itself
    # rather than as a uuid. Null for audio and images, which are addressed
    # by id and rendered rather than downloaded.
    name: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = now_col()


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_status_run_at", "status", "run_at"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    last_error: Mapped[str | None] = mapped_column(Text)
    run_at: Mapped[datetime] = now_col()
    created_at: Mapped[datetime] = now_col()
    updated_at: Mapped[datetime] = now_col()


class Link(Base):
    __tablename__ = "links"
    __table_args__ = (
        Index("ix_links_source", "source_card_id"),
        Index("ix_links_target", "target_card_id"),
        Index("ix_links_creator", "creator_id"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    creator_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    source_card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cards.id", ondelete="CASCADE"), nullable=False
    )
    target_card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cards.id", ondelete="CASCADE"), nullable=False
    )
    link_type: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    created_on_canvas_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("canvases.id", ondelete="SET NULL")
    )
    source_snapshot: Mapped[dict] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    target_snapshot: Mapped[dict] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = now_col()
    updated_at: Mapped[datetime] = now_col()


class Placement(Base):
    __tablename__ = "placements"
    __table_args__ = (
        UniqueConstraint("card_id", "canvas_id", name="uq_placements_card_canvas"),
        Index("ix_placements_canvas_id", "canvas_id"),
        Index("ix_placements_card_id", "card_id"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cards.id", ondelete="CASCADE"), nullable=False
    )
    canvas_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("canvases.id", ondelete="CASCADE"), nullable=False
    )
    x: Mapped[float] = mapped_column(Double, nullable=False)
    y: Mapped[float] = mapped_column(Double, nullable=False)
    w: Mapped[float] = mapped_column(Double, nullable=False, server_default=text("280"))
    h: Mapped[float] = mapped_column(Double, nullable=False, server_default=text("180"))
    z: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    # Folds this card's children down to titles on this canvas.
    is_hub: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    # Set when this card sits inside a column on this canvas. The column is
    # itself a placement, so a column can be moved and shared like any card.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("placements.id", ondelete="SET NULL")
    )
    sort: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    updated_at: Mapped[datetime] = now_col()

    card: Mapped[Card] = relationship(back_populates="placements")
    canvas: Mapped[Canvas] = relationship(back_populates="placements")


class Zone(Base):
    """A named spatial reading region on a canvas.

    Cards remain ordinary placements. Zone membership is derived from
    geometry, so moving a card or resizing a zone cannot leave a stale second
    source of truth behind.
    """

    __tablename__ = "zones"
    __table_args__ = (Index("ix_zones_canvas_sort", "canvas_id", "sort"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    canvas_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("canvases.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    x: Mapped[float] = mapped_column(Double, nullable=False)
    y: Mapped[float] = mapped_column(Double, nullable=False)
    w: Mapped[float] = mapped_column(Double, nullable=False, server_default=text("720"))
    h: Mapped[float] = mapped_column(Double, nullable=False, server_default=text("520"))
    sort: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[datetime] = now_col()
    updated_at: Mapped[datetime] = now_col()

    canvas: Mapped[Canvas] = relationship(back_populates="zones")
