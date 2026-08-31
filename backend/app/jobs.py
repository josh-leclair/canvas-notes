"""Postgres-backed job queue.

Jobs are rows claimed with `for update skip locked`. Workers declare which
kinds they support and never claim the rest, so transcription jobs can wait in
the queue while only an unfurl-capable worker is running. Nothing here blocks
the UI; failures retry three times, then park as errors.
"""
import logging
import os
import json
import threading
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlparse

from sqlalchemy import bindparam, select, text
from sqlalchemy.orm import Session as DbSession

from app.config import settings
from app.db import SessionLocal
from app.embeddings import embed_text, embeddable_text
from app.fetch import FetchBlocked, guarded_get
from app.generate import compose_document, markdown_blocks, split_text, splittable_text
from app.models import Canvas, Card, File, Job, Link, Placement, User
from app.runtime_settings import AiConfig, get_ai_config
from app.unfurl import parse_unfurl, youtube_video_id
from app.urls import spotify_url, youtube_url

log = logging.getLogger("jobs")

MAX_ATTEMPTS = 3
RETRY_DELAY = timedelta(seconds=30)


def enqueue(db: DbSession, kind: str, payload: dict) -> Job:
    job = Job(kind=kind, payload=payload)
    db.add(job)
    db.flush()
    return job


def enqueue_unfurl_if_needed(db: DbSession, card: Card) -> None:
    """Called on card create/patch. Extracts a YouTube id eagerly, queues the fetch."""
    if card.type not in ("link", "youtube"):
        return
    url = card.payload.get("url")
    if not url:
        return
    video_id = youtube_video_id(str(url))
    if video_id:
        card.payload = {**card.payload, "video_id": video_id}
    card.payload = {**card.payload, "unfurl_status": "queued"}
    enqueue(db, "unfurl", {"card_id": str(card.id)})


def spotify_url_for_card(card: Card) -> str | None:
    if card.type != "text":
        return None
    return spotify_url("\n".join(part for part in (card.title, card.body) if part))


def enqueue_spotify_if_needed(
    db: DbSession, card: Card, previous_url: str | None = None
) -> None:
    """Attach Spotify metadata to a normal note without changing its type."""
    current_url = spotify_url_for_card(card)
    payload = dict(card.payload)
    if current_url is None:
        for key in ("spotify_url", "spotify_status", "spotify"):
            payload.pop(key, None)
        card.payload = payload
        return
    if (
        current_url == previous_url
        and payload.get("spotify_status") in ("queued", "done", "error")
    ):
        return
    payload.pop("spotify", None)
    payload.update({"spotify_url": current_url, "spotify_status": "queued"})
    card.payload = payload
    enqueue(db, "unfurl", {"card_id": str(card.id), "spotify_url": current_url})


def youtube_url_for_card(card: Card) -> str | None:
    if card.type != "text":
        return None
    return youtube_url("\n".join(part for part in (card.title, card.body) if part))


def enqueue_youtube_attachment_if_needed(
    db: DbSession, card: Card, previous_url: str | None = None
) -> None:
    """Attach a YouTube preview to a note while keeping it a normal note."""
    current_url = youtube_url_for_card(card)
    payload = dict(card.payload)
    if current_url is None:
        for key in ("youtube_url", "youtube_status", "youtube"):
            payload.pop(key, None)
        card.payload = payload
        return
    if (
        current_url == previous_url
        and payload.get("youtube_status") in ("queued", "done", "error")
    ):
        return
    payload.pop("youtube", None)
    payload.update({"youtube_url": current_url, "youtube_status": "queued"})
    card.payload = payload
    enqueue(db, "unfurl", {"card_id": str(card.id), "youtube_url": current_url})


def enqueue_embed_if_needed(db: DbSession, card: Card) -> None:
    """Enqueued on create and on any edit to embeddable text. When no endpoint
    is configured the job is skipped entirely rather than queued to fail."""
    if not get_ai_config(db).embeddings_configured:
        return
    if not embeddable_text(card):
        return
    enqueue(db, "embed", {"card_id": str(card.id)})


