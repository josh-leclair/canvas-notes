import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Form, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.auth import create_api_token, get_current_user
from app.capture import (
    attach_audio_file,
    attach_generic_file,
    attach_image_file,
    capture_audio_card,
    capture_card,
    capture_file_card,
    capture_image_card,
)
from app.db import get_db
from app.errors import not_found
from app.media import (
    ALLOWED_AUDIO,
    ALLOWED_IMAGE,
    MAX_AUDIO_BYTES,
    MAX_FILE_BYTES,
    MAX_IMAGE_BYTES,
    normalise_mime,
    safe_extension,
    safe_name,
    store_upload,
)
from app.models import ApiToken, BotIdentity, PairingCode, User
from app.schemas.api import (
    ApiTokenCreateIn,
    ApiTokenCreated,
    ApiTokenOut,
    BotIdentityOut,
    CaptureIn,
    CardOut,
    PairingCodeOut,
)

router = APIRouter(prefix="/api")

PAIRING_ALPHABET = "234679ACDEFGHJKMNPQRTUVWXYZ"
PAIRING_LENGTH = 8
PAIRING_TTL = timedelta(minutes=15)


@router.post("/capture", status_code=201, response_model=CardOut)
def capture(
    body: CaptureIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    return capture_card(db, user, text=body.text, url=body.url, title=body.title)


@router.post("/capture/file", status_code=201, response_model=CardOut)
def capture_file(
    file: UploadFile,
    title: str | None = Form(default=None),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Capture a picture, a voice memo, or any other file in one request.

    Its own path rather than teaching `/api/capture` to take both. FastAPI
    cannot cleanly accept a JSON body and an upload on the same route — the
    existing fields would have to become `Form(...)`, which would break every
    shortcut and every script already posting JSON to it. A second path leaves
    all of that untouched.

    The card comes out the same shape the web upload produces, because it is
    built from the same helpers: an image captured from a phone gets crop, the
    lightbox and the transparent-cutout rendering for free, and a voice memo
    gets a queued transcription.
    """
    mime = normalise_mime(file.content_type)

    if mime in ALLOWED_IMAGE:
        card = capture_image_card(db, user, title=title)
        file_id, path, total = store_upload(file, ALLOWED_IMAGE[mime], MAX_IMAGE_BYTES)
        attach_image_file(db, card, file_id, path, mime, total)
        return card

    if mime in ALLOWED_AUDIO:
        card = capture_audio_card(db, user, title=title)
        file_id, path, total = store_upload(file, ALLOWED_AUDIO[mime], MAX_AUDIO_BYTES)
        attach_audio_file(db, card, file_id, path, mime, total)
        return card

    # Anything else becomes a file card rather than being refused. A share
    # sheet offers whatever the other app happens to hold, and a PDF you
    # cannot capture is a worse answer than one you can capture but not
    # preview.
    name = safe_name(file.filename)
    card = capture_file_card(db, user, title=title)
    file_id, path, total = store_upload(
        file, safe_extension(file.filename), MAX_FILE_BYTES
    )
    attach_generic_file(db, card, file_id, path, mime, total, name)
    return card


@router.get("/tokens", response_model=list[ApiTokenOut])
def list_tokens(
    user: User = Depends(get_current_user), db: DbSession = Depends(get_db)
):
    return db.scalars(
        select(ApiToken)
        .where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None))
        .order_by(ApiToken.created_at.desc())
    ).all()


@router.post("/tokens", status_code=201, response_model=ApiTokenCreated)
def create_token(
    body: ApiTokenCreateIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    row, token = create_api_token(db, user, body.name)
    # The only time the plaintext is ever returned.
    return ApiTokenCreated(
        id=row.id,
        name=row.name,
        created_at=row.created_at,
        last_used_at=None,
        token=token,
    )


@router.delete("/tokens/{token_id}", status_code=204)
def revoke_token(
    token_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    row = db.get(ApiToken, token_id)
    if row is None or row.user_id != user.id:
        raise not_found()
    row.revoked_at = datetime.now(timezone.utc)


@router.post("/pairing-codes", status_code=201, response_model=PairingCodeOut)
def create_pairing_code(
    user: User = Depends(get_current_user), db: DbSession = Depends(get_db)
):
    code = "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(PAIRING_LENGTH))
    row = PairingCode(
        user_id=user.id,
        code=code,
        expires_at=datetime.now(timezone.utc) + PAIRING_TTL,
    )
    db.add(row)
    db.flush()
    return row


@router.get("/bot-identities", response_model=list[BotIdentityOut])
def list_bot_identities(
    user: User = Depends(get_current_user), db: DbSession = Depends(get_db)
):
    return db.scalars(
        select(BotIdentity)
        .where(BotIdentity.user_id == user.id)
        .order_by(BotIdentity.created_at.desc())
    ).all()


@router.delete("/bot-identities/{identity_id}", status_code=204)
def unpair(
    identity_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    row = db.get(BotIdentity, identity_id)
    if row is None or row.user_id != user.id:
        raise not_found()
    db.delete(row)
