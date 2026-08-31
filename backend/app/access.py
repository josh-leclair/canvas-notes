"""Every visibility and permission rule in one place.

The shape of the model:

- A canvas is visible to its owner and its members; editable by its owner and
  its `editor` members; only the owner may rename, delete, or reshare it.
- A card is visible if you own it or it is placed on a canvas you can see.
  This is derived on every read, never stored.
- A card's content is editable by its owner and by editors of any canvas it
  sits on. Only the owner may delete the card itself.
- A link is visible to anyone who can see *both* of its endpoints, whoever
  created it. Hard-deleting either card deletes the relationship as well.
"""
import uuid

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session as DbSession
from sqlalchemy.sql.elements import ColumnElement

from app.errors import ApiError, not_found
from app.models import Canvas, CanvasMember, Card, Link, Placement, User

ROLE_VIEWER = "viewer"
ROLE_EDITOR = "editor"


# --- canvases -------------------------------------------------------------


def canvas_role(db: DbSession, user: User, canvas: Canvas) -> str | None:
    """'owner', 'editor', 'viewer', or None."""
    if canvas.owner_id == user.id:
        return "owner"
    member = db.get(CanvasMember, (canvas.id, user.id))
    return member.role if member else None


def visible_canvas_condition(user_id: uuid.UUID) -> ColumnElement[bool]:
    return or_(
        Canvas.owner_id == user_id,
        exists(
            select(1).where(
                CanvasMember.canvas_id == Canvas.id,
                CanvasMember.user_id == user_id,
            )
        ),
    )


def get_viewable_canvas(db: DbSession, user: User, canvas_id: uuid.UUID) -> Canvas:
    canvas = db.get(Canvas, canvas_id)
    if canvas is None or canvas_role(db, user, canvas) is None:
        raise not_found()
    return canvas


def get_editable_canvas(db: DbSession, user: User, canvas_id: uuid.UUID) -> Canvas:
    canvas = db.get(Canvas, canvas_id)
    role = canvas_role(db, user, canvas) if canvas else None
    if canvas is None or role is None:
        raise not_found()
    if role == ROLE_VIEWER:
        raise ApiError(403, "read_only", "You have view-only access to this canvas")
    return canvas


def get_owned_canvas(db: DbSession, user: User, canvas_id: uuid.UUID) -> Canvas:
    """Owner only: renaming, deleting, and sharing are not delegated."""
    canvas = db.get(Canvas, canvas_id)
    if canvas is None or canvas_role(db, user, canvas) is None:
        raise not_found()
    if canvas.owner_id != user.id:
        raise ApiError(403, "owner_only", "Only the canvas owner can do that")
    return canvas


# --- cards ----------------------------------------------------------------


def _placed_on_canvas_where(user_id: uuid.UUID, editor_only: bool) -> ColumnElement[bool]:
    member_condition = CanvasMember.user_id == user_id
    if editor_only:
        member_condition = and_(member_condition, CanvasMember.role == ROLE_EDITOR)
    return exists(
        select(1)
        .select_from(Placement)
        .join(Canvas, Canvas.id == Placement.canvas_id)
        .where(
            Placement.card_id == Card.id,
            or_(
                Canvas.owner_id == user_id,
                exists(
                    select(1).where(
                        CanvasMember.canvas_id == Canvas.id, member_condition
                    )
                ),
            ),
        )
    )


def visible_card_condition(user_id: uuid.UUID) -> ColumnElement[bool]:
    return or_(Card.owner_id == user_id, _placed_on_canvas_where(user_id, False))


def editable_card_condition(user_id: uuid.UUID) -> ColumnElement[bool]:
    return or_(Card.owner_id == user_id, _placed_on_canvas_where(user_id, True))


def _card_matching(
    db: DbSession, user: User, card_id: uuid.UUID, condition: ColumnElement[bool]
) -> Card:
    card = db.scalar(select(Card).where(Card.id == card_id, condition))
    if card is None:
        raise not_found()
    return card


def get_visible_card(db: DbSession, user: User, card_id: uuid.UUID) -> Card:
    return _card_matching(db, user, card_id, visible_card_condition(user.id))


def get_editable_card(db: DbSession, user: User, card_id: uuid.UUID) -> Card:
    # A card you can see but not edit should 403, not 404: you already know
    # it exists.
    card = db.scalar(
        select(Card).where(Card.id == card_id, visible_card_condition(user.id))
    )
    if card is None:
        raise not_found()
    if db.scalar(
        select(Card.id).where(Card.id == card_id, editable_card_condition(user.id))
    ) is None:
        raise ApiError(403, "read_only", "You have view-only access to this card")
    return card


def get_owned_card(db: DbSession, user: User, card_id: uuid.UUID) -> Card:
    """Owner only: deleting a card destroys it for everyone."""
    card = db.scalar(
        select(Card).where(Card.id == card_id, visible_card_condition(user.id))
    )
    if card is None:
        raise not_found()
    if card.owner_id != user.id:
        raise ApiError(403, "owner_only", "Only the card's owner can do that")
    return card


# --- links ----------------------------------------------------------------


def _endpoint_visible(
    column, user_id: uuid.UUID
) -> ColumnElement[bool]:
    """An endpoint is visible only while its card is visible."""
    return exists(
        select(1).where(Card.id == column, visible_card_condition(user_id))
    )


def visible_link_condition(user_id: uuid.UUID) -> ColumnElement[bool]:
    return and_(
        _endpoint_visible(Link.source_card_id, user_id),
        _endpoint_visible(Link.target_card_id, user_id),
    )


def get_own_link(db: DbSession, user: User, link_id: uuid.UUID) -> Link:
    """Editing or deleting a link is the creator's alone."""
    link = db.scalar(
        select(Link).where(Link.id == link_id, visible_link_condition(user.id))
    )
    if link is None:
        raise not_found()
    if link.creator_id != user.id:
        raise ApiError(403, "creator_only", "Only the link's creator can do that")
    return link