def local_whisper_available() -> bool:
    try:
        import faster_whisper  # noqa: F401

        return True
    except ImportError:
        return False


def transcription_available(config: AiConfig | None = None) -> bool:
    """Either a remote endpoint or a local model will do."""
    config = config or get_ai_config()
    return bool(config.whisper_base_url) or local_whisper_available()


def transcription_mode(config: AiConfig | None = None) -> str:
    config = config or get_ai_config()
    if config.whisper_base_url:
        return "remote"
    return "local" if local_whisper_available() else "unavailable"


def generation_available(config: AiConfig | None = None) -> bool:
    config = config or get_ai_config()
    return config.generation_configured


def supported_kinds() -> list[str]:
    config = get_ai_config()
    kinds = ["unfurl"]
    if transcription_available(config):
        kinds.append("transcribe")
    if config.embeddings_configured:
        kinds.append("embed")
    if generation_available(config):
        kinds.extend(["split", "compose", "refresh_compose"])
    return kinds


# --- handlers -------------------------------------------------------------


def _spotify_oembed(url: str) -> dict:
    endpoint = "https://open.spotify.com/oembed?url=" + quote(url, safe="")
    _, body = guarded_get(endpoint)
    return json.loads(body.decode("utf-8"))


def _spotify_kind(url: str) -> str:
    parts = [part for part in urlparse(url).path.split("/") if part]
    for candidate in ("track", "album", "playlist", "episode", "show", "artist"):
        if candidate in parts:
            return candidate.replace("show", "podcast").title()
    return "Spotify"


def handle_unfurl(db: DbSession, payload: dict) -> None:
    card = db.get(Card, uuid.UUID(payload["card_id"]))
    if card is None:
        return
    requested_spotify_url = payload.get("spotify_url")
    if requested_spotify_url:
        # An older queued job must not overwrite a note after its URL changes.
        if card.payload.get("spotify_url") != requested_spotify_url:
            return
        try:
            data = _spotify_oembed(str(requested_spotify_url))
        except Exception as exc:
            log.info("spotify unfurl of %s failed: %s", requested_spotify_url, exc)
            card.payload = {**card.payload, "spotify_status": "error"}
            card.updated_at = datetime.now(timezone.utc)
            return

        card.payload = {
            **card.payload,
            "spotify": {
                "url": requested_spotify_url,
                "title": data.get("title"),
                "thumbnail_url": data.get("thumbnail_url"),
                "kind": _spotify_kind(str(requested_spotify_url)),
            },
            "spotify_status": "done",
        }
        card.updated_at = datetime.now(timezone.utc)
        db.flush()
        return
    requested_youtube_url = payload.get("youtube_url")
    if requested_youtube_url:
        if card.payload.get("youtube_url") != requested_youtube_url:
            return
        try:
            final_url, body = guarded_get(str(requested_youtube_url))
            data = parse_unfurl(body.decode("utf-8", errors="replace"), final_url)
        except (FetchBlocked, Exception) as exc:
            log.info("youtube attachment unfurl of %s failed: %s", requested_youtube_url, exc)
            card.payload = {**card.payload, "youtube_status": "error"}
            card.updated_at = datetime.now(timezone.utc)
            return
        card.payload = {
            **card.payload,
            "youtube": {
                "url": requested_youtube_url,
                "title": data.get("title"),
                "thumbnail_url": data.get("image"),
                "kind": "Video",
            },
            "youtube_status": "done",
        }
        card.updated_at = datetime.now(timezone.utc)
        db.flush()
        return
    url = card.payload.get("url")
    if not url:
        return
    if spotify_url(str(url)):
        try:
            data = _spotify_oembed(str(url))
        except Exception as exc:
            log.info("spotify link unfurl of %s failed: %s", url, exc)
            card.payload = {**card.payload, "unfurl_status": "error"}
            card.updated_at = datetime.now(timezone.utc)
            return
        card.payload = {
            **card.payload,
            "unfurl": {
                "title": data.get("title"),
                "image": data.get("thumbnail_url"),
                "site_name": "Spotify",
                "final_url": url,
            },
            "unfurl_status": "done",
        }
        if not card.title and data.get("title"):
            card.title = data["title"]
        card.updated_at = datetime.now(timezone.utc)
        db.flush()
        return
    try:
        final_url, body = guarded_get(str(url))
    except (FetchBlocked, Exception) as exc:
        # Blocked or unreachable URLs don't benefit from retries; record the
        # failure on the card so the UI stops showing a pending state.
        log.info("unfurl of %s failed: %s", url, exc)
        card.payload = {**card.payload, "unfurl_status": "error"}
        card.updated_at = datetime.now(timezone.utc)
        return

    data = parse_unfurl(body.decode("utf-8", errors="replace"), final_url)
    card.payload = {
        **card.payload,
        "unfurl": {**data, "final_url": final_url},
        "unfurl_status": "done",
    }
    if not card.title and data.get("title"):
        card.title = data["title"]
    card.updated_at = datetime.now(timezone.utc)
    db.flush()
    # The unfurled description is embeddable text that did not exist until now.
    enqueue_embed_if_needed(db, card)


