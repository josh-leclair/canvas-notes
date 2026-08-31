from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app import auth
from app.config import settings
from app.db import get_db
from app.errors import ApiError
from app.models import Invite, User
from app.schemas.api import LoginIn, RegisterIn, UserOut

router = APIRouter(prefix="/api")


@router.get("/bootstrap")
def bootstrap(db: DbSession = Depends(get_db)):
    user_count = db.scalar(select(func.count()).select_from(User))
    return {"needs_setup": user_count == 0, "instance_name": settings.instance_name}


@router.post("/auth/register", status_code=201, response_model=UserOut)
def register(
    body: RegisterIn, request: Request, response: Response, db: DbSession = Depends(get_db)
):
    user_count = db.scalar(select(func.count()).select_from(User))
    invite: Invite | None = None

    if user_count > 0:
        if not body.invite_code:
            raise ApiError(403, "invite_required", "An invite code is required")
        invite = db.scalar(
            select(Invite).where(Invite.code == body.invite_code).with_for_update()
        )
        if invite is None:
            raise ApiError(403, "invite_invalid", "Invite code is not valid")
        if invite.used_at is not None:
            raise ApiError(403, "invite_used", "Invite code has already been used")
        if invite.expires_at <= datetime.now(timezone.utc):
            raise ApiError(403, "invite_expired", "Invite code has expired")

    existing = db.scalar(select(User).where(User.email == body.email))
    if existing is not None:
        raise ApiError(409, "email_taken", "An account with this email already exists")

    user = User(
        email=body.email,
        password_hash=auth.hash_password(body.password),
        display_name=body.display_name,
        is_admin=user_count == 0,
    )
    db.add(user)
    db.flush()

    if invite is not None:
        invite.used_by = user.id
        invite.used_at = datetime.now(timezone.utc)

    token = auth.create_session(db, user, request.headers.get("user-agent"))
    auth.set_session_cookie(response, token)
    return user


@router.post("/auth/login", response_model=UserOut)
def login(
    body: LoginIn, request: Request, response: Response, db: DbSession = Depends(get_db)
):
    user = db.scalar(select(User).where(User.email == body.email))
    # Same error for unknown email and bad password.
    if user is None or not auth.verify_password(user.password_hash, body.password):
        raise ApiError(401, "invalid_credentials", "Invalid email or password")
    token = auth.create_session(db, user, request.headers.get("user-agent"))
    auth.set_session_cookie(response, token)
    return user


@router.post("/auth/logout", status_code=204)
def logout(request: Request, response: Response, db: DbSession = Depends(get_db)):
    token = request.cookies.get(auth.SESSION_COOKIE)
    if token:
        auth.destroy_session(db, token)
    auth.clear_session_cookie(response)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(auth.get_current_user)):
    return user
