"""Frozen, anonymous publications of explicit canvas selections."""

from __future__ import annotations

import os
import re
import secrets
import shutil
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession, joinedload

from app.access import get_owned_canvas
from app.auth import get_current_user
from app.config import settings
from app.db import get_db
from app.errors import ApiError, not_found
from app.media import safe_name
from app.models import Card, File, Link, Placement, PublicLens, PublicLensAsset, User
from app.schemas.api import PublicLensOut, PublicLensPublishIn

router = APIRouter(prefix="/api")

CARD_REFERENCE_RE = re.compile(
    r"\[([^\]]+)\]\(card:([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\)"
)
HTML_CARD_REFERENCE_RE = re.compile(
    r"<a\b[^>]*\bhref=[\"']card:([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})[\"'][^>]*>(.*?)</a>",
    re.IGNORECASE | re.DOTALL,
)
PAINT_KEYS = ("accent", "color", "header_color", "ink")
PAYLOAD_KEYS: dict[str, tuple[str, ...]] = {
    "text": (
        "display", "spotify_url", "spotify_status", "spotify",
        "youtube_url", "youtube_status", "youtube",
    ),
    "link": ("url", "unfurl", "video_id"),
    "youtube": ("url", "unfurl", "video_id"),
    "audio": ("transcript",),
    "image": ("crop", "image_mime"),
    "file": ("file_name", "file_bytes"),
    "checklist": ("items",),
    "table": ("rows", "header", "widths"),
}
ASSET_KEYS = ("image_file_id", "audio_file_id", "file_id")
SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def _new_slug(db: DbSession) -> str:
    for _ in range(10):
        slug = "".join(secrets.choice(SLUG_ALPHABET) for _ in range(16))
        if db.scalar(select(PublicLens.id).where(PublicLens.slug == slug)) is None:
            return slug
    raise ApiError(503, "slug_unavailable", "Could not create a public URL")


def _owned_lens(db: DbSession, user: User, lens_id: uuid.UUID) -> PublicLens:
    lens = db.get(PublicLens, lens_id)
    if lens is None:
        raise not_found()
    if lens.owner_id != user.id:
        raise ApiError(403, "owner_only", "Only the publisher can change this lens")
    return lens


def _lens_out(lens: PublicLens) -> PublicLensOut:
    return PublicLensOut.model_validate(lens).model_copy(
        update={
            "card_count": len(lens.snapshot.get("placements", [])),
            "view_mode": lens.snapshot.get("view_mode", "canvas"),
        }
    )


def _safe_public_lens_dir(lens_id: uuid.UUID) -> str:
    root = os.path.abspath(os.path.join(settings.files_dir, "public-lenses"))
    path = os.path.abspath(os.path.join(root, str(lens_id)))
    if os.path.commonpath((root, path)) != root:
        raise RuntimeError("public lens asset path escaped its root")
    return path


def _safe_public_dir(lens_id: uuid.UUID, revision: int) -> str:
    path = os.path.abspath(os.path.join(_safe_public_lens_dir(lens_id), str(revision)))
    os.makedirs(path, exist_ok=True)
    return path


def _copy_asset(
    db: DbSession,
    lens_id: uuid.UUID,
    revision: int,
    source: File,
) -> PublicLensAsset | None:
    if not os.path.isfile(source.path):
        return None
    asset_id = uuid.uuid4()
    extension = os.path.splitext(source.path)[1][:12]
    path = os.path.join(_safe_public_dir(lens_id, revision), f"{asset_id}{extension}")
    shutil.copyfile(source.path, path)
    asset = PublicLensAsset(
        id=asset_id,
        lens_id=lens_id,
        source_file_id=source.id,
        revision=revision,
        path=path,
        mime=source.mime,
        name=source.name,
        bytes=source.bytes,
    )
    db.add(asset)
    return asset


def _public_body(body: str | None, included_card_ids: set[uuid.UUID]) -> str | None:
    if not body:
        return body

    def replace(match: re.Match[str]) -> str:
        label, raw_id = match.groups()
        try:
            target_id = uuid.UUID(raw_id)
        except ValueError:
            return label
        return match.group(0) if target_id in included_card_ids else label

    public = CARD_REFERENCE_RE.sub(replace, body)

    def replace_html(match: re.Match[str]) -> str:
        try:
            target_id = uuid.UUID(match.group(1))
        except ValueError:
            return match.group(2)
        return match.group(0) if target_id in included_card_ids else match.group(2)

    return HTML_CARD_REFERENCE_RE.sub(replace_html, public)