_whisper_model = None


def _transcribe_remote(path: str, mime: str, config: AiConfig) -> str:
    """Any OpenAI-compatible /audio/transcriptions endpoint."""
    import httpx

    headers = {}
    if config.whisper_api_key:
        headers["Authorization"] = f"Bearer {config.whisper_api_key}"
    # Most self-hosted servers load exactly one model and reject or ignore a
    # name; only send one when the admin actually set it.
    data = {"model": config.whisper_model} if config.whisper_model else {}
    with open(path, "rb") as audio:
        resp = httpx.post(
            f"{config.whisper_base_url}/audio/transcriptions",
            files={"file": (os.path.basename(path), audio, mime)},
            data=data,
            headers=headers,
            timeout=600.0,
        )
    resp.raise_for_status()
    body = resp.json()
    return (body.get("text") or "").strip()


LOCAL_WHISPER_DEFAULT = "small"


def _transcribe_local(path: str, config: AiConfig) -> str:
    """Unlike a remote endpoint, faster-whisper has to be told which weights
    to download, so this is the one place a name is still required."""
    global _whisper_model
    from faster_whisper import WhisperModel

    if _whisper_model is None:
        _whisper_model = WhisperModel(
            config.whisper_model or LOCAL_WHISPER_DEFAULT, compute_type="int8"
        )
    segments, _info = _whisper_model.transcribe(path)
    return " ".join(segment.text.strip() for segment in segments).strip()


def handle_transcribe(db: DbSession, payload: dict) -> None:
    card = db.get(Card, uuid.UUID(payload["card_id"]))
    file = db.get(File, uuid.UUID(payload["file_id"]))
    if card is None or file is None:
        return
    config = get_ai_config(db)
    if config.whisper_base_url:
        transcript = _transcribe_remote(file.path, file.mime, config)
    else:
        transcript = _transcribe_local(file.path, config)
    card.payload = {
        **card.payload,
        "transcript": transcript,
        "transcript_status": "done",
    }
    card.updated_at = datetime.now(timezone.utc)
    db.flush()
    # A transcript is embeddable text that did not exist until now.
    enqueue_embed_if_needed(db, card)


def handle_embed(db: DbSession, payload: dict) -> None:
    card = db.get(Card, uuid.UUID(payload["card_id"]))
    if card is None:
        return
    vector = embed_text(embeddable_text(card), get_ai_config(db))
    if vector is None:
        return
    # Written with raw SQL so the vector column needs no ORM mapping and the
    # app carries no pgvector Python dependency.
    db.execute(
        text("update cards set embedding = :vec ::vector where id = :id").bindparams(
            bindparam("vec", "[" + ",".join(repr(float(v)) for v in vector) + "]"),
            bindparam("id", card.id),
        )
    )


