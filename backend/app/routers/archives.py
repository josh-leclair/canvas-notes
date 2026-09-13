"""Portable, versioned Canvas Notes archives.

Archives are zip files containing a validated JSON manifest plus the original
cover and card attachment bytes. Imports always allocate fresh identifiers:
an archive can be brought back into the same account without overwriting or
silently merging live data.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession
from starlette.background import BackgroundTask

from app.access import get_owned_canvas, visible_link_condition
from app.auth import get_current_user
from app.config import settings
from app.db import get_db
from app.errors import ApiError
from app.media import safe_extension
from app.models import Canvas, Card, File as StoredFile, Link, Placement, User, Zone
from app.schemas.api import CardType

router = APIRouter(prefix="/api/archive", tags=["archive"])

FORMAT = "canvas-notes-archive"
VERSION = 1
MAX_MANIFEST_BYTES = 20 * 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_CANVASES = 2_000
MAX_CARDS = 100_000
MAX_ASSETS = 20_000
INT32_MIN = -(2**31)
INT32_MAX = 2**31 - 1
SAFE_MEMBER = re.compile(r"^(assets|covers)/[0-9a-f-]{36}(?:\.[a-z0-9]{1,10})?$")
UUID_TOKEN = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)


class StrictModel(BaseModel):
    # NaN and infinity are valid Python floats but not useful canvas geometry;
    # rejecting them here keeps a malformed archive out of both Postgres and
    # the renderer.
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ArchivePreference(StrictModel):
    appearance: Literal["studio", "pantry", "night_garden"] = "studio"
    text_size: int = Field(default=13, ge=9, le=22)


class ArchiveExportIn(StrictModel):
    canvas_id: uuid.UUID | None = None
    preferences: dict[str, ArchivePreference] = Field(
        default_factory=dict, max_length=MAX_CANVASES
    )


class ArchiveCanvas(StrictModel):
    id: uuid.UUID
    name: str = Field(min_length=1, max_length=500)
    is_infinite: bool
    width: float = Field(ge=640, le=100_000)
    height: float = Field(ge=480, le=100_000)
    preference: ArchivePreference = Field(default_factory=ArchivePreference)
    cover_member: str | None = None
    cover_mime: str | None = None
    cover_bytes: int | None = Field(default=None, ge=0)


class ArchiveCard(StrictModel):
    id: uuid.UUID
    type: CardType
    title: str | None = None
    body: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    due_at: datetime | None = None
    eta_minutes: int | None = Field(default=None, ge=1, le=INT32_MAX)
    timer_started_at: datetime | None = None
    timer_elapsed_seconds: int = Field(default=0, ge=0, le=INT32_MAX)
    reminder_minutes: int | None = Field(default=None, ge=0, le=INT32_MAX)
    inbox_canvas_id: uuid.UUID | None = None


class ArchivePlacement(StrictModel):
    id: uuid.UUID
    canvas_id: uuid.UUID
    card_id: uuid.UUID
    x: float
    y: float
    w: float = Field(gt=0)
    h: float = Field(gt=0)
    z: int = Field(ge=INT32_MIN, le=INT32_MAX)
    is_hub: bool = False
    magic_fixed: bool = False
    parent_id: uuid.UUID | None = None
    sort: int = Field(default=0, ge=INT32_MIN, le=INT32_MAX)


class ArchiveZone(StrictModel):
    id: uuid.UUID
    canvas_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)
    x: float
    y: float
    w: float = Field(gt=80)
    h: float = Field(gt=80)
    sort: int = Field(default=0, ge=INT32_MIN, le=INT32_MAX)


class ArchiveLink(StrictModel):
    id: uuid.UUID
    source_card_id: uuid.UUID
    target_card_id: uuid.UUID
    link_type: str | None = None
    note: str | None = None
    created_on_canvas_id: uuid.UUID | None = None
    source_snapshot: dict[str, Any] = Field(default_factory=dict)
    target_snapshot: dict[str, Any] = Field(default_factory=dict)


class ArchiveFile(StrictModel):
    id: uuid.UUID
    card_id: uuid.UUID
    member: str
    mime: str = Field(min_length=1, max_length=200)
    bytes: int = Field(ge=0)
    name: str | None = Field(default=None, max_length=200)


class ArchiveManifest(StrictModel):
    format: Literal["canvas-notes-archive"]
    version: Literal[1]
    scope: Literal["all", "canvas"]
    root_canvas_id: uuid.UUID | None = None
    exported_at: datetime
    canvases: list[ArchiveCanvas] = Field(max_length=MAX_CANVASES)
    cards: list[ArchiveCard] = Field(max_length=MAX_CARDS)
    placements: list[ArchivePlacement] = Field(max_length=MAX_CARDS * 4)
    zones: list[ArchiveZone] = Field(max_length=MAX_CARDS)
    links: list[ArchiveLink] = Field(max_length=MAX_CARDS * 4)
    files: list[ArchiveFile] = Field(max_length=MAX_ASSETS)


class ImportedCanvas(StrictModel):
    source_id: uuid.UUID
    id: uuid.UUID
    name: str
    appearance: Literal["studio", "pantry", "night_garden"]
    text_size: int


class ArchiveImportOut(StrictModel):
    scope: Literal["all", "canvas"]
    root_canvas_id: uuid.UUID | None
    canvases: list[ImportedCanvas]
    card_count: int
    file_count: int


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _safe_archive_extension(path: str) -> str:
    return safe_extension(os.path.basename(path))


def _owned_nested_canvas_ids(
    db: DbSession, user: User, initial: set[uuid.UUID]
) -> set[uuid.UUID]:
    """Follow board cards so a specific-canvas archive stays navigable."""
    found = set(initial)
    frontier = set(initial)
    while frontier:
        payloads = db.scalars(
            select(Card.payload)
            .join(Placement, Placement.card_id == Card.id)
            .where(Placement.canvas_id.in_(frontier), Card.type == "board")
        ).all()
        candidates = {
            candidate
            for payload in payloads
            if (candidate := _uuid((payload or {}).get("canvas_id"))) is not None
            and candidate not in found
        }
        if not candidates:
            break
        owned = set(
            db.scalars(
                select(Canvas.id).where(
                    Canvas.id.in_(candidates), Canvas.owner_id == user.id
                )
            ).all()
        )
        found.update(owned)
        frontier = owned
    return found


def _preference(body: ArchiveExportIn, canvas_id: uuid.UUID) -> ArchivePreference:
    return body.preferences.get(str(canvas_id), ArchivePreference())


def _unique(items: list[Any], label: str) -> set[uuid.UUID]:
    ids = {item.id for item in items}
    if len(ids) != len(items):
        raise ApiError(400, "invalid_archive", f"The archive contains duplicate {label} IDs")
    return ids


def _validate_manifest(manifest: ArchiveManifest, archive: zipfile.ZipFile) -> None:
    canvas_ids = _unique(manifest.canvases, "canvas")
    card_ids = _unique(manifest.cards, "card")
    placement_ids = _unique(manifest.placements, "placement")
    _unique(manifest.zones, "zone")
    _unique(manifest.links, "link")
    _unique(manifest.files, "file")

    if manifest.scope == "canvas":
        if manifest.root_canvas_id is None or manifest.root_canvas_id not in canvas_ids:
            raise ApiError(400, "invalid_archive", "The archive has no root canvas")
    elif manifest.root_canvas_id is not None:
        raise ApiError(400, "invalid_archive", "A workspace archive cannot have a root canvas")

    for placement in manifest.placements:
        if placement.canvas_id not in canvas_ids or placement.card_id not in card_ids:
            raise ApiError(400, "invalid_archive", "A placement points outside the archive")
        if placement.parent_id is not None and placement.parent_id not in placement_ids:
            raise ApiError(400, "invalid_archive", "A column member has no parent placement")
    placement_canvas = {item.id: item.canvas_id for item in manifest.placements}
    placement_card = {item.id: item.card_id for item in manifest.placements}
    card_type = {item.id: item.type for item in manifest.cards}
    canvas_card_pairs = {
        (item.canvas_id, item.card_id) for item in manifest.placements
    }
    if len(canvas_card_pairs) != len(manifest.placements):
        raise ApiError(400, "invalid_archive", "A card is placed twice on one canvas")
    for placement in manifest.placements:
        if placement.parent_id == placement.id:
            raise ApiError(400, "invalid_archive", "A placement cannot contain itself")
        if (
            placement.parent_id is not None
            and placement_canvas[placement.parent_id] != placement.canvas_id
        ):
            raise ApiError(400, "invalid_archive", "A column crosses canvas boundaries")
        if placement.parent_id is not None:
            if card_type[placement_card[placement.parent_id]] != "column":
                raise ApiError(400, "invalid_archive", "A placement parent is not a column")
            if card_type[placement.card_id] == "column":
                raise ApiError(400, "invalid_archive", "Columns cannot be nested")
    for zone in manifest.zones:
        if zone.canvas_id not in canvas_ids:
            raise ApiError(400, "invalid_archive", "A zone points outside the archive")
    for link in manifest.links:
        if link.source_card_id not in card_ids or link.target_card_id not in card_ids:
            raise ApiError(400, "invalid_archive", "A link points outside the archive")
        if (
            link.created_on_canvas_id is not None
            and link.created_on_canvas_id not in canvas_ids
        ):
            raise ApiError(400, "invalid_archive", "A link names a canvas outside the archive")
    for item in manifest.files:
        if item.card_id not in card_ids:
            raise ApiError(400, "invalid_archive", "An attachment points outside the archive")
    for card in manifest.cards:
        if card.inbox_canvas_id is not None and card.inbox_canvas_id not in canvas_ids:
            raise ApiError(400, "invalid_archive", "An inbox points outside the archive")

    names = [item.filename for item in archive.infolist()]
    if len(names) != len(set(names)):
        raise ApiError(400, "invalid_archive", "The archive contains duplicate files")
    declared = {item.member for item in manifest.files}
    cover_members = [
        item.cover_member for item in manifest.canvases if item.cover_member is not None
    ]
    all_declared = [item.member for item in manifest.files] + cover_members
    if len(all_declared) != len(set(all_declared)):
        raise ApiError(400, "invalid_archive", "Archive entries must have unique file names")
    declared.update(cover_members)
    if set(names) != {"manifest.json", *declared}:
        raise ApiError(400, "invalid_archive", "The archive contains undeclared files")
    if any(not SAFE_MEMBER.fullmatch(name) for name in declared):
        raise ApiError(400, "invalid_archive", "The archive contains an unsafe file path")
    info = {item.filename: item for item in archive.infolist()}
    expected_sizes = {item.member: item.bytes for item in manifest.files}
    for canvas in manifest.canvases:
        if canvas.cover_member is None:
            if canvas.cover_bytes is not None or canvas.cover_mime is not None:
                raise ApiError(400, "invalid_archive", "A cover is missing from the archive")
            continue
        if canvas.cover_bytes is None or info[canvas.cover_member].file_size != canvas.cover_bytes:
            raise ApiError(400, "invalid_archive", "A cover size does not match its manifest")
    if any(info[name].file_size != size for name, size in expected_sizes.items()):
        raise ApiError(400, "invalid_archive", "An attachment size does not match its manifest")
    if sum(item.file_size for item in archive.infolist()) > MAX_ARCHIVE_BYTES:
        raise ApiError(413, "archive_too_large", "That archive expands beyond the import limit")


def _remap(value: Any, identifiers: dict[str, str]) -> Any:
    """Rewrite identifiers anywhere a card payload stores them."""
    if isinstance(value, str):
        return UUID_TOKEN.sub(
            lambda match: identifiers.get(match.group(0).lower(), match.group(0)),
            value,
        )
    if isinstance(value, list):
        return [_remap(item, identifiers) for item in value]
    if isinstance(value, dict):
        return {key: _remap(item, identifiers) for key, item in value.items()}
    return value


@router.post("/export")
def export_archive(
    body: ArchiveExportIn,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    if body.canvas_id is not None:
        root = get_owned_canvas(db, user, body.canvas_id)
        canvas_ids = _owned_nested_canvas_ids(db, user, {root.id})
        scope: Literal["all", "canvas"] = "canvas"
    else:
        root = None
        canvas_ids = set(
            db.scalars(select(Canvas.id).where(Canvas.owner_id == user.id)).all()
        )
        scope = "all"

    canvases = list(
        db.scalars(select(Canvas).where(Canvas.id.in_(canvas_ids)).order_by(Canvas.created_at))
    ) if canvas_ids else []
    placements = list(
        db.scalars(
            select(Placement)
            .where(Placement.canvas_id.in_(canvas_ids))
            .order_by(Placement.canvas_id, Placement.z, Placement.updated_at)
        )
    ) if canvas_ids else []
    card_ids = {placement.card_id for placement in placements}
    # A canvas's routed inbox is part of that canvas even though those cards
    # deliberately have no placement yet.
    card_ids.update(
        db.scalars(
            select(Card.id).where(
                Card.owner_id == user.id,
                Card.inbox_canvas_id.in_(canvas_ids),
            )
        ).all()
    )
    if scope == "all":
        card_ids.update(
            db.scalars(select(Card.id).where(Card.owner_id == user.id)).all()
        )
    cards = list(
        db.scalars(select(Card).where(Card.id.in_(card_ids)).order_by(Card.created_at))
    ) if card_ids else []
    zones = list(
        db.scalars(
            select(Zone).where(Zone.canvas_id.in_(canvas_ids)).order_by(Zone.canvas_id, Zone.sort)
        )
    ) if canvas_ids else []
    links = list(
        db.scalars(
            select(Link).where(
                visible_link_condition(user.id),
                Link.source_card_id.in_(card_ids),
                Link.target_card_id.in_(card_ids),
            )
        )
    ) if card_ids else []
    files = list(
        db.scalars(select(StoredFile).where(StoredFile.card_id.in_(card_ids)))
    ) if card_ids else []

    archive_canvases: list[ArchiveCanvas] = []
    asset_paths: list[tuple[str, str]] = []
    for canvas in canvases:
        cover_member = None
        if canvas.cover_path and os.path.isfile(canvas.cover_path):
            cover_member = f"covers/{canvas.id}{_safe_archive_extension(canvas.cover_path)}"
            asset_paths.append((canvas.cover_path, cover_member))
        archive_canvases.append(
            ArchiveCanvas(
                id=canvas.id,
                name=canvas.name,
                is_infinite=canvas.is_infinite,
                width=canvas.width,
                height=canvas.height,
                preference=_preference(body, canvas.id),
                cover_member=cover_member,
                cover_mime=canvas.cover_mime if cover_member else None,
                cover_bytes=(
                    os.path.getsize(canvas.cover_path)
                    if cover_member and canvas.cover_path
                    else None
                ),
            )
        )

    archive_files: list[ArchiveFile] = []
    for record in files:
        if not os.path.isfile(record.path):
            continue
        member = f"assets/{record.id}{_safe_archive_extension(record.path)}"
        archive_files.append(
            ArchiveFile(
                id=record.id,
                card_id=record.card_id,
                member=member,
                mime=record.mime,
                bytes=os.path.getsize(record.path),
                name=record.name,
            )
        )
        asset_paths.append((record.path, member))

    manifest = ArchiveManifest(
        format=FORMAT,
        version=VERSION,
        scope=scope,
        root_canvas_id=root.id if root else None,
        exported_at=datetime.now(timezone.utc),
        canvases=archive_canvases,
        cards=[
            ArchiveCard(
                id=card.id,
                type=card.type,
                title=card.title,
                body=card.body,
                payload=card.payload or {},
                due_at=card.due_at,
                eta_minutes=card.eta_minutes,
                timer_started_at=card.timer_started_at,
                timer_elapsed_seconds=card.timer_elapsed_seconds,
                reminder_minutes=card.reminder_minutes,
                inbox_canvas_id=(
                    card.inbox_canvas_id if card.inbox_canvas_id in canvas_ids else None
                ),
            )
            for card in cards
        ],
        placements=[
            ArchivePlacement(
                id=item.id,
                canvas_id=item.canvas_id,
                card_id=item.card_id,
                x=item.x,
                y=item.y,
                w=item.w,
                h=item.h,
                z=item.z,
                is_hub=item.is_hub,
                magic_fixed=item.magic_fixed,
                parent_id=item.parent_id,
                sort=item.sort,
            )
            for item in placements
        ],
        zones=[
            ArchiveZone(
                id=item.id,
                canvas_id=item.canvas_id,
                name=item.name,
                x=item.x,
                y=item.y,
                w=item.w,
                h=item.h,
                sort=item.sort,
            )
            for item in zones
        ],
        links=[
            ArchiveLink(
                id=item.id,
                source_card_id=item.source_card_id,
                target_card_id=item.target_card_id,
                link_type=item.link_type,
                note=item.note,
                created_on_canvas_id=(
                    item.created_on_canvas_id
                    if item.created_on_canvas_id in canvas_ids
                    else None
                ),
                source_snapshot=item.source_snapshot or {},
                target_snapshot=item.target_snapshot or {},
            )
            for item in links
        ],
        files=archive_files,
    )

    temp = tempfile.NamedTemporaryFile(prefix="canvas-notes-", suffix=".zip", delete=False)
    temp.close()
    try:
        with zipfile.ZipFile(temp.name, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as output:
            output.writestr(
                "manifest.json",
                json.dumps(manifest.model_dump(mode="json"), ensure_ascii=False, indent=2),
            )
            for source, member in asset_paths:
                output.write(source, member)
    except Exception:
        os.unlink(temp.name)
        raise

    base = re.sub(r"[^a-zA-Z0-9._-]+", "-", root.name if root else "all-canvases").strip("-")
    filename = f"{base or 'canvas-notes'}-{datetime.now().date().isoformat()}.canvas-notes.zip"
    return FileResponse(
        temp.name,
        media_type="application/zip",
        filename=filename,
        background=BackgroundTask(os.unlink, temp.name),
    )


@router.post("/import", response_model=ArchiveImportOut)
def import_archive(
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    written: list[str] = []
    try:
        file.file.seek(0)
        with zipfile.ZipFile(file.file) as archive:
            try:
                manifest_info = archive.getinfo("manifest.json")
            except KeyError as exc:
                raise ApiError(400, "invalid_archive", "The archive has no manifest") from exc
            if manifest_info.file_size > MAX_MANIFEST_BYTES:
                raise ApiError(413, "archive_too_large", "The archive manifest is too large")
            try:
                raw = json.loads(archive.read(manifest_info))
                manifest = ArchiveManifest.model_validate(raw)
            except (json.JSONDecodeError, UnicodeDecodeError, ValidationError) as exc:
                raise ApiError(400, "invalid_archive", "The archive manifest is invalid") from exc
            _validate_manifest(manifest, archive)

            canvas_map = {item.id: uuid.uuid4() for item in manifest.canvases}
            card_map = {item.id: uuid.uuid4() for item in manifest.cards}
            placement_map = {item.id: uuid.uuid4() for item in manifest.placements}
            file_map = {item.id: uuid.uuid4() for item in manifest.files}
            identifiers = {
                str(old): str(new)
                for mapping in (canvas_map, card_map, placement_map, file_map)
                for old, new in mapping.items()
            }

            os.makedirs(settings.files_dir, exist_ok=True)
            imported_at = datetime.now(timezone.utc)
            for item in manifest.canvases:
                row = Canvas(
                    id=canvas_map[item.id],
                    owner_id=user.id,
                    name=item.name,
                    is_infinite=item.is_infinite,
                    width=item.width,
                    height=item.height,
                )
                if item.cover_member:
                    destination = os.path.join(
                        settings.files_dir,
                        f"{row.id}{safe_extension(item.cover_member)}",
                    )
                    with archive.open(item.cover_member) as source, open(
                        destination, "wb"
                    ) as output:
                        shutil.copyfileobj(source, output, 1024 * 1024)
                    written.append(destination)
                    row.cover_path = destination
                    row.cover_mime = item.cover_mime or "image/png"
                db.add(row)

            for item in manifest.cards:
                elapsed = item.timer_elapsed_seconds
                timer_started_at = None
                if item.timer_started_at is not None:
                    started = item.timer_started_at
                    if started.tzinfo is None:
                        started = started.replace(tzinfo=timezone.utc)
                    exported_at = manifest.exported_at
                    if exported_at.tzinfo is None:
                        exported_at = exported_at.replace(tzinfo=timezone.utc)
                    elapsed = min(
                        INT32_MAX,
                        elapsed + max(0, int((exported_at - started).total_seconds())),
                    )
                    timer_started_at = imported_at
                row = Card(
                    id=card_map[item.id],
                    owner_id=user.id,
                    type=item.type,
                    title=item.title,
                    body=_remap(item.body, identifiers),
                    payload=_remap(item.payload, identifiers),
                    due_at=item.due_at,
                    eta_minutes=item.eta_minutes,
                    timer_started_at=timer_started_at,
                    timer_elapsed_seconds=elapsed,
                    reminder_minutes=item.reminder_minutes,
                    inbox_canvas_id=(
                        canvas_map.get(item.inbox_canvas_id)
                        if item.inbox_canvas_id is not None
                        else None
                    ),
                )
                db.add(row)

            for item in manifest.files:
                new_id = file_map[item.id]
                destination = os.path.join(
                    settings.files_dir,
                    f"{new_id}{safe_extension(item.member)}",
                )
                with archive.open(item.member) as source, open(destination, "wb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                written.append(destination)
                db.add(
                    StoredFile(
                        id=new_id,
                        card_id=card_map[item.card_id],
                        path=destination,
                        mime=item.mime,
                        bytes=item.bytes,
                        name=item.name,
                    )
                )

            placement_rows: dict[uuid.UUID, Placement] = {}
            for item in manifest.placements:
                row = Placement(
                    id=placement_map[item.id],
                    canvas_id=canvas_map[item.canvas_id],
                    card_id=card_map[item.card_id],
                    x=item.x,
                    y=item.y,
                    w=item.w,
                    h=item.h,
                    z=item.z,
                    is_hub=item.is_hub,
                    magic_fixed=item.magic_fixed,
                    parent_id=None,
                    sort=item.sort,
                )
                placement_rows[item.id] = row
                db.add(row)
            # Self-referential placement FKs need their parents to exist first.
            db.flush()
            for item in manifest.placements:
                if item.parent_id is not None:
                    placement_rows[item.id].parent_id = placement_map[item.parent_id]
            for item in manifest.zones:
                db.add(
                    Zone(
                        id=uuid.uuid4(),
                        canvas_id=canvas_map[item.canvas_id],
                        name=item.name,
                        x=item.x,
                        y=item.y,
                        w=item.w,
                        h=item.h,
                        sort=item.sort,
                    )
                )
            for item in manifest.links:
                db.add(
                    Link(
                        id=uuid.uuid4(),
                        creator_id=user.id,
                        source_card_id=card_map[item.source_card_id],
                        target_card_id=card_map[item.target_card_id],
                        link_type=item.link_type,
                        note=item.note,
                        created_on_canvas_id=(
                            canvas_map.get(item.created_on_canvas_id)
                            if item.created_on_canvas_id is not None
                            else None
                        ),
                        source_snapshot=_remap(item.source_snapshot, identifiers),
                        target_snapshot=_remap(item.target_snapshot, identifiers),
                    )
                )
            imported = [
                ImportedCanvas(
                    source_id=item.id,
                    id=canvas_map[item.id],
                    name=item.name,
                    appearance=item.preference.appearance,
                    text_size=item.preference.text_size,
                )
                for item in manifest.canvases
            ]
            result = ArchiveImportOut(
                scope=manifest.scope,
                root_canvas_id=(
                    canvas_map.get(manifest.root_canvas_id)
                    if manifest.root_canvas_id is not None
                    else None
                ),
                canvases=imported,
                card_count=len(manifest.cards),
                file_count=len(manifest.files),
            )
            # Commit while the extraction cleanup guard is still active. If
            # Postgres rejects anything, the copied files are removed instead
            # of becoming unreferenced filesystem debris.
            db.commit()
            return result
    except zipfile.BadZipFile as exc:
        raise ApiError(400, "invalid_archive", "That file is not a Canvas Notes archive") from exc
    except Exception:
        for path in written:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
        raise
