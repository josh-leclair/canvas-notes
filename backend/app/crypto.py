"""Encryption for secrets stored in the database.

API keys entered in the app live in `app_settings`, which means they land in
backups and pg_dump output. They are encrypted with a key derived from
SESSION_SECRET, so a leaked dump is not a leaked key. Rotating SESSION_SECRET
invalidates stored keys, which is the same blast radius as it already has for
sessions.
"""
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

PREFIX = "enc:"


def _fernet() -> Fernet:
    secret = settings.session_secret or "canvas-notes-development-secret"
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
    return Fernet(key)


def encrypt(value: str) -> str:
    if not value:
        return ""
    return PREFIX + _fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    if not value:
        return ""
    if not value.startswith(PREFIX):
        return value  # written before encryption, or seeded from the environment
    try:
        return _fernet().decrypt(value[len(PREFIX) :].encode()).decode()
    except InvalidToken:
        # Most likely SESSION_SECRET changed. Treat as unset rather than
        # crashing every job that touches it.
        return ""
