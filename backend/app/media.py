"""What kinds of media a card can hold, how big they may be, and how they are
written to disk.

One place, because three things now accept media and they have to agree: the
web upload in `routers/files.py`, the capture bots, and `/api/capture/file`.
They previously kept their own copies of the mime-to-extension map, so a
format the browser could upload was not necessarily one a bot could store
under the same name.
"""
import os
import uuid

from fastapi import UploadFile

from app.config import settings
from app.errors import ApiError

MAX_AUDIO_BYTES = 200 * 1024 * 1024
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_FILE_BYTES = 100 * 1024 * 1024

NAME_MAX = 200

ALLOWED_AUDIO = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "video/webm": ".webm",  # MediaRecorder labels audio-only recordings this way
}

ALLOWED_IMAGE = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
}


def normalise_mime(raw: str | None) -> str:
    """A bare type, lowercased, with any `; charset=` parameters dropped."""
    return (raw or "").split(";")[0].strip().lower()


def safe_extension(filename: str | None) -> str:
    """The uploaded name's suffix, reduced to something safe to concatenate
    onto a path. Anything odd becomes no extension at all: the stored name is
    only ever a convenience, since the file is addressed by id."""
    if not filename:
        return ""
    tail = os.path.basename(filename).rsplit(".", 1)
    if len(tail) != 2:
        return ""
    suffix = "".join(c for c in tail[1] if c.isalnum())[:10].lower()
    return f".{suffix}" if suffix else ""


def safe_name(filename: str | None) -> str:
    """What to call it on the way back out. Path separators and control
    characters are stripped so the name cannot escape a Content-Disposition
    header or a directory."""
    base = os.path.basename(filename or "").replace("\\", "")
    cleaned = "".join(c for c in base if c.isprintable() and c not in '"\\/')
    return cleaned.strip()[:NAME_MAX] or "download"


def store_upload(
    file: UploadFile, extension: str, limit: int
) -> tuple[uuid.UUID, str, int]:
    """Stream an upload to disk, refusing it the moment it goes over.

    Streamed rather than read into memory, and the limit enforced as it goes
    rather than afterwards, so an oversized file is never fully received or
    held. The bots cannot use this — they are handed bytes that have already
    been downloaded — which is why the ceiling there belongs to the adapter.
    """
    os.makedirs(settings.files_dir, exist_ok=True)
    file_id = uuid.uuid4()
    path = os.path.join(settings.files_dir, f"{file_id}{extension}")
    total = 0
    with open(path, "wb") as out:
        while chunk := file.file.read(1024 * 1024):
            total += len(chunk)
            if total > limit:
                out.close()
                os.unlink(path)
                raise ApiError(413, "file_too_large", "That file is too large")
            out.write(chunk)
    return file_id, path, total
