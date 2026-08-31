import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession, joinedload

import os

from fastapi import UploadFile
from fastapi.responses import FileResponse

from app.access import (
    ROLE_EDITOR,
    canvas_role,
    get_editable_canvas,
    get_owned_canvas,
    get_viewable_canvas,
    visible_canvas_condition,
    visible_card_condition,
    visible_link_condition,
)
from app.auth import get_current_user
from app.boards import nested_canvas_ids, resolve_boards
from app.config import settings
from app.db import get_db
from app.errors import ApiError, not_found
from app.models import Canvas, CanvasMember, Card, Link, Placement, User, Zone
from app.schemas.api import (
    BoardCreateIn,
    BoardRef,
    CanvasDetailOut,
    CanvasCreateIn,
    CanvasBoundsIn,
    CanvasListItem,
    CanvasMemberOut,
    CanvasMemberPatchIn,
    CanvasNameIn,
    CanvasOut,
    CanvasShareIn,
    CardCreateOut,
    CardOut,
    LinkOut,
    PlacementCreateIn,
    PlacementOut,
    PlacementWithCard,
    ZoneCreateIn,
    ZoneOut,
)

router = APIRouter(prefix="/api/canvases")


@router.get("", response_model=list[CanvasListItem])
def list_canvases(
    user: User = Depends(get_current_user), db: DbSession = Depends(get_db)
):
    rows = db.execute(
        select(Canvas, func.count(Placement.id))
        .outerjoin(Placement, Placement.canvas_id == Canvas.id)
        .where(visible_canvas_condition(user.id))
        .group_by(Canvas.id)
        .order_by(Canvas.created_at.desc())
    ).all()
    nested = nested_canvas_ids(db, user)
    return [
        CanvasListItem(
            id=c.id,
            name=c.name,
            is_infinite=c.is_infinite,
            width=c.width,
            height=c.height,
            card_count=count,
            created_at=c.created_at,
            updated_at=c.updated_at,
            role=canvas_role(db, user, c) or "viewer",
            has_cover=bool(c.cover_path),
            is_nested=c.id in nested,
        )
        for c, count in rows
    ]


