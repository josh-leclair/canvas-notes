import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import settings
from app.db import get_db
from app.errors import ApiError
from app.models import ApiToken, Session, User

SESSION_COOKIE = "session"
TOKEN_PREFIX = "cnv_"
SESSION_LIFETIME = timedelta(days=30)
# Sliding expiry, but only rewritten when the session has aged this much,
# so an active client is not a DB write per request.
SLIDE_THRESHOLD = timedelta(hours=1)

_hasher = PasswordHasher()  # argon2id by default


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db: DbSession, user: User, user_agent: str | None) -> str:
    token = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    db.add(
        Session(
            user_id=user.id,
            token_hash=_hash_token(token),
            user_agent=user_agent,
            expires_at=datetime.now(timezone.utc) + SESSION_LIFETIME,
        )
    )
    db.flush()
    return token


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def destroy_session(db: DbSession, token: str) -> None:
    row = db.scalar(select(Session).where(Session.token_hash == _hash_token(token)))
    if row is not None:
        db.delete(row)


def _session_for_token(db: DbSession, token: str) -> Session | None:
    row = db.scalar(select(Session).where(Session.token_hash == _hash_token(token)))
    if row is None:
        return None
    now = datetime.now(timezone.utc)
    if row.expires_at <= now:
        db.delete(row)
        return None
    if now - row.last_seen_at > SLIDE_THRESHOLD:
        row.last_seen_at = now
        row.expires_at = now + SESSION_LIFETIME
    return row


def create_api_token(db: DbSession, user: User, name: str) -> tuple[ApiToken, str]:
    """Returns the row and the plaintext token, which is shown exactly once."""
    secret = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    token = f"{TOKEN_PREFIX}{secret}"
    row = ApiToken(user_id=user.id, name=name, token_hash=_hash_token(token))
    db.add(row)
    db.flush()
    return row, token


def _user_for_api_token(db: DbSession, token: str) -> User | None:
    row = db.scalar(select(ApiToken).where(ApiToken.token_hash == _hash_token(token)))
    if row is None or row.revoked_at is not None:
        return None
    now = datetime.now(timezone.utc)
    # Amortized like the sliding session: an active client is not a write
    # on every request.
    if row.last_used_at is None or now - row.last_used_at > SLIDE_THRESHOLD:
        row.last_used_at = now
    return db.get(User, row.user_id)


def get_current_user(request: Request, db: DbSession = Depends(get_db)) -> User:
    """Accepts either the session cookie or `Authorization: Bearer <token>`."""
    header = request.headers.get("authorization")
    if header and header.lower().startswith("bearer "):
        user = _user_for_api_token(db, header[7:].strip())
        if user is None:
            raise ApiError(401, "unauthenticated", "Invalid API token")
        return user

    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise ApiError(401, "unauthenticated", "Not signed in")
    session = _session_for_token(db, token)
    if session is None:
        raise ApiError(401, "unauthenticated", "Not signed in")
    user = db.get(User, session.user_id)
    if user is None:
        raise ApiError(401, "unauthenticated", "Not signed in")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise ApiError(403, "admin_required", "Admin required")
    return user
