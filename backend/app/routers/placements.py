import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DbSession

from app.access import ROLE_VIEWER, canvas_role
from app.auth import get_current_user
from app.db import get_db
from app.errors import ApiError, not_found
from app.models import Canvas, Card, Placement, User
from app.schemas.api import PlacementOut, PlacementPatchIn

router = APIRouter(prefix="/api/placements")


def get_editable_placement(
    db: DbSession, user: User, placement_id: uuid.UUID
) -> Placement:
    placement = db.get(Placement, placement_id)
    if placement is None:
        raise not_found()
    canvas = db.get(Canvas, placement.canvas_id)
    role = canvas_role(db, user, canvas) if canvas else None
    if role is None:
        raise not_found()
    if role == ROLE_VIEWER:
        raise ApiError(403, "read_only", "You have view-only access to this canvas")
    return placement


def _validate_parent(
    db: DbSession, placement: Placement, parent_id: uuid.UUID
) -> Placement:
    """A column can only hold cards sitting on the same canvas, and cannot
    hold another column or itself."""
    if parent_id == placement.id:
        raise ApiError(400, "self_parent", "A card cannot sit inside itself")
    parent = db.get(Placement, parent_id)
    if parent is None or parent.canvas_id != placement.canvas_id:
        raise not_found()
    parent_card = db.get(Card, parent.card_id)
    if parent_card is None or parent_card.type != "column":
        raise ApiError(400, "not_a_column", "Cards can only be put inside a column")
    own_card = db.get(Card, placement.card_id)
    if own_card is not None and own_card.type == "column":
        raise ApiError(400, "nested_column", "Columns cannot be nested for now")
    return parent


@router.patch("/{placement_id}", response_model=PlacementOut)
def patch_placement(
    placement_id: uuid.UUID,
    body: PlacementPatchIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    placement = get_editable_placement(db, user, placement_id)
    fields = body.model_dump(exclude_unset=True)

    if fields.pop("clear_parent", False):
        placement.parent_id = None
    elif fields.get("parent_id") is not None:
        _validate_parent(db, placement, fields["parent_id"])
        placement.parent_id = fields["parent_id"]
    fields.pop("parent_id", None)

    for key, value in fields.items():
        if value is not None:
            setattr(placement, key, value)
    placement.updated_at = datetime.now(timezone.utc)
    # Routing intent has done its job once the card reaches any canvas.
    card = db.get(Card, placement.card_id)
    if card is not None:
        card.inbox_canvas_id = None
    return placement


@router.delete("/{placement_id}", status_code=204)
def delete_placement(
    placement_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    # Removing a card's last placement returns it to the inbox; the card survives.
    placement = get_editable_placement(db, user, placement_id)
    db.delete(placement)
