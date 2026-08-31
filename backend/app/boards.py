"""Board cards: a card that stands for another canvas.

Nesting is derived rather than stored. A canvas sits "inside" another exactly
when a board card on that canvas points at it, which is the same move the
inbox makes ("cards with zero placements") — there is no second source of
truth to fall out of step, and a board can appear on several canvases just as
a card can.
"""
import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.access import canvas_role, visible_canvas_condition
from app.models import Canvas, Card, Placement, User
from app.schemas.api import BoardRef


def board_target_id(card: Card) -> uuid.UUID | None:
    """The canvas a board card points at, if it is a well-formed one."""
    if card.type != "board":
        return None
    raw = card.payload.get("canvas_id")
    if not raw:
        return None
    try:
        return uuid.UUID(str(raw))
    except ValueError:
        return None


def resolve_boards(
    db: DbSession, user: User, cards: list[Card]
) -> dict[uuid.UUID, BoardRef]:
    """Name, card count and cover for every board card the reader can follow.

    One query for the canvases and one for the counts, whatever the number of
    board cards on the canvas.
    """
    wanted: dict[uuid.UUID, uuid.UUID] = {}
    for card in cards:
        target = board_target_id(card)
        if target is not None:
            wanted[card.id] = target
    if not wanted:
        return {}

    targets = set(wanted.values())
    canvases = {
        c.id: c
        for c in db.scalars(
            select(Canvas).where(
                Canvas.id.in_(targets), visible_canvas_condition(user.id)
            )
        )
    }
    if not canvases:
        return {}

    counts = dict(
        db.execute(
            select(Placement.canvas_id, func.count(Placement.id))
            .where(Placement.canvas_id.in_(canvases.keys()))
            .group_by(Placement.canvas_id)
        ).all()
    )

    out: dict[uuid.UUID, BoardRef] = {}
    for card_id, target in wanted.items():
        canvas = canvases.get(target)
        if canvas is None:
            # Deleted, or shared away. The card still renders, just without a
            # destination — the same spirit as a tombstone.
            continue
        out[card_id] = BoardRef(
            canvas_id=canvas.id,
            name=canvas.name,
            card_count=counts.get(canvas.id, 0),
            has_cover=bool(canvas.cover_path),
            role=canvas_role(db, user, canvas) or "viewer",
        )
    return out


def nested_canvas_ids(db: DbSession, user: User) -> set[uuid.UUID]:
    """Canvases that some visible board card points at.

    Used by the canvas list to keep nested boards out of the top level, so the
    list shows what you would call your projects rather than every board that
    exists.
    """
    rows = db.scalars(
        select(Card.payload).where(
            Card.type == "board", Card.owner_id == user.id
        )
    ).all()
    ids: set[uuid.UUID] = set()
    for payload in rows:
        raw = (payload or {}).get("canvas_id")
        if not raw:
            continue
        try:
            ids.add(uuid.UUID(str(raw)))
        except ValueError:
            continue
    return ids
