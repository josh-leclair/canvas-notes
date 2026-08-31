import base64
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy import func, or_, select, tuple_
from sqlalchemy.orm import Session as DbSession

from app.access import (
    get_editable_canvas,
    get_editable_card,
    get_owned_card,
    get_viewable_canvas,
    get_visible_card,
    visible_canvas_condition,
    visible_card_condition,
)
from app.auth import get_current_user
from app.boards import resolve_boards
from app.db import get_db
from app.document_export import (
    citation_ids,
    docx_bytes,
    export_markdown,
    pdf_bytes,
    safe_filename,
)
from app.errors import ApiError, not_found
from app.generate import DEFAULT_CARD_LIMIT, MIN_SPLIT_CHARS, splittable_text
from app.jobs import (
    enqueue,
    enqueue_embed_if_needed,
    enqueue_spotify_if_needed,
    enqueue_unfurl_if_needed,
    enqueue_youtube_attachment_if_needed,
    generation_available,
    spotify_url_for_card,
    youtube_url_for_card,
)
from app.models import Canvas, Card, Job, Link, Placement, User
from app.runtime_settings import get_ai_config
from app.structured import normalise
from app.schemas.api import (
    BatchStatusOut,
    CardCreateIn,
    CardCreateOut,
    CardOut,
    CardPatchIn,
    CardPlacementInfo,
    ComposeIn,
    ComposeOut,
    ComposeStatusOut,
    InboxOut,
    PlacementOut,
    PortalItemOut,
    PortalOut,
    SplitOut,
)

router = APIRouter(prefix="/api")
CARD_REFERENCE_RE = re.compile(
    r"\]\(card:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)"
)
PORTAL_FILTER_TYPES = {
    "text", "link", "youtube", "audio", "image", "board", "column", "file",
    "checklist", "table", "document",
}


def _portal_settings(
    card: Card,
) -> tuple[str, uuid.UUID | None, str, str, bool, str, int, int]:
    """Read a portal payload defensively.

    Payloads remain ordinary JSON so an old client can still copy or export a
    portal card. A malformed filter becomes a harmless broad portal rather
    than turning the canvas itself into a 500 response.
    """
    payload = card.payload or {}
    scope = "canvas" if payload.get("scope") == "canvas" else "workspace"
    canvas_id = None
    if scope == "canvas":
        try:
            canvas_id = uuid.UUID(str(payload.get("canvas_id")))
        except (TypeError, ValueError):
            canvas_id = None
    query = str(payload.get("query") or "").strip()[:200]
    raw_type = str(payload.get("card_type") or "any")
    card_type = raw_type if raw_type in PORTAL_FILTER_TYPES else "any"
    open_tasks = bool(payload.get("open_tasks"))
    timeframe = "today" if payload.get("timeframe") == "today" else "any"
    try:
        timezone_offset = max(
            -840, min(840, int(payload.get("timezone_offset_minutes", 0)))
        )
    except (TypeError, ValueError):
        timezone_offset = 0
    try:
        limit = max(1, min(50, int(payload.get("limit", 20))))
    except (TypeError, ValueError):
        limit = 20
    return scope, canvas_id, query, card_type, open_tasks, timeframe, timezone_offset, limit


def _reference_snapshot(card: Card) -> dict:
    return {
        "title": card.title,
        "url": card.payload.get("url"),
        "excerpt": (card.body or str(card.payload.get("description") or ""))[:200]
        or None,
    }


