import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

CardType = Literal[
    "text", "link", "youtube", "audio", "image", "board", "column", "file",
    "checklist", "table", "document", "portal",
]


class BoardRef(BaseModel):
    """Resolved on read for board cards, never written back. Keeps the tile's
    name and count honest without denormalising them into the payload."""

    canvas_id: uuid.UUID
    name: str
    card_count: int
    has_cover: bool
    role: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: str
    display_name: str
    is_admin: bool


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=1024)
    display_name: str = Field(min_length=1, max_length=200)
    invite_code: str | None = None


class LoginIn(BaseModel):
    email: str
    password: str


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    code: str
    expires_at: datetime
    used_by: uuid.UUID | None = None
    used_at: datetime | None = None


class InviteCreateIn(BaseModel):
    expires_in_days: int = Field(default=7, ge=1, le=365)


class CanvasOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    is_infinite: bool
    width: float
    height: float
    created_at: datetime
    updated_at: datetime


class CanvasListItem(CanvasOut):
    card_count: int
    role: str
    has_cover: bool = False
    # True when some board card points at this canvas, i.e. it lives inside
    # another board rather than at the top level.
    is_nested: bool = False


class BoardCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=500)
    x: float
    y: float
    width: float = Field(default=1920, ge=640, le=100_000)
    height: float = Field(default=1080, ge=480, le=100_000)


class CanvasNameIn(BaseModel):
    name: str = Field(min_length=1, max_length=500)


class CanvasCreateIn(CanvasNameIn):
    width: float = Field(default=1920, ge=640, le=100_000)
    height: float = Field(default=1080, ge=480, le=100_000)


class CanvasBoundsIn(BaseModel):
    width: float = Field(ge=640, le=100_000)
    height: float = Field(ge=480, le=100_000)


class CardOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    type: CardType
    title: str | None
    body: str | None
    payload: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    inbox_canvas_id: uuid.UUID | None = None
    # Populated for board cards whose target the reader can see.
    board: BoardRef | None = None


class PlacementOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    canvas_id: uuid.UUID
    card_id: uuid.UUID
    x: float
    y: float
    w: float
    h: float
    z: int
    is_hub: bool = False
    parent_id: uuid.UUID | None = None
    sort: int = 0
    updated_at: datetime


class PlacementWithCard(BaseModel):
    id: uuid.UUID
    x: float
    y: float
    w: float
    h: float
    z: int
    is_hub: bool = False
    parent_id: uuid.UUID | None = None
    sort: int = 0
    card: CardOut


class CanvasDetailOut(BaseModel):
    id: uuid.UUID
    name: str
    is_infinite: bool
    width: float
    height: float
    role: str
    has_cover: bool = False
    placements: list[PlacementWithCard]
    zones: list["ZoneOut"] = []
    # Links with both endpoints on this canvas, so the client can resolve
    # parent/child without a reveal request per card. Defined below; the model
    # is rebuilt at the end of this module.
    links: list["LinkOut"] = []


class CardCreateIn(BaseModel):
    type: CardType = "text"
    title: str | None = None
    body: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    canvas_id: uuid.UUID | None = None
    inbox_canvas_id: uuid.UUID | None = None
    x: float | None = None
    y: float | None = None


class CardCreateOut(BaseModel):
    card: CardOut
    placement: PlacementOut | None


class DailyCardOpenIn(BaseModel):
    day: date
    canvas_id: uuid.UUID
    x: float
    y: float


class DailyCardOut(BaseModel):
    card: CardOut | None
    placement: PlacementOut | None = None


class DailyTouchIn(BaseModel):
    day: date
    canvas_id: uuid.UUID | None = None


class FocusItemOut(BaseModel):
    card: CardOut
    placements: list["CardPlacementInfo"] = Field(default_factory=list)


class CardPatchIn(BaseModel):
    # None is a meaningful value for title/body, so use unset-tracking.
    model_config = ConfigDict(extra="forbid")
    title: str | None = None
    body: str | None = None
    payload: dict[str, Any] | None = None
    # Type conversion: a text card whose body turns out to be a URL becomes a
    # link/youtube card.
    type: CardType | None = None
    inbox_canvas_id: uuid.UUID | None = None


class ZoneCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    x: float
    y: float
    w: float = Field(default=720, gt=80)
    h: float = Field(default=520, gt=80)


class ZonePatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=200)
    x: float | None = None
    y: float | None = None
    w: float | None = Field(default=None, gt=80)
    h: float | None = Field(default=None, gt=80)
    sort: int | None = None


class ZoneOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    canvas_id: uuid.UUID
    name: str
    x: float
    y: float
    w: float
    h: float
    sort: int
    created_at: datetime
    updated_at: datetime


class PlacementCreateIn(BaseModel):
    card_id: uuid.UUID
    x: float
    y: float


class PlacementPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: float | None = None
    y: float | None = None
    w: float | None = Field(default=None, gt=0)
    h: float | None = Field(default=None, gt=0)
    z: int | None = None
    is_hub: bool | None = None
    # Explicit null means "take it out of its column", so this field has to
    # distinguish unset from null.
    parent_id: uuid.UUID | None = None
    clear_parent: bool = False
    sort: int | None = None


class CardPlacementInfo(BaseModel):
    id: uuid.UUID
    canvas_id: uuid.UUID
    canvas_name: str
    x: float
    y: float


class PortalItemOut(BaseModel):
    card: CardOut
    placements: list[CardPlacementInfo] = Field(default_factory=list)


class PortalOut(BaseModel):
    items: list[PortalItemOut]
    total: int
    source_name: str


class InboxOut(BaseModel):
    items: list[CardOut]
    next_cursor: str | None