def _public_payload(
    db: DbSession,
    lens_id: uuid.UUID,
    revision: int,
    card: Card,
) -> tuple[dict, list[str]]:
    raw = dict(card.payload or {})
    allowed = set(PAINT_KEYS) | set(PAYLOAD_KEYS.get(card.type, ()))
    payload = {key: raw[key] for key in allowed if key in raw}
    asset_ids: list[str] = []
    for key in ASSET_KEYS:
        raw_id = raw.get(key)
        if not raw_id:
            continue
        try:
            source = db.get(File, uuid.UUID(str(raw_id)))
        except ValueError:
            source = None
        if source is None or source.card_id != card.id:
            continue
        asset = _copy_asset(db, lens_id, revision, source)
        if asset is None:
            continue
        payload[key] = str(asset.id)
        asset_ids.append(str(asset.id))
    return payload, asset_ids


def _build_snapshot(
    db: DbSession,
    user: User,
    lens_id: uuid.UUID,
    revision: int,
    body: PublicLensPublishIn,
) -> dict:
    canvas = get_owned_canvas(db, user, body.canvas_id)
    all_placements = list(
        db.scalars(
            select(Placement)
            .options(joinedload(Placement.card))
            .where(Placement.canvas_id == canvas.id)
            .order_by(Placement.z, Placement.updated_at)
        )
    )
    by_id = {placement.id: placement for placement in all_placements}
    requested = set(body.placement_ids)
    if requested - by_id.keys():
        raise ApiError(400, "placement_missing", "Some selected cards are no longer here")

    # A selected container is one reviewed object. Include its visible contents
    # so publication cannot turn it into a mysteriously empty shell.
    included_placement_ids = set(requested)
    included_placement_ids.update(
        placement.id
        for placement in all_placements
        if placement.parent_id in requested
    )
    placements = [
        placement
        for placement in all_placements
        if placement.id in included_placement_ids
    ]
    foreign = [placement for placement in placements if placement.card.owner_id != user.id]
    if foreign:
        raise ApiError(
            403,
            "card_owner_only",
            "A public lens can only include cards you own",
        )

    card_ids = {placement.card_id for placement in placements}
    links = list(
        db.scalars(
            select(Link).where(
                Link.creator_id == user.id,
                Link.source_card_id.in_(card_ids),
                Link.target_card_id.in_(card_ids),
            )
        )
    ) if card_ids else []

    min_x = min((placement.x for placement in placements), default=0)
    min_y = min((placement.y for placement in placements), default=0)
    public_placements = []
    asset_ids: list[str] = []
    for placement in placements:
        card = placement.card
        payload, card_assets = _public_payload(db, lens_id, revision, card)
        asset_ids.extend(card_assets)
        public_placements.append(
            {
                "id": str(placement.id),
                "x": placement.x - min_x + 80,
                "y": placement.y - min_y + 80,
                "w": placement.w,
                "h": placement.h,
                "z": placement.z,
                "is_hub": placement.is_hub,
                "parent_id": (
                    str(placement.parent_id)
                    if placement.parent_id in included_placement_ids
                    else None
                ),
                "sort": placement.sort,
                "card": {
                    "id": str(card.id),
                    "type": card.type,
                    "title": card.title,
                    "body": _public_body(card.body, card_ids),
                    "payload": payload,
                },
            }
        )
    return {
        "version": 1,
        "title": body.title.strip(),
        "description": body.description.strip() if body.description else None,
        # Appearance and type scale are local canvas preferences, so the
        # publisher sends them with the reviewed selection. Freezing them in
        # the revision keeps the anonymous view visually faithful too.
        "appearance": body.appearance,
        "text_size": body.text_size,
        "view_mode": body.view_mode,
        # The request order is the author's path. Container members can be
        # included in the frozen snapshot without becoming surprise pages.
        "sequence": [
            str(placement_id)
            for placement_id in body.placement_ids
            if placement_id in included_placement_ids
        ],
        "placements": public_placements,
        "links": [
            {
                "id": str(link.id),
                "source_card_id": str(link.source_card_id),
                "target_card_id": str(link.target_card_id),
                "link_type": link.link_type,
                "note": link.note,
            }
            for link in links
        ],
        "asset_ids": asset_ids,
        "published_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/public-lenses", response_model=list[PublicLensOut])
