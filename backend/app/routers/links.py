import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session as DbSession

from app.access import (
    get_own_link,
    get_visible_card,
    visible_canvas_condition,
    visible_card_condition,
    visible_link_condition,
)
from app.auth import get_current_user
from app.db import get_db
from app.errors import ApiError
from app.models import Canvas, Card, Link, Placement, User
from app.schemas.api import (
    CardOut,
    LinkCreateIn,
    LinkOut,
    LinkPatchIn,
    PlacementOut,
    RevealCardEntry,
    RevealLink,
    RevealOut,
)

router = APIRouter(prefix="/api")

EXCERPT_LENGTH = 200


def snapshot_of(card: Card) -> dict:
    """Captured at link time; shown only when the endpoint is unreachable."""
    excerpt_source = card.body or str(card.payload.get("description") or "")
    return {
        "title": card.title,
        "url": card.payload.get("url"),
        "excerpt": excerpt_source[:EXCERPT_LENGTH] or None,
    }


@router.post("/links", status_code=201, response_model=LinkOut)
def create_link(
    body: LinkCreateIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    if body.source_card_id == body.target_card_id:
        raise ApiError(400, "self_link", "A card cannot link to itself")
    # Viewers may link cards they can see: a link is the creator's own data,
    # not a mutation of the canvas.
    source = get_visible_card(db, user, body.source_card_id)
    target = get_visible_card(db, user, body.target_card_id)

    canvas_id = None
    if body.created_on_canvas_id is not None:
        canvas = db.scalar(
            select(Canvas).where(
                Canvas.id == body.created_on_canvas_id,
                visible_canvas_condition(user.id),
            )
        )
        if canvas is not None:
            canvas_id = canvas.id

    link = Link(
        creator_id=user.id,
        source_card_id=source.id,
        target_card_id=target.id,
        link_type=body.link_type,
        note=body.note,
        created_on_canvas_id=canvas_id,
        source_snapshot=snapshot_of(source),
        target_snapshot=snapshot_of(target),
    )
    db.add(link)
    db.flush()
    return link


@router.patch("/links/{link_id}", response_model=LinkOut)
def patch_link(
    link_id: uuid.UUID,
    body: LinkPatchIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    link = get_own_link(db, user, link_id)
    fields = body.model_dump(exclude_unset=True)
    for key in ("link_type", "note"):
        if key in fields:
            setattr(link, key, fields[key])
    link.updated_at = datetime.now(timezone.utc)
    return link


@router.post("/links/{link_id}/flip", response_model=LinkOut)
def flip_link(
    link_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Turn a link around: what pointed A to B now points B to A.

    A separate endpoint rather than two fields on the PATCH, because the
    endpoints are the one part of a link that is not free-form. Letting a
    client send arbitrary `source_card_id`/`target_card_id` would make PATCH a
    way to re-point a link at any card the user can see, and every visibility
    rule the link already carries would have to be re-checked there. A flip
    re-points nothing: the same two cards stay attached, so nothing about who
    can see this link can change.

    The snapshots swap with the ids. They are the fallback shown when an
    endpoint is deleted, and leaving them behind would caption a tombstone
    with the wrong card's title.
    """
    link = get_own_link(db, user, link_id)
    link.source_card_id, link.target_card_id = link.target_card_id, link.source_card_id
    link.source_snapshot, link.target_snapshot = (
        link.target_snapshot,
        link.source_snapshot,
    )
    link.updated_at = datetime.now(timezone.utc)
    return link


@router.delete("/links/{link_id}", status_code=204)
def delete_link(
    link_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    link = get_own_link(db, user, link_id)
    db.delete(link)


@router.get("/cards/search", response_model=list[CardOut])
def search_cards(
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=20, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Substring search for the link picker. Full search is /api/search."""
    pattern = f"%{q}%"
    return db.scalars(
        select(Card)
        .where(
            visible_card_condition(user.id),
            or_(Card.title.ilike(pattern), Card.body.ilike(pattern)),
        )
        .order_by(Card.updated_at.desc())
        .limit(limit)
    ).all()


def _links_touching(db: DbSession, user: User, card_ids: set[uuid.UUID]) -> list[Link]:
    if not card_ids:
        return []
    return list(
        db.scalars(
            select(Link).where(
                visible_link_condition(user.id),
                or_(
                    Link.source_card_id.in_(card_ids),
                    Link.target_card_id.in_(card_ids),
                ),
            )
        )
    )


@router.get("/cards/{card_id}/reveal", response_model=RevealOut)
def reveal(
    card_id: uuid.UUID,
    canvas_id: uuid.UUID | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    root = get_visible_card(db, user, card_id)

    # Hop 1: both directions from the root.
    hop1 = _links_touching(db, user, {root.id})
    seen: dict[uuid.UUID, RevealLink] = {}
    for link in hop1:
        seen[link.id] = RevealLink.model_validate({**link.__dict__, "hop": 1})

    children = {
        l.target_card_id for l in hop1 if l.source_card_id == root.id and l.target_card_id
    }
    parents = {
        l.source_card_id for l in hop1 if l.target_card_id == root.id and l.source_card_id
    }

    # Hop 2 is direction locked: children of children, parents of parents,
    # never sideways. This is what keeps a popular hub card from lighting up
    # its whole neighborhood through shared parents.
    if children:
        for link in db.scalars(
            select(Link).where(
                visible_link_condition(user.id), Link.source_card_id.in_(children)
            )
        ):
            if link.id not in seen:
                seen[link.id] = RevealLink.model_validate({**link.__dict__, "hop": 2})
    if parents:
        for link in db.scalars(
            select(Link).where(
                visible_link_condition(user.id), Link.target_card_id.in_(parents)
            )
        ):
            if link.id not in seen:
                seen[link.id] = RevealLink.model_validate({**link.__dict__, "hop": 2})

    links = list(seen.values())

    involved: set[uuid.UUID] = {root.id}
    for link in links:
        if link.source_card_id:
            involved.add(link.source_card_id)
        if link.target_card_id:
            involved.add(link.target_card_id)

    cards = db.scalars(
        select(Card).where(Card.id.in_(involved), visible_card_condition(user.id))
    ).all()
    visible_canvases = {
        c.id: c.name
        for c in db.scalars(select(Canvas).where(visible_canvas_condition(user.id)))
    }
    placements = db.scalars(
        select(Placement).where(
            Placement.card_id.in_(involved),
            Placement.canvas_id.in_(visible_canvases.keys() or [uuid.uuid4()]),
        )
    ).all()

    by_card: dict[uuid.UUID, list[Placement]] = {}
    for p in placements:
        by_card.setdefault(p.card_id, []).append(p)

    entries: dict[str, RevealCardEntry] = {}
    for card in cards:
        card_placements = by_card.get(card.id, [])
        here = next((p for p in card_placements if p.canvas_id == canvas_id), None)
        # A ghost is labeled with its home canvas; unplaced cards live in the inbox.
        home = card_placements[0] if card_placements else None
        entries[str(card.id)] = RevealCardEntry(
            card=CardOut.model_validate(card),
            placement=PlacementOut.model_validate(here) if here else None,
            home_canvas_id=home.canvas_id if home else None,
            home_canvas_name=visible_canvases.get(home.canvas_id) if home else None,
        )

    return RevealOut(root_card_id=root.id, links=links, cards=entries)


@router.get("/cards/{card_id}/link-candidates", response_model=list[CardOut])
def link_candidates(
    card_id: uuid.UUID,
    limit: int = Query(default=10, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Recently touched cards, for the picker before anything is typed."""
    card = get_visible_card(db, user, card_id)
    linked = _linked_card_ids(db, user, card.id)
    return db.scalars(
        select(Card)
        .where(
            visible_card_condition(user.id),
            Card.id != card.id,
            Card.id.notin_(linked or [uuid.uuid4()]),
        )
        .order_by(Card.updated_at.desc())
        .limit(limit)
    ).all()


def _linked_card_ids(db: DbSession, user: User, card_id: uuid.UUID) -> set[uuid.UUID]:
    rows = db.execute(
        select(Link.source_card_id, Link.target_card_id).where(
            visible_link_condition(user.id),
            or_(Link.source_card_id == card_id, Link.target_card_id == card_id),
        )
    ).all()
    ids: set[uuid.UUID] = set()
    for source, target in rows:
        if source:
            ids.add(source)
        if target:
            ids.add(target)
    return ids
