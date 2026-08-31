"""Creating a card from captured content.

One code path for the web app, the REST API, and every bot. Captures always
land unplaced: a share sheet cannot tell you x and y, so placement stays a
separate deliberate act.
"""
import uuid

from sqlalchemy.orm import Session as DbSession

from app.jobs import (
    enqueue_embed_if_needed,
    enqueue_spotify_if_needed,
    enqueue_unfurl_if_needed,
    enqueue_youtube_attachment_if_needed,
)
from app.models import Card, User
from app.urls import card_shape_for


def capture_card(
    db: DbSession,
    user: User,
    text: str | None = None,
    url: str | None = None,
    title: str | None = None,
    extra_payload: dict | None = None,
) -> Card:
    """`extra_payload` carries provenance for captures that were not typed by
    a person — currently the split job, which stamps `generated_by` so a
    generated card stays identifiable after it is placed."""
    shape = card_shape_for(text, url)
    card = Card(
        owner_id=user.id,
        type=shape["type"],
        title=title or shape["title"],
        body=shape["body"],
        payload={**shape["payload"], **(extra_payload or {})},
    )
    db.add(card)
    db.flush()
    enqueue_unfurl_if_needed(db, card)
    enqueue_spotify_if_needed(db, card)
    enqueue_youtube_attachment_if_needed(db, card)
    enqueue_embed_if_needed(db, card)
    return card


def capture_audio_card(
    db: DbSession, user: User, title: str | None = None
) -> Card:
    """An empty audio card, ready for a file to be attached to it."""
    card = Card(owner_id=user.id, type="audio", title=title, payload={})
    db.add(card)
    db.flush()
    return card


def capture_file_card(
    db: DbSession, user: User, title: str | None = None
) -> Card:
    """An empty file card, ready for an attachment."""
    card = Card(owner_id=user.id, type="file", title=title, payload={})
    db.add(card)
    db.flush()
    return card


def capture_image_card(
    db: DbSession, user: User, title: str | None = None
) -> Card:
    """An empty image card, ready for a file to be attached to it."""
    card = Card(owner_id=user.id, type="image", title=title, payload={})
    db.add(card)
    db.flush()
    return card


def attach_audio_file(
    db: DbSession,
    card: Card,
    file_id: uuid.UUID,
    path: str,
    mime: str,
    size: int,
) -> uuid.UUID:
    from app.jobs import enqueue
    from app.models import File

    record = File(id=file_id, card_id=card.id, path=path, mime=mime, bytes=size)
    db.add(record)
    db.flush()
    card.payload = {
        **card.payload,
        "audio_file_id": str(record.id),
        "audio_mime": mime,
        "transcript_status": "queued",
    }
    enqueue(db, "transcribe", {"card_id": str(card.id), "file_id": str(record.id)})
    return record.id


def attach_image_file(
    db: DbSession,
    card: Card,
    file_id: uuid.UUID,
    path: str,
    mime: str,
    size: int,
) -> uuid.UUID:
    """The same payload the web upload writes, so a card that arrived from a
    bot is indistinguishable from one dragged onto the canvas — same keys,
    same crop, same transparency handling.

    The id comes from the caller, which has already used it to name the file
    on disk. `_store_upload` does the same, and it is what makes a file in the
    data directory traceable back to the row that owns it.

    No job is queued: unlike audio, there is nothing to extract from a
    picture. That is also what makes an image card contribute nothing to
    search until it is given a title.
    """
    from app.models import File

    record = File(id=file_id, card_id=card.id, path=path, mime=mime, bytes=size)
    db.add(record)
    db.flush()
    card.payload = {
        **card.payload,
        "image_file_id": str(record.id),
        "image_mime": mime,
    }
    enqueue_embed_if_needed(db, card)
    return record.id


def attach_generic_file(
    db: DbSession,
    card: Card,
    file_id: uuid.UUID,
    path: str,
    mime: str,
    size: int,
    name: str,
) -> uuid.UUID:
    """The payload the web upload writes for an attachment of no particular
    kind. The name is kept because it is the only thing there is to show: a
    file card has no preview, so its title is its content."""
    from app.models import File

    record = File(
        id=file_id,
        card_id=card.id,
        path=path,
        mime=mime or "application/octet-stream",
        bytes=size,
        name=name,
    )
    db.add(record)
    db.flush()
    card.payload = {
        **card.payload,
        "file_id": str(file_id),
        "file_name": name,
        "file_mime": record.mime,
        "file_bytes": size,
    }
    if not card.title:
        card.title = name
    enqueue_embed_if_needed(db, card)
    return record.id