class CaptureIn(BaseModel):
    text: str | None = None
    url: str | None = None
    title: str | None = None


class ApiTokenOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    created_at: datetime
    last_used_at: datetime | None


class ApiTokenCreated(ApiTokenOut):
    # Returned exactly once, at creation.
    token: str


class ApiTokenCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class PairingCodeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    code: str
    expires_at: datetime


class BotIdentityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    platform: str
    platform_user_id: str
    created_at: datetime


Role = Literal["viewer", "editor"]


class CanvasMemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    display_name: str
    role: Role


class CanvasShareIn(BaseModel):
    email: str
    role: Role = "viewer"


class CanvasMemberPatchIn(BaseModel):
    role: Role


class PublicLensPublishIn(BaseModel):
    """The exact canvas selection a person reviewed before making it public."""

    model_config = ConfigDict(extra="forbid")
    canvas_id: uuid.UUID
    placement_ids: list[uuid.UUID] = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=1000)
    view_mode: Literal["canvas", "presentation"] = "canvas"
    appearance: Literal["studio", "pantry", "night_garden"] = "studio"
    text_size: int = Field(default=13, ge=9, le=22)


class PublicLensOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    canvas_id: uuid.UUID | None
    slug: str
    title: str
    description: str | None
    revision: int
    published_at: datetime
    revoked_at: datetime | None
    created_at: datetime
    updated_at: datetime
    card_count: int = 0
    view_mode: Literal["canvas", "presentation"] = "canvas"


class AiSettingsIn(BaseModel):
    """Unset fields are left alone. An explicit empty string clears a value
    and lets the environment fallback take over again."""

    model_config = ConfigDict(extra="forbid")
    embedding_base_url: str | None = None
    embedding_model: str | None = None
    embedding_api_key: str | None = None
    embedding_dim: int | None = Field(default=None, ge=8, le=8192)
    whisper_base_url: str | None = None
    whisper_model: str | None = None
    whisper_api_key: str | None = None
    chat_base_url: str | None = None
    chat_model: str | None = None
    chat_api_key: str | None = None
    confirm_reembed: bool = False


class AiTestIn(BaseModel):
    """Values to test without saving them."""

    model_config = ConfigDict(extra="forbid")
    embedding_base_url: str | None = None
    embedding_model: str | None = None
    embedding_api_key: str | None = None


class GenerationTestIn(BaseModel):
    """Values to test without saving them."""

    model_config = ConfigDict(extra="forbid")
    chat_base_url: str | None = None
    chat_model: str | None = None
    chat_api_key: str | None = None


class SplitOut(BaseModel):
    batch_id: uuid.UUID
    status: str


class BatchStatusOut(BaseModel):
    batch_id: uuid.UUID
    status: str
    cards: list[CardOut]
    error: str | None = None


class ComposeIn(BaseModel):
    """Turn a small, explicit set of cards into one placed document."""

    model_config = ConfigDict(extra="forbid")
    card_ids: list[uuid.UUID] = Field(min_length=2, max_length=20)
    x: float
    y: float


class ComposeOut(BaseModel):
    batch_id: uuid.UUID
    status: str


class ComposeStatusOut(BaseModel):
    batch_id: uuid.UUID
    status: str
    card: CardOut | None = None
    placement: PlacementOut | None = None
    error: str | None = None


class SearchHit(BaseModel):
    card: CardOut
    placements: list[CardPlacementInfo]
    score: float
    source: Literal["text", "semantic"]


class LinkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    source_card_id: uuid.UUID | None
    target_card_id: uuid.UUID | None
    link_type: str | None
    note: str | None
    created_on_canvas_id: uuid.UUID | None
    source_snapshot: dict[str, Any]
    target_snapshot: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class LinkHit(BaseModel):
    """A link whose note matched, with the cards at either end.

    Both ends come back because a note on its own says nothing — "because the
    pricing model assumes retention" is only meaningful once you can see what
    it joins.
    """

    link: LinkOut
    source: CardOut | None
    target: CardOut | None
    score: float
    # Where each end can be reached. A result you cannot follow is a dead
    # end, and the note that matched is on the link rather than on either
    # card, so neither end necessarily turns up in the card hits where its
    # placements would otherwise have been resolved.
    source_placements: list[CardPlacementInfo] = []
    target_placements: list[CardPlacementInfo] = []


class SearchOut(BaseModel):
    hits: list[SearchHit]
    link_hits: list[LinkHit] = []
    modes_available: list[str]


class SuggestionOut(BaseModel):
    card: CardOut
    distance: float


class CanvasSuggestionOut(BaseModel):
    canvas_id: uuid.UUID
    canvas_name: str
    score: float


LINK_TYPES = ("supports", "contradicts", "source_for", "follows_from", "related")
LinkType = Literal["supports", "contradicts", "source_for", "follows_from", "related"]


class LinkCreateIn(BaseModel):
    source_card_id: uuid.UUID
    target_card_id: uuid.UUID
    link_type: LinkType | None = None
    note: str | None = None
    created_on_canvas_id: uuid.UUID | None = None


class LinkPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    link_type: LinkType | None = None
    note: str | None = None


class RevealLink(LinkOut):
    hop: int


class RevealCardEntry(BaseModel):
    card: CardOut
    placement: PlacementOut | None
    home_canvas_id: uuid.UUID | None
    home_canvas_name: str | None


class RevealOut(BaseModel):
    root_card_id: uuid.UUID
    links: list[RevealLink]
    cards: dict[str, RevealCardEntry]


CanvasDetailOut.model_rebuild()
FocusItemOut.model_rebuild()
