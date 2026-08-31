import os
import uuid

from fastapi import APIRouter, Depends, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session as DbSession

from app.access import get_editable_card, get_visible_card
from app.auth import get_current_user
from app.db import get_db
from app.errors import ApiError, not_found
from app.jobs import enqueue
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
from app.models import File, User
from app.schemas.api import CardOut

router = APIRouter(prefix="/api")


@router.post("/cards/{card_id}/audio", status_code=201, response_model=CardOut)
def upload_audio(
    card_id: uuid.UUID,
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    card = get_editable_card(db, user, card_id)
    if card.type != "audio":
        raise ApiError(409, "not_audio_card", "This card is not an audio card")
    mime = normalise_mime(file.content_type)
    extension = ALLOWED_AUDIO.get(mime)
    if extension is None:
        raise ApiError(415, "unsupported_audio", f"Unsupported audio type: {mime}")

    file_id, path, total = store_upload(file, extension, MAX_AUDIO_BYTES)

    record = File(id=file_id, card_id=card.id, path=path, mime=mime, bytes=total)
    db.add(record)
    db.flush()

    card.payload = {
        **card.payload,
        "audio_file_id": str(file_id),
        "audio_mime": mime,
        # Queued even when this process cannot transcribe: a capable worker
        # may be running, and the queue holds the job either way.
        "transcript_status": "queued",
    }
    enqueue(db, "transcribe", {"card_id": str(card.id), "file_id": str(file_id)})
    return card


@router.post("/cards/{card_id}/image", status_code=201, response_model=CardOut)
def upload_image(
    card_id: uuid.UUID,
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    card = get_editable_card(db, user, card_id)
    if card.type != "image":
        raise ApiError(409, "not_image_card", "This card is not an image card")
    mime = normalise_mime(file.content_type)
    extension = ALLOWED_IMAGE.get(mime)
    if extension is None:
        raise ApiError(415, "unsupported_image", f"Unsupported image type: {mime}")

    file_id, path, total = store_upload(file, extension, MAX_IMAGE_BYTES)
    db.add(File(id=file_id, card_id=card.id, path=path, mime=mime, bytes=total))
    db.flush()

    card.payload = {
        **card.payload,
        "image_file_id": str(file_id),
        "image_mime": mime,
    }
    return card


@router.post("/cards/{card_id}/file", status_code=201, response_model=CardOut)
def upload_file(
    card_id: uuid.UUID,
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Any attachment at all.

    Deliberately not restricted by type the way audio and images are: the
    point of a file card is the things that are not either of those. What
    keeps it safe is how it comes back out — see serve_file, which never
    renders one inline.
    """
    card = get_editable_card(db, user, card_id)
    if card.type != "file":
        raise ApiError(409, "not_file_card", "This card is not a file card")

    name = safe_name(file.filename)
    mime = normalise_mime(file.content_type)
    file_id, path, total = store_upload(
        file, safe_extension(file.filename), MAX_FILE_BYTES
    )
    db.add(
        File(
            id=file_id,
            card_id=card.id,
            path=path,
            mime=mime or "application/octet-stream",
            bytes=total,
            name=name,
        )
    )
    db.flush()

    card.payload = {
        **card.payload,
        "file_id": str(file_id),
        "file_name": name,
        "file_mime": mime or "application/octet-stream",
        "file_bytes": total,
    }
    if not card.title:
        card.title = name
    return card


@router.get("/files/{file_id}")
def serve_file(
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    record = db.get(File, file_id)
    if record is None:
        raise not_found()
    # A file follows its card: anyone who can see the card can fetch it.
    card = get_visible_card(db, user, record.card_id)
    if not os.path.exists(record.path):
        raise not_found()

    # An attachment is never rendered in place. Serving arbitrary uploads
    # inline from the app's own origin would let an .html or a scripted .svg
    # run as though the app had written it; audio and images stay inline
    # because that is the entire point of them.
    if card.type == "file":
        return FileResponse(
            record.path,
            media_type="application/octet-stream",
            filename=record.name or "download",
            content_disposition_type="attachment",
        )
    return FileResponse(record.path, media_type=record.mime)