def sync_card_references(db: DbSession, user: User, card: Card) -> None:
    """Make inline `card:` links and graph relationships agree.

    These links are derived from the body, like inbox membership is derived
    from placements. Saving a document after removing a reference removes the
    relationship too, so inline authoring cannot accumulate invisible edges.
    """
    requested = {
        uuid.UUID(raw)
        for raw in CARD_REFERENCE_RE.findall(card.body or "")
        if raw.lower() != str(card.id).lower()
    }
    targets = (
        list(
            db.scalars(
                select(Card).where(
                    Card.id.in_(requested), visible_card_condition(user.id)
                )
            )
        )
        if requested
        else []
    )
    desired = {target.id: target for target in targets}
    existing = list(
        db.scalars(
            select(Link).where(
                Link.source_card_id == card.id, Link.link_type == "references"
            )
        )
    )
    kept: set[uuid.UUID] = set()
    for link in existing:
        target_id = link.target_card_id
        if target_id in desired and target_id not in kept:
            kept.add(target_id)
        else:
            db.delete(link)
    for target_id, target in desired.items():
        if target_id in kept:
            continue
        db.add(
            Link(
                creator_id=user.id,
                source_card_id=card.id,
                target_card_id=target.id,
                link_type="references",
                source_snapshot=_reference_snapshot(card),
                target_snapshot=_reference_snapshot(target),
            )
        )