def handle_split(db: DbSession, payload: dict) -> None:
    """Break one card's text into several, straight into the author's inbox.

    Nothing is written to the source card and nothing is placed: these arrive
    exactly like a share-sheet capture, and arranging them is the human's
    half of the job. Each one is stamped with where it came from.
    """
    # Imported here because capture.py imports this module for its enqueues.
    from app.capture import capture_card

    card = db.get(Card, uuid.UUID(payload["card_id"]))
    user = db.get(User, uuid.UUID(payload["user_id"]))
    if card is None or user is None:
        return

    config = get_ai_config(db)
    source = splittable_text(card)
    if not source:
        return

    result = split_text(source, config, limit=int(payload.get("limit", 6)))
    parts, hero = result["cards"], result["hero"]
    if not parts and not hero:
        # An empty result is a real outcome, not a failure to retry: the same
        # prompt against the same model will produce the same nothing. The
        # batch simply reports zero cards.
        log.info("split of card %s produced no usable cards", card.id)
        return

    stamp = {
        "generated_by": {
            "model": config.chat_model,
            "at": datetime.now(timezone.utc).isoformat(),
            "source_card_id": str(card.id),
            "batch_id": payload["batch_id"],
        }
    }
    for part in parts:
        capture_card(
            db,
            user,
            text=part["body"],
            title=part["title"],
            extra_payload=stamp,
        )

    # It arrives as a title-only heading card because that is what it is for;
    # one menu click turns it back into an ordinary note. Ignore any legacy
    # body a model supplied so this label can never duplicate the split.
    if hero:
        capture_card(
            db,
            user,
            text=None,
            title=hero["title"],
            extra_payload={
                "generated_by": {**stamp["generated_by"], "hero": True},
                "display": "heading",
            },
        )


def handle_compose(db: DbSession, payload: dict) -> None:
    """Create a document from a user-selected set of cards and place it."""
    user = db.get(User, uuid.UUID(payload["user_id"]))
    canvas = db.get(Canvas, uuid.UUID(payload["canvas_id"]))
    if user is None or canvas is None:
        return

    requested = [uuid.UUID(value) for value in payload["card_ids"]]
    found = db.scalars(select(Card).where(Card.id.in_(requested))).all()
    by_id = {card.id: card for card in found}
    cards = [by_id[card_id] for card_id in requested if card_id in by_id]
    if len(cards) < 2:
        return

    links = db.scalars(
        select(Link).where(
            Link.source_card_id.in_(requested),
            Link.target_card_id.in_(requested),
        )
    ).all()
    relationships = [
        {
            "source": str(link.source_card_id),
            "target": str(link.target_card_id),
            "type": link.link_type or "related",
            "note": link.note or "",
        }
        for link in links
    ]
    config = get_ai_config(db)
    document = compose_document(cards, relationships, config)
    if document is None:
        log.info("composition %s produced no usable document", payload["batch_id"])
        return

    living = living_document_metadata(document, cards)
    card = Card(
        owner_id=user.id,
        type="document",
        title=document["title"],
        body=document["body"],
        payload={
            "generated_by": {
                "kind": "composition",
                "model": config.chat_model,
                "at": datetime.now(timezone.utc).isoformat(),
                "source_card_ids": [str(card_id) for card_id in requested],
                "batch_id": payload["batch_id"],
            },
            "living_document": living,
        },
    )
    db.add(card)
    db.flush()
    db.add(
        Placement(
            card_id=card.id,
            canvas_id=canvas.id,
            x=float(payload["x"]),
            y=float(payload["y"]),
            w=420,
            h=260,
        )
    )
    db.flush()
    enqueue_embed_if_needed(db, card)


def _iso(value: datetime) -> str:
    return value.isoformat()


