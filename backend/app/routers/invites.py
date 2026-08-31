import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.auth import require_admin
from app.db import get_db
from app.errors import not_found
from app.models import Invite, User
from app.schemas.api import InviteCreateIn, InviteOut

router = APIRouter(prefix="/api/invites", dependencies=[Depends(require_admin)])

# 12 characters, no lookalikes (no 0/O, 1/l/I, 5/S, 8/B).
CODE_ALPHABET = "234679ACDEFGHJKMNPQRTUVWXYZ"
CODE_LENGTH = 12


def generate_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


@router.get("", response_model=list[InviteOut])
def list_invites(db: DbSession = Depends(get_db)):
    return db.scalars(select(Invite).order_by(Invite.created_at.desc())).all()


@router.post("", status_code=201, response_model=InviteOut)
def create_invite(
    body: InviteCreateIn,
    db: DbSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    invite = Invite(
        code=generate_code(),
        created_by=admin.id,
        expires_at=datetime.now(timezone.utc) + timedelta(days=body.expires_in_days),
    )
    db.add(invite)
    db.flush()
    return invite


@router.delete("/{invite_id}", status_code=204)
def delete_invite(invite_id: uuid.UUID, db: DbSession = Depends(get_db)):
    invite = db.get(Invite, invite_id)
    if invite is None:
        raise not_found()
    db.delete(invite)