@router.post("", status_code=201, response_model=CanvasOut)
def create_canvas(
    body: CanvasCreateIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = Canvas(
        owner_id=user.id,
        name=body.name,
        is_infinite=False,
        width=body.width,
        height=body.height,
    )
    db.add(canvas)
    db.flush()
    return canvas


@router.get("/{canvas_id}", response_model=CanvasDetailOut)
def get_canvas(
    canvas_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = get_viewable_canvas(db, user, canvas_id)
    placements = db.scalars(
        select(Placement)
        .options(joinedload(Placement.card))
        .where(Placement.canvas_id == canvas.id)
        .order_by(Placement.z, Placement.updated_at)
    ).all()

    # Links whose endpoints both sit on this canvas. The client needs these to
    # know a card's children without asking for a reveal per card.
    card_ids = [p.card_id for p in placements]
    links = (
        db.scalars(
            select(Link).where(
                visible_link_condition(user.id),
                Link.source_card_id.in_(card_ids),
                Link.target_card_id.in_(card_ids),
            )
        ).all()
        if card_ids
        else []
    )

    boards = resolve_boards(db, user, [p.card for p in placements])

    return CanvasDetailOut(
        id=canvas.id,
        name=canvas.name,
        is_infinite=canvas.is_infinite,
        width=canvas.width,
        height=canvas.height,
        role=canvas_role(db, user, canvas) or "viewer",
        has_cover=bool(canvas.cover_path),
        placements=[
            PlacementWithCard(
                id=p.id,
                x=p.x,
                y=p.y,
                w=p.w,
                h=p.h,
                z=p.z,
                is_hub=p.is_hub,
                parent_id=p.parent_id,
                sort=p.sort,
                card=CardOut.model_validate(p.card).model_copy(
                    update={"board": boards.get(p.card_id)}
                ),
            )
            for p in placements
        ],
        zones=[ZoneOut.model_validate(zone) for zone in db.scalars(
            select(Zone).where(Zone.canvas_id == canvas.id).order_by(Zone.sort, Zone.created_at)
        ).all()],
        links=[LinkOut.model_validate(link) for link in links],
    )


@router.post("/{canvas_id}/zones", status_code=201, response_model=ZoneOut)
def create_zone(
    canvas_id: uuid.UUID,
    body: ZoneCreateIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = get_editable_canvas(db, user, canvas_id)
    next_sort = int(db.scalar(select(func.count()).select_from(Zone).where(Zone.canvas_id == canvas.id)) or 0)
    zone = Zone(canvas_id=canvas.id, sort=next_sort, **body.model_dump())
    db.add(zone)
    db.flush()
    return zone


@router.post("/{canvas_id}/boards", status_code=201, response_model=CardCreateOut)
def create_board(
    canvas_id: uuid.UUID,
    body: BoardCreateIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Make a nested board: a new canvas plus the card that opens it, in one
    step, so the two can never be created half-way."""
    parent = get_editable_canvas(db, user, canvas_id)

    child = Canvas(
        owner_id=user.id,
        name=body.name,
        is_infinite=False,
        width=body.width,
        height=body.height,
    )
    db.add(child)
    db.flush()

    card = Card(
        owner_id=user.id,
        type="board",
        title=body.name,
        payload={"canvas_id": str(child.id)},
    )
    db.add(card)
    db.flush()

    placement = Placement(card_id=card.id, canvas_id=parent.id, x=body.x, y=body.y)
    db.add(placement)
    db.flush()

    return CardCreateOut(
        card=CardOut.model_validate(card).model_copy(
            update={
                "board": BoardRef(
                    canvas_id=child.id,
                    name=child.name,
                    card_count=0,
                    has_cover=False,
                    role="owner",
                )
            }
        ),
        placement=placement,
    )


@router.get("/{canvas_id}/parents", response_model=list[CanvasOut])
def canvas_parents(
    canvas_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Boards this one sits inside, for the breadcrumb. Derived from board
    cards, so it is a list rather than a single parent."""
    get_viewable_canvas(db, user, canvas_id)
    rows = db.execute(
        select(Canvas)
        .join(Placement, Placement.canvas_id == Canvas.id)
        .join(Card, Card.id == Placement.card_id)
        .where(
            Card.type == "board",
            Card.payload["canvas_id"].astext == str(canvas_id),
            visible_canvas_condition(user.id),
        )
        .distinct()
    ).scalars()
    return list(rows)


@router.patch("/{canvas_id}", response_model=CanvasOut)
def rename_canvas(
    canvas_id: uuid.UUID,
    body: CanvasNameIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = get_owned_canvas(db, user, canvas_id)
    canvas.name = body.name
    canvas.updated_at = datetime.now(timezone.utc)
    return canvas


@router.patch("/{canvas_id}/bounds", response_model=CanvasOut)
def grow_canvas(
    canvas_id: uuid.UUID,
    body: CanvasBoundsIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Persist automatic growth. Bounds never shrink, so concurrent editors
    cannot accidentally clip one another's workspace."""
    canvas = get_editable_canvas(db, user, canvas_id)
    if canvas.is_infinite:
        return canvas
    canvas.width = max(canvas.width, body.width)
    canvas.height = max(canvas.height, body.height)
    canvas.updated_at = datetime.now(timezone.utc)
    return canvas


@router.delete("/{canvas_id}", status_code=204)
def delete_canvas(
    canvas_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = get_owned_canvas(db, user, canvas_id)
    # Cascades destroy placements only; cards survive unplaced (the inbox path).
    db.delete(canvas)


@router.post("/{canvas_id}/placements", status_code=201, response_model=PlacementOut)
def create_placement(
    canvas_id: uuid.UUID,
    body: PlacementCreateIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = get_editable_canvas(db, user, canvas_id)
    card = db.scalar(
        select(Card).where(
            Card.id == body.card_id, visible_card_condition(user.id)
        )
    )
    if card is None:
        raise not_found()
    existing = db.scalar(
        select(Placement).where(
            Placement.card_id == card.id, Placement.canvas_id == canvas.id
        )
    )
    if existing is not None:
        raise ApiError(409, "already_placed", "This card is already on this canvas")
    placement = Placement(card_id=card.id, canvas_id=canvas.id, x=body.x, y=body.y)
    card.inbox_canvas_id = None
    db.add(placement)
    db.flush()
    return placement


# --- cover image ----------------------------------------------------------

COVER_MIMES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/gif": ".gif",
}
MAX_COVER_BYTES = 12 * 1024 * 1024


@router.put("/{canvas_id}/cover", status_code=200, response_model=CanvasOut)
def set_cover(
    canvas_id: uuid.UUID,
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = get_owned_canvas(db, user, canvas_id)
    mime = (file.content_type or "").split(";")[0].strip().lower()
    extension = COVER_MIMES.get(mime)
    if extension is None:
        raise ApiError(415, "unsupported_image", f"Unsupported image type: {mime}")

    os.makedirs(settings.files_dir, exist_ok=True)
    path = os.path.join(settings.files_dir, f"cover-{uuid.uuid4()}{extension}")
    total = 0
    with open(path, "wb") as out:
        while chunk := file.file.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_COVER_BYTES:
                out.close()
                os.unlink(path)
                raise ApiError(413, "file_too_large", "That image is too large")
            out.write(chunk)

    previous = canvas.cover_path
    canvas.cover_path = path
    canvas.cover_mime = mime
    canvas.updated_at = datetime.now(timezone.utc)
    if previous and previous != path and os.path.exists(previous):
        os.unlink(previous)
    return canvas


@router.delete("/{canvas_id}/cover", status_code=204)
def clear_cover(
    canvas_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = get_owned_canvas(db, user, canvas_id)
    if canvas.cover_path and os.path.exists(canvas.cover_path):
        os.unlink(canvas.cover_path)
    canvas.cover_path = None
    canvas.cover_mime = None


@router.get("/{canvas_id}/cover")
def get_cover(
    canvas_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    # Anyone who can see the canvas can see its cover.
    canvas = get_viewable_canvas(db, user, canvas_id)
    if not canvas.cover_path or not os.path.exists(canvas.cover_path):
        raise not_found()
    return FileResponse(canvas.cover_path, media_type=canvas.cover_mime or "image/png")


# --- sharing --------------------------------------------------------------


@router.get("/{canvas_id}/members", response_model=list[CanvasMemberOut])
def list_members(
    canvas_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = get_viewable_canvas(db, user, canvas_id)
    rows = db.execute(
        select(CanvasMember, User)
        .join(User, User.id == CanvasMember.user_id)
        .where(CanvasMember.canvas_id == canvas.id)
        .order_by(User.display_name)
    ).all()
    return [
        CanvasMemberOut(
            user_id=member.user_id,
            email=member_user.email,
            display_name=member_user.display_name,
            role=member.role,
        )
        for member, member_user in rows
    ]


@router.post("/{canvas_id}/members", status_code=201, response_model=CanvasMemberOut)
def add_member(
    canvas_id: uuid.UUID,
    body: CanvasShareIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = get_owned_canvas(db, user, canvas_id)
    target = db.scalar(select(User).where(User.email == body.email))
    if target is None:
        raise ApiError(404, "no_such_user", "No account with that email")
    if target.id == canvas.owner_id:
        raise ApiError(409, "already_owner", "That user owns this canvas")

    member = db.get(CanvasMember, (canvas.id, target.id))
    if member is None:
        member = CanvasMember(canvas_id=canvas.id, user_id=target.id, role=body.role)
        db.add(member)
    else:
        member.role = body.role
    db.flush()
    return CanvasMemberOut(
        user_id=target.id,
        email=target.email,
        display_name=target.display_name,
        role=member.role,
    )


@router.patch("/{canvas_id}/members/{user_id}", response_model=CanvasMemberOut)
def change_role(
    canvas_id: uuid.UUID,
    user_id: uuid.UUID,
    body: CanvasMemberPatchIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = get_owned_canvas(db, user, canvas_id)
    member = db.get(CanvasMember, (canvas.id, user_id))
    if member is None:
        raise not_found()
    member.role = body.role
    target = db.get(User, user_id)
    return CanvasMemberOut(
        user_id=user_id,
        email=target.email,
        display_name=target.display_name,
        role=member.role,
    )


@router.delete("/{canvas_id}/members/{user_id}", status_code=204)
def remove_member(
    canvas_id: uuid.UUID,
    user_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Unsharing is revocation: the member immediately loses the cards, and
    any links whose endpoints they can no longer see are hidden."""
    canvas = get_owned_canvas(db, user, canvas_id)
    member = db.get(CanvasMember, (canvas.id, user_id))
    if member is None:
        raise not_found()
    db.delete(member)


@router.post("/{canvas_id}/leave", status_code=204)
def leave_canvas(
    canvas_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    canvas = get_viewable_canvas(db, user, canvas_id)
    if canvas.owner_id == user.id:
        raise ApiError(409, "owner_cannot_leave", "Delete the canvas instead")
    member = db.get(CanvasMember, (canvas.id, user.id))
    if member is not None:
        db.delete(member)


ROLES = (ROLE_EDITOR,)  # re-exported for tests
