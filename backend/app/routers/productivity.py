import uuid
from datetime import date

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select, text
from sqlalchemy.orm import Session as DbSession

from app.access import (
    get_editable_canvas,
    get_visible_card,
    visible_canvas_condition,
    visible_card_condition,
)
from app.auth import get_current_user
from app.boards import resolve_boards
from app.db import get_db
from app.jobs import enqueue_embed_if_needed
from app.models import Canvas, Card, FocusItem, Link, Placement, User
from app.schemas.api import (
    CardOut,
    CardPlacementInfo,
    DailyCardOpenIn,
    DailyCardOut,
    DailyTouchIn,
    FocusItemOut,
    LinkOut,
)

router = APIRouter(prefix="/api")


def _daily_card(db: DbSession, user: User, day: date) -> Card | None:
    return db.scalar(
        select(Card).where(
            Card.owner_id == user.id,
            Card.payload["daily_card"]["date"].astext == day.isoformat(),
        )
    )


def _snapshot(card: Card) -> dict:
    return {
        "title": card.title,
        "url": card.payload.get("url"),
        "excerpt": (card.body or str(card.payload.get("description") or ""))[:200]
        or None,
    }


@router.get("/daily-cards/{day}", response_model=DailyCardOut)
def get_daily_card(
    day: date,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    card = _daily_card(db, user, day)
    return DailyCardOut(card=CardOut.model_validate(card) if card else None)


@router.post("/daily-cards/open", response_model=DailyCardOut)
def open_daily_card(
    body: DailyCardOpenIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Get today's ordinary card and ensure it is visible on this canvas."""
    canvas = get_editable_canvas(db, user, body.canvas_id)
    # The unique index is the final guard, while this lock makes a double
    # click deterministic instead of letting one of two concurrent inserts
    # lose with an IntegrityError.
    db.execute(
        text("select pg_advisory_xact_lock(hashtext(:key))"),
        {"key": f"daily:{user.id}:{body.day.isoformat()}"},
    )
    card = _daily_card(db, user, body.day)
    if card is None:
        card = Card(
            owner_id=user.id,
            type="text",
            title=body.day.strftime("%A, %B %d, %Y").replace(" 0", " "),
            body=(
                "## Notes\n\n"
                "## Activity\n\n"
                "Cards you work with today are connected here automatically."
            ),
            payload={"daily_card": {"date": body.day.isoformat()}},
        )
        db.add(card)
        db.flush()
        enqueue_embed_if_needed(db, card)

    placement = db.scalar(
        select(Placement).where(
            Placement.card_id == card.id, Placement.canvas_id == canvas.id
        )
    )
    if placement is None:
        placement = Placement(
            card_id=card.id, canvas_id=canvas.id, x=body.x, y=body.y, w=300, h=260
        )
        db.add(placement)
        db.flush()
    return DailyCardOut(card=CardOut.model_validate(card), placement=placement)


@router.post("/daily-cards/{card_id}/touch", response_model=LinkOut | None)
def touch_daily_card(
    card_id: uuid.UUID,
    body: DailyTouchIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Connect a deliberately touched card to today's card, if it exists."""
    daily = _daily_card(db, user, body.day)
    if daily is None or daily.id == card_id:
        return None
    target = get_visible_card(db, user, card_id)
    existing = db.scalar(
        select(Link).where(
            Link.creator_id == user.id,
            Link.source_card_id == daily.id,
            Link.target_card_id == target.id,
            Link.link_type == "touched",
        )
    )
    if existing is not None:
        return existing

    canvas_id = None
    if body.canvas_id is not None:
        canvas_id = db.scalar(
            select(Canvas.id).where(
                Canvas.id == body.canvas_id, visible_canvas_condition(user.id)
            )
        )
    link = Link(
        creator_id=user.id,
        source_card_id=daily.id,
        target_card_id=target.id,
        link_type="touched",
        created_on_canvas_id=canvas_id,
        source_snapshot=_snapshot(daily),
        target_snapshot=_snapshot(target),
    )
    db.add(link)
    db.flush()
    return link


@router.get("/focus-shelf", response_model=list[FocusItemOut])
def focus_shelf(
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    rows = db.execute(
        select(FocusItem, Card)
        .join(Card, Card.id == FocusItem.card_id)
        .where(FocusItem.user_id == user.id, visible_card_condition(user.id))
        .order_by(FocusItem.created_at)
    ).all()
    if not rows:
        return []

    card_ids = [card.id for _, card in rows]
    placements = db.execute(
        select(Placement, Canvas.name)
        .join(Canvas, Canvas.id == Placement.canvas_id)
        .where(
            Placement.card_id.in_(card_ids), visible_canvas_condition(user.id)
        )
        .order_by(Placement.updated_at.desc())
    ).all()
    by_card: dict[uuid.UUID, list[CardPlacementInfo]] = {}
    for placement, canvas_name in placements:
        by_card.setdefault(placement.card_id, []).append(
            CardPlacementInfo(
                id=placement.id,
                canvas_id=placement.canvas_id,
                canvas_name=canvas_name,
                x=placement.x,
                y=placement.y,
            )
        )
    boards = resolve_boards(db, user, [card for _, card in rows])
    return [
        FocusItemOut(
            card=CardOut.model_validate(card).model_copy(
                update={"board": boards.get(card.id)}
            ),
            placements=by_card.get(card.id, []),
        )
        for _, card in rows
    ]


@router.put("/focus-shelf/{card_id}", status_code=204)
def add_to_focus_shelf(
    card_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    card = get_visible_card(db, user, card_id)
    if db.get(FocusItem, (user.id, card.id)) is None:
        db.add(FocusItem(user_id=user.id, card_id=card.id))
    return Response(status_code=204)


@router.delete("/focus-shelf/{card_id}", status_code=204)
def remove_from_focus_shelf(
    card_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    item = db.get(FocusItem, (user.id, card_id))
    if item is not None:
        db.delete(item)
    return Response(status_code=204)