def living_document_metadata(document: dict, cards: list[Card]) -> dict:
    """The provenance kept outside Markdown so editing stays syntax-free."""
    by_id = {str(card.id): card for card in cards}
    all_ids = list(by_id)
    raw_blocks = document.get("blocks") or [
        {"id": f"block-{index}", "markdown": markdown, "source_card_ids": all_ids}
        for index, markdown in enumerate(markdown_blocks(document["body"]), start=1)
    ]
    blocks = []
    for index, block in enumerate(raw_blocks, start=1):
        source_ids = [
            card_id for card_id in block.get("source_card_ids", []) if card_id in by_id
        ] or all_ids
        blocks.append(
            {
                "id": block.get("id") or f"block-{index}",
                "generated_markdown": block["markdown"],
                "source_card_ids": source_ids,
                "source_versions": {
                    card_id: _iso(by_id[card_id].updated_at) for card_id in source_ids
                },
            }
        )
    return {
        "version": 1,
        "generated_title": document.get("title"),
        "sources": [
            {
                "card_id": str(card.id),
                "title": card.title,
                "updated_at": _iso(card.updated_at),
            }
            for card in cards
        ],
        "blocks": blocks,
    }


def _normal_block(markdown: str) -> str:
    return " ".join(markdown.replace("\r\n", "\n").split())


def _outline(body: str) -> list[str]:
    return [
        line.lstrip("#").strip()
        for line in body.splitlines()
        if line.startswith("##") and line.lstrip("#").strip()
    ]


def merge_refreshed_document(
    current_title: str | None,
    current_body: str,
    living: dict,
    document: dict,
    cards: list[Card],
) -> dict:
    """Three-way merge at block granularity.

    The stored generated block is the base, the current Markdown is the local
    version, and the model's new block is the incoming version. Only a local
    block identical to its base is safe to replace.
    """
    fresh = living_document_metadata(document, cards)
    old_blocks = living.get("blocks") or []
    current_markdown = markdown_blocks(current_body)
    new_markdown = markdown_blocks(document["body"])
    new_blocks = fresh["blocks"]
    merged_markdown: list[str] = []
    merged_blocks: list[dict] = []
    refreshed = 0
    preserved = 0

    for index, current in enumerate(current_markdown):
        old = old_blocks[index] if index < len(old_blocks) else None
        new = new_blocks[index] if index < len(new_blocks) else None
        unchanged = bool(
            old and _normal_block(current) == _normal_block(old.get("generated_markdown", ""))
        )
        if unchanged and new and index < len(new_markdown):
            merged_markdown.append(new_markdown[index])
            merged_blocks.append(new)
            refreshed += 1
        else:
            merged_markdown.append(current)
            if old:
                merged_blocks.append(old)
            elif new:
                # A document created by the first composition release knows
                # its source cards but has no per-block base. Treat its
                # current prose as the protected baseline and borrow only the
                # new attribution, so adding provenance cannot rewrite it.
                merged_blocks.append({**new, "generated_markdown": current})
            else:
                merged_blocks.append(
                    {
                        "id": f"manual-{index + 1}",
                        "generated_markdown": "",
                        "source_card_ids": [str(source.id) for source in cards],
                        "source_versions": {
                            str(source.id): _iso(source.updated_at) for source in cards
                        },
                    }
                )
            preserved += 1

    if preserved == 0 and len(new_markdown) > len(current_markdown):
        merged_markdown.extend(new_markdown[len(current_markdown) :])
        merged_blocks.extend(new_blocks[len(current_markdown) :])
        refreshed += len(new_markdown) - len(current_markdown)

    old_generated_title = living.get("generated_title")
    title_untouched = current_title == old_generated_title
    return {
        "title": document.get("title") if title_untouched else current_title,
        "body": "\n\n".join(merged_markdown),
        "living_document": {
            **fresh,
            "generated_title": (
                document.get("title") if title_untouched else old_generated_title
            ),
            "blocks": merged_blocks,
            "last_refresh": {
                "at": datetime.now(timezone.utc).isoformat(),
                "refreshed_blocks": refreshed,
                "preserved_blocks": preserved,
            },
        },
    }


