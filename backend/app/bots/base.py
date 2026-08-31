"""Platform-agnostic bot policy.

One instance runs one bot serving every user, so the bot must map platform
identity to app identity. The web app issues a short code, the user sends it
to the bot once, the mapping is stored. Messages from unpaired senders are
dropped silently. This is the bot's entire auth model.
"""
import logging
import os
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.capture import (
    attach_audio_file,
    attach_image_file,
    capture_audio_card,
    capture_card,
    capture_image_card,
)
from app.config import settings
from app.db import SessionLocal
from app.media import ALLOWED_AUDIO, ALLOWED_IMAGE
from app.models import BotIdentity, PairingCode, User

log = logging.getLogger("bots")

PAIRING_HINT = (
    "I don't know you yet. Open the app, go to Settings, generate a pairing "
    "code, and send it here."
)


@dataclass
class IncomingMessage:
    """What every adapter must produce, whatever its platform looks like."""

    platform_user_id: str
    text: str | None = None
    audio: tuple[bytes, str] | None = None  # (content, mime)
    image: tuple[bytes, str] | None = None  # (content, mime)
    """Something arrived that this bot cannot turn into a card. Carried so the
    sender can be told, rather than being met with silence — a photo used to
    fall through to nothing at all, which is indistinguishable from the bot
    being down."""
    unsupported: str | None = None


class BotAdapter(Protocol):
    platform: str

    @staticmethod
    def configured() -> bool:
        """True when this platform has the credentials it needs."""

    def run(self, stop: threading.Event) -> None:
        """Block until stop is set, dispatching to handle_message."""


def _resolve_user(db: DbSession, platform: str, platform_user_id: str) -> User | None:
    identity = db.scalar(
        select(BotIdentity).where(
            BotIdentity.platform == platform,
            BotIdentity.platform_user_id == platform_user_id,
        )
    )
    return db.get(User, identity.user_id) if identity else None


def _try_pair(
    db: DbSession, platform: str, platform_user_id: str, text: str
) -> User | None:
    """Consume a pairing code sent as the whole message body."""
    candidate = text.strip().upper()
    if not candidate or len(candidate) > 16 or " " in candidate:
        return None
    row = db.scalar(
        select(PairingCode).where(PairingCode.code == candidate).with_for_update()
    )
    if row is None or row.consumed_at is not None:
        return None
    if row.expires_at <= datetime.now(timezone.utc):
        return None

    row.consumed_at = datetime.now(timezone.utc)
    existing = db.scalar(
        select(BotIdentity).where(
            BotIdentity.platform == platform,
            BotIdentity.platform_user_id == platform_user_id,
        )
    )
    if existing is None:
        db.add(
            BotIdentity(
                user_id=row.user_id,
                platform=platform,
                platform_user_id=platform_user_id,
            )
        )
    else:
        existing.user_id = row.user_id
    db.flush()
    return db.get(User, row.user_id)


def handle_message(platform: str, message: IncomingMessage) -> str | None:
    """Returns a reply to send back, or None to stay silent."""
    db: DbSession = SessionLocal()
    try:
        user = _resolve_user(db, platform, message.platform_user_id)

        if user is None:
            if message.text:
                user = _try_pair(db, platform, message.platform_user_id, message.text)
                if user is not None:
                    db.commit()
                    return f"Paired with {user.display_name}. Send me anything to capture it."
            # Unpaired senders are dropped silently, except for a one-line hint
            # on plain text so a legitimate user is not left guessing.
            db.rollback()
            return PAIRING_HINT if message.text else None

        if message.audio is not None:
            content, mime = message.audio
            card = capture_audio_card(db, user, title=message.text or None)
            file_id, path = _write_blob(content, mime, ALLOWED_AUDIO)
            attach_audio_file(db, card, file_id, path, mime, len(content))
            db.commit()
            return "Voice note captured. It's in your inbox, transcription queued."

        # Before the text branch, deliberately: a photo sent with a caption
        # used to fall through to it and be filed as a text card, reporting
        # success while quietly discarding the picture.
        if message.image is not None:
            content, mime = message.image
            card = capture_image_card(db, user, title=message.text or None)
            file_id, path = _write_blob(content, mime, ALLOWED_IMAGE)
            attach_image_file(db, card, file_id, path, mime, len(content))
            db.commit()
            return "Image captured. It's in your inbox."

        if message.text:
            card = capture_card(db, user, text=message.text)
            db.commit()
            return f"Captured as a {card.type} card. It's in your inbox."

        if message.unsupported:
            db.rollback()
            return f"I can't capture {message.unsupported} yet."

        db.rollback()
        return None
    except Exception:
        db.rollback()
        log.exception("bot message handling failed")
        return "Something went wrong saving that."
    finally:
        db.close()


def _write_blob(
    content: bytes, mime: str, extensions: dict[str, str]
) -> tuple[uuid.UUID, str]:
    """Bytes to a file on disk, named the way the web upload names its own.

    A bot has already downloaded the whole thing into memory, so this cannot
    reuse `_store_upload`, which streams an `UploadFile` and enforces its
    limit as it goes. The size ceiling therefore belongs to the adapter, which
    is the only part that can refuse a download before making it.
    """
    os.makedirs(settings.files_dir, exist_ok=True)
    file_id = uuid.uuid4()
    path = os.path.join(
        settings.files_dir, f"{file_id}{extensions.get(mime, '.bin')}"
    )
    with open(path, "wb") as out:
        out.write(content)
    return file_id, path
