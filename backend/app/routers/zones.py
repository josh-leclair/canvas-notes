import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DbSession

from app.access import get_editable_canvas
from app.auth import get_current_user
from app.db import get_db
from app.errors import not_found
from app.models import User, Zone
from app.schemas.api import ZoneOut, ZonePatchIn

router = APIRouter(prefix="/api/zones")


def _zone(db: DbSession, zone_id: uuid.UUID) -> Zone:
    zone = db.get(Zone, zone_id)
    if zone is None:
        raise not_found()
    return zone


@router.patch("/{zone_id}", response_model=ZoneOut)
def patch_zone(
    zone_id: uuid.UUID,
    body: ZonePatchIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    zone = _zone(db, zone_id)
    get_editable_canvas(db, user, zone.canvas_id)
    for key, value in body.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(zone, key, value)
    zone.updated_at = datetime.now(timezone.utc)
    return zone


@router.delete("/{zone_id}", status_code=204)
def delete_zone(
    zone_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    zone = _zone(db, zone_id)
    get_editable_canvas(db, user, zone.canvas_id)
    db.delete(zone)