def list_public_lenses(
    canvas_id: uuid.UUID | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    query = select(PublicLens).where(PublicLens.owner_id == user.id)
    if canvas_id is not None:
        query = query.where(PublicLens.canvas_id == canvas_id)
    rows = db.scalars(query.order_by(PublicLens.updated_at.desc())).all()
    return [_lens_out(lens) for lens in rows]


@router.post("/public-lenses", status_code=201, response_model=PublicLensOut)
def publish_lens(
    body: PublicLensPublishIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    lens_id = uuid.uuid4()
    snapshot = _build_snapshot(db, user, lens_id, 1, body)
    lens = PublicLens(
        id=lens_id,
        owner_id=user.id,
        canvas_id=body.canvas_id,
        slug=_new_slug(db),
        title=body.title.strip(),
        description=body.description.strip() if body.description else None,
        snapshot=snapshot,
        revision=1,
    )
    db.add(lens)
    db.flush()
    return _lens_out(lens)


@router.put("/public-lenses/{lens_id}", response_model=PublicLensOut)
def republish_lens(
    lens_id: uuid.UUID,
    body: PublicLensPublishIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    lens = _owned_lens(db, user, lens_id)
    if lens.canvas_id is not None and lens.canvas_id != body.canvas_id:
        raise ApiError(409, "wrong_canvas", "A lens can only update from its source canvas")
    revision = lens.revision + 1
    lens.snapshot = _build_snapshot(db, user, lens.id, revision, body)
    lens.canvas_id = body.canvas_id
    lens.title = body.title.strip()
    lens.description = body.description.strip() if body.description else None
    lens.revision = revision
    lens.published_at = datetime.now(timezone.utc)
    lens.revoked_at = None
    lens.updated_at = datetime.now(timezone.utc)
    return _lens_out(lens)


@router.delete("/public-lenses/{lens_id}", status_code=204)
def revoke_lens(
    lens_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    lens = _owned_lens(db, user, lens_id)
    lens.revoked_at = datetime.now(timezone.utc)
    lens.updated_at = datetime.now(timezone.utc)


@router.delete("/public-lenses/{lens_id}/permanent", status_code=204)
def permanently_delete_lens(
    lens_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Remove one publication and every private copy made for its revisions.

    The lens owns only its frozen snapshots and copied assets. Source cards,
    placements, links, and their original files are deliberately outside this
    delete boundary.
    """
    lens = _owned_lens(db, user, lens_id)
    asset_dir = _safe_public_lens_dir(lens.id)
    if os.path.islink(asset_dir) or os.path.isfile(asset_dir):
        os.unlink(asset_dir)
    elif os.path.isdir(asset_dir):
        # The directory contains every revision, including asset copies that
        # are no longer referenced by the lens's current snapshot.
        shutil.rmtree(asset_dir)
    # public_lens_assets cascades in the database; nothing points back from a
    # lens to the original canvas data, so deleting this row cannot touch it.
    db.delete(lens)


@router.get("/public/lenses/{slug}")
def public_lens(slug: str, db: DbSession = Depends(get_db)):
    lens = db.scalar(
        select(PublicLens).where(
            PublicLens.slug == slug,
            PublicLens.revoked_at.is_(None),
        )
    )
    if lens is None:
        raise not_found()
    return JSONResponse(
        content={
            "slug": lens.slug,
            "title": lens.title,
            "description": lens.description,
            "revision": lens.revision,
            "published_at": lens.published_at.isoformat(),
            "snapshot": lens.snapshot,
        },
        headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow"},
    )


@router.get("/public/lenses/{slug}/assets/{asset_id}")
def public_lens_asset(slug: str, asset_id: uuid.UUID, db: DbSession = Depends(get_db)):
    lens = db.scalar(
        select(PublicLens).where(
            PublicLens.slug == slug,
            PublicLens.revoked_at.is_(None),
        )
    )
    if lens is None or str(asset_id) not in set(lens.snapshot.get("asset_ids", [])):
        raise not_found()
    asset = db.scalar(
        select(PublicLensAsset).where(
            PublicLensAsset.id == asset_id,
            PublicLensAsset.lens_id == lens.id,
            PublicLensAsset.revision == lens.revision,
        )
    )
    if asset is None or not os.path.isfile(asset.path):
        raise not_found()
    inline = asset.mime.startswith(("image/", "audio/", "video/"))
    headers = {"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow"}
    if asset.mime == "image/svg+xml":
        headers["Content-Security-Policy"] = "sandbox"
    return FileResponse(
        asset.path,
        media_type=asset.mime if inline else "application/octet-stream",
        filename=None if inline else safe_name(asset.name),
        content_disposition_type="inline" if inline else "attachment",
        headers=headers,
    )