@router.post("/cards", status_code=201, response_model=CardCreateOut)
def create_card(
    body: CardCreateIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    placement = None
    canvas = None
    inbox_canvas = None
    if body.canvas_id is not None and body.inbox_canvas_id is not None:
        raise ApiError(
            400,
            "two_destinations",
            "A card can be placed on a canvas or sent to its inbox, not both",
        )
    if body.canvas_id is not None:
        if body.x is None or body.y is None:
            raise ApiError(400, "position_required", "x and y are required with canvas_id")
        canvas = get_editable_canvas(db, user, body.canvas_id)
    elif body.inbox_canvas_id is not None:
        inbox_canvas = get_editable_canvas(db, user, body.inbox_canvas_id)

    card = Card(
        owner_id=user.id,
        type=body.type,
        title=body.title,
        body=body.body,
        payload=body.payload,
        inbox_canvas_id=inbox_canvas.id if inbox_canvas is not None else None,
    )
    # A checklist or a table carries its structure in the payload; the body is
    # a mirror of it, written here so the two can never disagree.
    structured = normalise(card.type, card.payload)
    if structured is not None:
        card.payload, card.body = structured
    db.add(card)
    db.flush()
    sync_card_references(db, user, card)
    enqueue_unfurl_if_needed(db, card)
    enqueue_spotify_if_needed(db, card)
    enqueue_youtube_attachment_if_needed(db, card)
    enqueue_embed_if_needed(db, card)

    if canvas is not None:
        placement = Placement(card_id=card.id, canvas_id=canvas.id, x=body.x, y=body.y)
        db.add(placement)
        db.flush()

    return CardCreateOut(card=CardOut.model_validate(card), placement=placement)


@router.patch("/cards/{card_id}", response_model=CardOut)
def patch_card(
    card_id: uuid.UUID,
    body: CardPatchIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    card = get_editable_card(db, user, card_id)
    fields = body.model_dump(exclude_unset=True)
    old_url = card.payload.get("url")
    old_type = card.type
    old_spotify_url = spotify_url_for_card(card)
    old_youtube_url = youtube_url_for_card(card)
    if "inbox_canvas_id" in fields:
        destination = fields.pop("inbox_canvas_id")
        if destination is not None:
            destination = get_editable_canvas(db, user, destination).id
        card.inbox_canvas_id = destination
    for key in ("title", "body", "payload"):
        if key in fields:
            setattr(card, key, fields[key])
    if fields.get("type") is not None:
        card.type = fields["type"]
    # Regenerated rather than trusted: the client sends the structure, and
    # the body it implies is derived here every time.
    structured = normalise(card.type, card.payload)
    if structured is not None:
        card.payload, card.body = structured
    card.updated_at = datetime.now(timezone.utc)
    if card.payload.get("url") != old_url or card.type != old_type:
        enqueue_unfurl_if_needed(db, card)
    enqueue_spotify_if_needed(db, card, old_spotify_url)
    enqueue_youtube_attachment_if_needed(db, card, old_youtube_url)
    if {"title", "body", "payload"} & fields.keys():
        enqueue_embed_if_needed(db, card)
    if "body" in fields:
        sync_card_references(db, user, card)
    return CardOut.model_validate(card).model_copy(
        update={"board": resolve_boards(db, user, [card]).get(card.id)}
    )


@router.delete("/cards/{card_id}", status_code=204)
def delete_card(
    card_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    # Owner only. The database cascades every relationship touching this
    # card: remove-from-canvas is the reversible operation, while Delete card
    # is deliberately final and must not leave restore prompts behind.
    card = get_owned_card(db, user, card_id)
    db.delete(card)


@router.get("/cards/{card_id}/placements", response_model=list[CardPlacementInfo])
def card_placements(
    card_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    card = get_visible_card(db, user, card_id)
    rows = db.execute(
        select(Placement, Canvas.name)
        .join(Canvas, Canvas.id == Placement.canvas_id)
        .where(Placement.card_id == card.id, visible_canvas_condition(user.id))
        .order_by(Placement.updated_at.desc())
    ).all()
    return [
        CardPlacementInfo(
            id=p.id, canvas_id=p.canvas_id, canvas_name=name, x=p.x, y=p.y
        )
        for p, name in rows
    ]


@router.get("/cards/{card_id}/export")
def export_document(
    card_id: uuid.UUID,
    format: Literal["markdown", "docx", "pdf"] = Query(default="markdown"),
    include_citations: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    card = get_visible_card(db, user, card_id)
    if card.type != "document":
        raise ApiError(400, "not_a_document", "Only documents can be exported")

    requested = citation_ids(card.body or "") if include_citations else []
    visible_citations = (
        list(
            db.scalars(
                select(Card).where(
                    Card.id.in_([uuid.UUID(raw_id) for raw_id in requested]),
                    visible_card_condition(user.id),
                )
            )
        )
        if requested
        else []
    )
    citations = {
        str(citation.id).lower(): (citation.title, citation.body)
        for citation in visible_citations
    }
    markdown = export_markdown(
        card.title, card.body, citations, include_citations=include_citations
    )
    filename = safe_filename(card.title)
    if format == "docx":
        content = docx_bytes(markdown)
        extension = "docx"
        media_type = (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
    elif format == "pdf":
        content = pdf_bytes(markdown)
        extension = "pdf"
        media_type = "application/pdf"
    else:
        content = markdown.encode("utf-8")
        extension = "md"
        media_type = "text/markdown; charset=utf-8"

    encoded = quote(f"{filename}.{extension}")
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded}"},
    )


@router.get("/cards/{card_id}/portal", response_model=PortalOut)
def portal_contents(
    card_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Resolve a portal card into a current, permission-filtered view.

    Nothing is copied into the portal. Changing, moving, or deleting a source
    card is reflected the next time this endpoint is read.
    """
    portal = get_visible_card(db, user, card_id)
    if portal.type != "portal":
        raise ApiError(409, "not_a_portal", "This card is not a portal")

    (
        scope,
        canvas_id,
        query,
        card_type,
        open_tasks,
        timeframe,
        timezone_offset,
        limit,
    ) = _portal_settings(portal)
    conditions = [
        visible_card_condition(user.id),
        Card.id != portal.id,
        Card.type != "portal",
    ]
    source_name = "All cards"
    statement = select(Card)
    if scope == "canvas":
        if canvas_id is None:
            return PortalOut(items=[], total=0, source_name="Unavailable canvas")
        canvas = db.scalar(
            select(Canvas).where(
                Canvas.id == canvas_id, visible_canvas_condition(user.id)
            )
        )
        if canvas is None:
            return PortalOut(items=[], total=0, source_name="Unavailable canvas")
        source_name = canvas.name
        statement = statement.join(Placement, Placement.card_id == Card.id).where(
            Placement.canvas_id == canvas.id
        )
    if query:
        pattern = f"%{query}%"
        conditions.append(
            or_(Card.title.ilike(pattern), Card.body.ilike(pattern))
        )
    if card_type != "any":
        conditions.append(Card.type == card_type)
    if open_tasks:
        conditions.append(
            or_(Card.body.contains("- [ ]"), Card.body.contains("* [ ]"))
        )
    if timeframe == "today":
        offset = timedelta(minutes=timezone_offset)
        local_now = datetime.now(timezone.utc) - offset
        start = local_now.replace(hour=0, minute=0, second=0, microsecond=0) + offset
        conditions.append(Card.updated_at >= start)

    statement = statement.where(*conditions)
    total = int(
        db.scalar(
            select(func.count()).select_from(statement.order_by(None).subquery())
        )
        or 0
    )
    cards = list(
        db.scalars(statement.order_by(Card.updated_at.desc(), Card.id.desc()).limit(limit))
    )
    card_ids = [card.id for card in cards]
    placement_rows = (
        db.execute(
            select(Placement, Canvas.name)
            .join(Canvas, Canvas.id == Placement.canvas_id)
            .where(
                Placement.card_id.in_(card_ids),
                visible_canvas_condition(user.id),
            )
            .order_by(Placement.updated_at.desc())
        ).all()
        if card_ids
        else []
    )
    placements: dict[uuid.UUID, list[CardPlacementInfo]] = {}
    for placement, canvas_name in placement_rows:
        placements.setdefault(placement.card_id, []).append(
            CardPlacementInfo(
                id=placement.id,
                canvas_id=placement.canvas_id,
                canvas_name=canvas_name,
                x=placement.x,
                y=placement.y,
            )
        )
    boards = resolve_boards(db, user, cards)
    return PortalOut(
        items=[
            PortalItemOut(
                card=CardOut.model_validate(card).model_copy(
                    update={"board": boards.get(card.id)}
                ),
                placements=placements.get(card.id, []),
            )
            for card in cards
        ],
        total=total,
        source_name=source_name,
    )


@router.post(
    "/cards/{portal_id}/portal/items/{target_id}",
    status_code=201,
    response_model=PlacementOut,
)
def add_portal_item(
    portal_id: uuid.UUID,
    target_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Apply a canvas portal by placing the canonical card on its source."""
    portal = get_visible_card(db, user, portal_id)
    if portal.type != "portal":
        raise ApiError(409, "not_a_portal", "This card is not a portal")
    scope, canvas_id, _, _, _, _, _, _ = _portal_settings(portal)
    if scope != "canvas" or canvas_id is None:
        raise ApiError(
            409,
            "portal_not_placeable",
            "Only a portal to a canvas can accept dropped cards",
        )
    canvas = get_editable_canvas(db, user, canvas_id)
    target = get_visible_card(db, user, target_id)
    if target.id == portal.id:
        raise ApiError(409, "portal_self", "A portal cannot contain itself")
    existing = db.scalar(
        select(Placement).where(
            Placement.card_id == target.id,
            Placement.canvas_id == canvas.id,
        )
    )
    if existing is not None:
        return existing

    count = int(
        db.scalar(
            select(func.count()).select_from(Placement).where(
                Placement.canvas_id == canvas.id
            )
        )
        or 0
    )
    placement = Placement(
        card_id=target.id,
        canvas_id=canvas.id,
        x=80 + (count % 4) * 320,
        y=80 + (count // 4) * 220,
    )
    target.inbox_canvas_id = None
    db.add(placement)
    db.flush()
    return placement


def _encode_cursor(created_at: datetime, card_id: uuid.UUID) -> str:
    raw = f"{created_at.isoformat()}|{card_id}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        created_str, id_str = raw.split("|", 1)
        return datetime.fromisoformat(created_str), uuid.UUID(id_str)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ApiError(400, "bad_cursor", "Cursor is not valid") from exc


@router.get("/inbox", response_model=InboxOut)
def inbox(
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None),
    canvas_id: uuid.UUID | None = Query(default=None),
    general: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    # The inbox is derived state: your cards with zero placements. No flag,
    # no table. It stays owner-scoped even with sharing: someone else's
    # unplaced card is not your inbox problem.
    query = (
        select(Card)
        .outerjoin(Placement, Placement.card_id == Card.id)
        .where(Card.owner_id == user.id, Placement.id.is_(None))
        .order_by(Card.created_at.desc(), Card.id.desc())
        .limit(limit + 1)
    )
    if canvas_id is not None:
        get_viewable_canvas(db, user, canvas_id)
        query = query.where(Card.inbox_canvas_id == canvas_id)
    elif general:
        query = query.where(Card.inbox_canvas_id.is_(None))
    if cursor is not None:
        created_at, card_id = _decode_cursor(cursor)
        query = query.where(tuple_(Card.created_at, Card.id) < (created_at, card_id))

    rows = db.scalars(query).all()
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        last = rows[-1]
        next_cursor = _encode_cursor(last.created_at, last.id)

    boards = resolve_boards(db, user, list(rows))
    return InboxOut(
        items=[
            CardOut.model_validate(c).model_copy(update={"board": boards.get(c.id)})
            for c in rows
        ],
        next_cursor=next_cursor,
    )


@router.delete("/inbox")
def clear_inbox(
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Empty the inbox in one action.

    The same rule a batch discard follows: only unplaced cards go, so nothing
    already committed to a canvas can be taken back by it. It ignores the
    pagination the GET uses — clearing the inbox means all of it, not the
    page you happen to be looking at.
    """
    rows = db.scalars(
        select(Card)
        .outerjoin(Placement, Placement.card_id == Card.id)
        .where(Card.owner_id == user.id, Placement.id.is_(None))
    ).all()
    for card in rows:
        db.delete(card)
    return {"discarded": len(rows)}


@router.post("/cards/{card_id}/split", status_code=202, response_model=SplitOut)
def split_card(
    card_id: uuid.UUID,
    limit: int = Query(default=DEFAULT_CARD_LIMIT, ge=2, le=12),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Break one long card into several, into your own inbox.

    Being able to see the card is enough. The source is never modified, the
    new cards are yours, and reading someone else's card to take your own
    notes from it is the same right that already lets you link to it.
    """
    card = get_visible_card(db, user, card_id)
    if not generation_available(get_ai_config(db)):
        raise ApiError(
            409, "generation_unavailable", "No generation endpoint is configured"
        )

    source = splittable_text(card)
    if len(source) < MIN_SPLIT_CHARS:
        raise ApiError(
            400,
            "too_short",
            f"This card needs at least {MIN_SPLIT_CHARS} characters of text to "
            "be worth splitting",
        )

    batch_id = uuid.uuid4()
    enqueue(
        db,
        "split",
        {
            "card_id": str(card.id),
            "user_id": str(user.id),
            "batch_id": str(batch_id),
            "limit": limit,
        },
    )
    return SplitOut(batch_id=batch_id, status="queued")


@router.post(
    "/canvases/{canvas_id}/compose", status_code=202, response_model=ComposeOut
)
def compose_cards(
    canvas_id: uuid.UUID,
    body: ComposeIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Queue one document made only from the explicitly selected cards."""
    canvas = get_editable_canvas(db, user, canvas_id)
    if not generation_available(get_ai_config(db)):
        raise ApiError(
            409, "generation_unavailable", "No generation endpoint is configured"
        )

    # Preserve the submitted order but never send the same source twice.
    card_ids = list(dict.fromkeys(body.card_ids))
    if len(card_ids) < 2:
        raise ApiError(400, "too_few_cards", "Select at least two different cards")
    for card_id in card_ids:
        get_visible_card(db, user, card_id)

    batch_id = uuid.uuid4()
    enqueue(
        db,
        "compose",
        {
            "canvas_id": str(canvas.id),
            "card_ids": [str(card_id) for card_id in card_ids],
            "user_id": str(user.id),
            "batch_id": str(batch_id),
            "x": body.x,
            "y": body.y,
        },
    )
    return ComposeOut(batch_id=batch_id, status="queued")


@router.post(
    "/cards/{card_id}/refresh-composition",
    status_code=202,
    response_model=ComposeOut,
)
def refresh_composition(
    card_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Refresh only untouched generated blocks in a living document."""
    card = get_editable_card(db, user, card_id)
    if card.type != "document":
        raise ApiError(400, "not_a_document", "Only documents can be refreshed")
    living = card.payload.get("living_document") or {}
    generated = card.payload.get("generated_by") or {}
    source_ids = [
        source.get("card_id") for source in living.get("sources", []) if source.get("card_id")
    ] or generated.get("source_card_ids", [])
    if len(source_ids) < 2:
        raise ApiError(400, "not_living", "This document has no source-card history")
    if not generation_available(get_ai_config(db)):
        raise ApiError(
            409, "generation_unavailable", "No generation endpoint is configured"
        )
    batch_id = uuid.uuid4()
    enqueue(
        db,
        "refresh_compose",
        {
            "card_id": str(card.id),
            "user_id": str(user.id),
            "batch_id": str(batch_id),
        },
    )
    return ComposeOut(batch_id=batch_id, status="queued")


@router.get("/compositions/{batch_id}", response_model=ComposeStatusOut)
def composition_status(
    batch_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    job = db.scalar(
        select(Job).where(
            Job.kind.in_(["compose", "refresh_compose"]),
            Job.payload["batch_id"].astext == str(batch_id),
            Job.payload["user_id"].astext == str(user.id),
        )
    )
    if job is None:
        raise not_found()
    if job.kind == "refresh_compose":
        card = db.get(Card, uuid.UUID(job.payload["card_id"]))
    else:
        card = db.scalar(
            select(Card).where(
                Card.owner_id == user.id,
                Card.payload["generated_by"]["batch_id"].astext == str(batch_id),
            )
        )
    placement = None
    if card is not None:
        placement = db.scalar(select(Placement).where(Placement.card_id == card.id))
    return ComposeStatusOut(
        batch_id=batch_id,
        status=job.status,
        card=CardOut.model_validate(card) if card else None,
        placement=placement,
        error=job.last_error,
    )


def _batch_query(user: User, batch_id: uuid.UUID):
    return select(Card).where(
        Card.owner_id == user.id,
        Card.payload["generated_by"]["batch_id"].astext == str(batch_id),
    )


@router.get("/inbox/batches/{batch_id}", response_model=BatchStatusOut)
def batch_status(
    batch_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Progress of one split. The job row says how it went; the cards say what
    came of it. A finished job with no cards is a real answer — the model
    returned nothing usable — and not an error to retry."""
    job = db.scalar(
        select(Job).where(
            Job.kind == "split",
            Job.payload["batch_id"].astext == str(batch_id),
            Job.payload["user_id"].astext == str(user.id),
        )
    )
    if job is None:
        raise not_found()
    rows = db.scalars(_batch_query(user, batch_id).order_by(Card.created_at)).all()
    return BatchStatusOut(
        batch_id=batch_id,
        status=job.status,
        cards=[CardOut.model_validate(c) for c in rows],
        error=job.last_error,
    )


@router.delete("/inbox/batches/{batch_id}")
def discard_batch(
    batch_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Throw away a whole generated batch in one action.

    Only unplaced cards go. Putting one on a canvas is how you keep it, so a
    late discard can never take back something already committed to.
    """
    rows = db.scalars(
        _batch_query(user, batch_id)
        .outerjoin(Placement, Placement.card_id == Card.id)
        .where(Placement.id.is_(None))
    ).all()
    for card in rows:
        db.delete(card)
    return {"discarded": len(rows)}