def handle_refresh_compose(db: DbSession, payload: dict) -> None:
    """Refresh generated blocks, leaving every manually changed block intact."""
    card = db.get(Card, uuid.UUID(payload["card_id"]))
    user = db.get(User, uuid.UUID(payload["user_id"]))
    if card is None or user is None or card.type != "document":
        return
    living = card.payload.get("living_document") or {}
    generated = card.payload.get("generated_by") or {}
    source_ids = [
        uuid.UUID(value)
        for value in (
            [source.get("card_id") for source in living.get("sources", [])]
            or generated.get("source_card_ids", [])
        )
        if value
    ]
    found = db.scalars(select(Card).where(Card.id.in_(source_ids))).all()
    by_id = {source.id: source for source in found}
    cards = [by_id[source_id] for source_id in source_ids if source_id in by_id]
    if len(cards) < 2:
        return

    links = db.scalars(
        select(Link).where(
            Link.source_card_id.in_(source_ids), Link.target_card_id.in_(source_ids)
        )
    ).all()
    relationships = [
        {
            "source": str(link.source_card_id),
            "target": str(link.target_card_id),
            "type": link.link_type or "related",
            "note": link.note or "",
        }
        for link in links
    ]
    config = get_ai_config(db)
    document = compose_document(cards, relationships, config, outline=_outline(card.body or ""))
    if document is None:
        log.info("refresh %s produced no usable document", payload["batch_id"])
        return

    merged = merge_refreshed_document(
        card.title, card.body or "", living, document, cards
    )
    merged["living_document"]["last_refresh"]["batch_id"] = payload["batch_id"]
    card.title = merged["title"]
    card.body = merged["body"]
    card.payload = {
        **card.payload,
        "living_document": merged["living_document"],
    }
    card.updated_at = datetime.now(timezone.utc)
    enqueue_embed_if_needed(db, card)


HANDLERS = {
    "unfurl": handle_unfurl,
    "transcribe": handle_transcribe,
    "embed": handle_embed,
    "split": handle_split,
    "compose": handle_compose,
    "refresh_compose": handle_refresh_compose,
}


# --- the loop -------------------------------------------------------------


def run_one(kinds: list[str]) -> bool:
    """Claim and run a single job. Returns False when the queue is empty."""
    db = SessionLocal()
    try:
        job = db.scalar(
            select(Job)
            .where(
                Job.status == "queued",
                Job.run_at <= text("now()"),
                Job.kind.in_(kinds),
            )
            .order_by(Job.run_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        if job is None:
            db.rollback()
            return False
        job.status = "running"
        job.attempts += 1
        job.updated_at = datetime.now(timezone.utc)
        db.commit()

        try:
            HANDLERS[job.kind](db, job.payload)
            job.status = "done"
        except Exception as exc:
            log.warning("job %s (%s) failed: %s", job.id, job.kind, exc)
            db.rollback()
            if job.attempts >= MAX_ATTEMPTS:
                job.status = "error"
            else:
                job.status = "queued"
                job.run_at = datetime.now(timezone.utc) + RETRY_DELAY * job.attempts
            job.last_error = str(exc)[:2000]
            db.add(job)
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
        return True
    finally:
        db.close()


def worker_loop(stop: threading.Event, poll_seconds: float = 2.0) -> None:
    announced: list[str] = []
    while not stop.is_set():
        try:
            # Re-read each pass: settings changed in the app should take
            # effect without restarting the worker.
            kinds = supported_kinds()
            if kinds != announced:
                log.info("worker handling: %s", ", ".join(kinds))
                announced = kinds
            if run_one(kinds):
                continue  # drain the queue before sleeping
        except Exception:
            log.exception("worker iteration failed")
        stop.wait(poll_seconds)


def start_inline_worker() -> threading.Event:
    stop = threading.Event()
    thread = threading.Thread(target=worker_loop, args=(stop,), daemon=True)
    thread.start()
    return stop
