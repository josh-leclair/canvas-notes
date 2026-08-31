import uuid
from dataclasses import replace

from fastapi import APIRouter, Depends, Query
from sqlalchemy import bindparam, exists, or_, select, text
from sqlalchemy.orm import Session as DbSession, aliased

from app.access import (
    get_visible_card,
    visible_canvas_condition,
    visible_card_condition,
    visible_link_condition,
)
from app.auth import get_current_user, require_admin
from app.db import get_db
from app.embeddings import embed_raw, embed_text, embeddable_text
from app.errors import ApiError
from app.generate import TEST_SAMPLE, split_text
from app.models import Canvas, Card, Link, Placement, User
from app.routers.links import _linked_card_ids
from app.runtime_settings import env_seeded_fields, get_ai_config, save_ai_config
from app.schemas.api import (
    AiSettingsIn,
    AiTestIn,
    CanvasSuggestionOut,
    CardOut,
    CardPlacementInfo,
    GenerationTestIn,
    LinkHit,
    LinkOut,
    SearchHit,
    SearchOut,
    SuggestionOut,
)

router = APIRouter(prefix="/api")

# How far apart two things may sit before they stop being about the same
# thing.
#
# Every use of the embeddings here is a nearest-neighbour scan, and a scan
# always returns its `limit` however far away the nearest thing is. Without a
# floor that means search matches gibberish, and the suggestion panel offers
# five cards to a card that is related to none of them. Both were reported,
# and both are the same missing check.
#
# Cosine distance, so 0 is identical and 1 is unrelated. The number is
# model-dependent and cannot not be: models with a high similarity baseline
# (the bge family, nomic-embed-text) put unrelated text in the 0.4-0.7 range,
# while wide-range models put it past 0.9.
#
# Measured against a real library on bge-m3, which is what this is set for.
# Pairs that a person agrees are related land at 0.22-0.29 — "Features" and
# "Smart Features" at 0.221, "Selection Criteria and Timing" and "Eligibility
# Requirements" at 0.260, which share no words at all and are exactly what
# this is for. The corpus as a whole has a median of 0.606 and a 10th
# percentile of 0.474. So real matches and noise are separated by a clear gap
# between roughly 0.30 and 0.47, and this sits in it.
#
# One number for both uses, which is only defensible because the model is a
# symmetric one: bge-m3 encodes a query and a document into the same space,
# so query-to-card and card-to-card distances mean the same thing. Adopting a
# model that wants different treatment for queries and documents would mean
# splitting this in two.
#
# Erring strict is the safer direction. Full-text hits do not pass through
# here at all, so a cut that is slightly too tight costs some fuzzy matches
# while every exact match still lands.
MAX_SEMANTIC_DISTANCE = 0.40


def _has_embeddings(db: DbSession) -> bool:
    """Semantic search needs both a configured endpoint and rows to compare."""
    if not get_ai_config(db).embeddings_configured:
        return False
    return db.scalar(text("select exists (select 1 from cards where embedding is not null)"))


def modes_available(db: DbSession) -> list[str]:
    modes = ["text"]
    if _has_embeddings(db):
        modes.append("semantic")
    return modes


def _endorsed_only() -> object:
    """Generated cards that nobody has placed yet stay out of suggestions.

    A model's own unreviewed output must not become the input that shapes the
    next suggestion, or the corpus slowly fills with text no one chose.
    Placing a card is the endorsement that lets it back in.
    """
    return or_(
        Card.payload["generated_by"].is_(None),
        exists(select(1).where(Placement.card_id == Card.id)),
    )


def _placements_for(
    db: DbSession, user: User, card_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[CardPlacementInfo]]:
    if not card_ids:
        return {}
    rows = db.execute(
        select(Placement, Canvas.name)
        .join(Canvas, Canvas.id == Placement.canvas_id)
        .where(Placement.card_id.in_(card_ids), visible_canvas_condition(user.id))
    ).all()
    out: dict[uuid.UUID, list[CardPlacementInfo]] = {}
    for placement, canvas_name in rows:
        out.setdefault(placement.card_id, []).append(
            CardPlacementInfo(
                id=placement.id,
                canvas_id=placement.canvas_id,
                canvas_name=canvas_name,
                x=placement.x,
                y=placement.y,
            )
        )
    return out


@router.get("/search", response_model=SearchOut)
def search(
    q: str = Query(min_length=1, max_length=500),
    mode: str = Query(default="auto", pattern="^(auto|text|semantic)$"),
    limit: int = Query(default=30, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    available = modes_available(db)
    if mode == "semantic" and "semantic" not in available:
        raise ApiError(409, "semantic_unavailable", "Semantic search is not configured")

    hits: list[SearchHit] = []
    seen: set[uuid.UUID] = set()

    # Full text is the floor and works on every instance.
    if mode in ("auto", "text"):
        rows = db.execute(
            select(
                Card,
                text("ts_rank(to_tsvector('english', search_text), plainto_tsquery('english', :q)) as rank"),
            )
            .where(
                visible_card_condition(user.id),
                text(
                    "to_tsvector('english', search_text) @@ plainto_tsquery('english', :q)"
                ),
            )
            .order_by(text("rank desc"))
            .limit(limit)
            .params(q=q)
        ).all()
        for card, rank in rows:
            seen.add(card.id)
            hits.append(
                SearchHit(
                    card=CardOut.model_validate(card),
                    placements=[],
                    score=float(rank),
                    source="text",
                )
            )

    # Semantic finds the card about fixing a truck transmission when you
    # searched for "car repair".
    if mode in ("auto", "semantic") and "semantic" in available:
        vector = embed_text(q)
        if vector is not None:
            literal = "[" + ",".join(repr(float(v)) for v in vector) + "]"
            semantic_rows = db.execute(
                select(Card, text("embedding <=> :vec ::vector as distance"))
                .where(
                    visible_card_condition(user.id),
                    text("embedding is not null"),
                    # Filtered in SQL rather than after the fact, so `limit`
                    # counts matches instead of counting candidates and then
                    # throwing most of them away.
                    text("embedding <=> :vec ::vector < :max_distance"),
                )
                .order_by(text("distance"))
                .limit(limit)
                .params(vec=literal, max_distance=MAX_SEMANTIC_DISTANCE)
            ).all()
            for card, distance in semantic_rows:
                if card.id in seen:
                    continue
                seen.add(card.id)
                hits.append(
                    SearchHit(
                        card=CardOut.model_validate(card),
                        placements=[],
                        score=1.0 - float(distance),
                        source="semantic",
                    )
                )

    hits.sort(key=lambda h: h.score, reverse=True)
    hits = hits[:limit]
    placements = _placements_for(db, user, [h.card.id for h in hits])
    for hit in hits:
        hit.placements = placements.get(hit.card.id, [])
    return SearchOut(
        hits=hits, link_hits=_link_hits(db, user, q, limit), modes_available=available
    )


def _link_hits(db: DbSession, user: User, q: str, limit: int) -> list[LinkHit]:
    """Links whose note matches.

    The note is the one part of a board that says *why* two things belong
    together, and it lived outside `search_text` â€” a generated column on
    `cards` cannot reach another table â€” so it could be written and never
    found again. It is its own index and its own result list rather than
    being folded into the card hits, because a link is not a card and
    pretending otherwise would put the same note under both of its ends.

    There is no semantic pass here on purpose: notes are short and written in
    your own words, so the words are what you will search for.
    """
    source = aliased(Card)
    target = aliased(Card)
    rows = db.execute(
        select(
            Link,
            source,
            target,
            text(
                "ts_rank(to_tsvector('english', coalesce(links.note, '')),"
                " plainto_tsquery('english', :q)) as rank"
            ),
        )
        .outerjoin(source, Link.source_card_id == source.id)
        .outerjoin(target, Link.target_card_id == target.id)
        .where(
            visible_link_condition(user.id),
            text(
                "to_tsvector('english', coalesce(links.note, ''))"
                " @@ plainto_tsquery('english', :q)"
            ),
        )
        .order_by(text("rank desc"))
        .limit(limit)
        .params(q=q)
    ).all()
    endpoints = [c.id for _, src, tgt, _ in rows for c in (src, tgt) if c]
    placements = _placements_for(db, user, endpoints)
    return [
        LinkHit(
            link=LinkOut.model_validate(link),
            source=CardOut.model_validate(src) if src else None,
            target=CardOut.model_validate(tgt) if tgt else None,
            score=float(rank),
            source_placements=placements.get(src.id, []) if src else [],
            target_placements=placements.get(tgt.id, []) if tgt else [],
        )
        for link, src, tgt, rank in rows
    ]


@router.get("/cards/{card_id}/suggestions", response_model=list[SuggestionOut])
def link_suggestions(
    card_id: uuid.UUID,
    limit: int = Query(default=5, ge=1, le=20),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Nearest neighbours that are not already linked, and are actually near.

    This attacks the real failure mode of a spatial app, which is cards you
    forgot you had. Suggestions stay out of the graph: accepting one is what
    creates a link.

    The panel is headed "might be related", and it has to be allowed to say
    nothing. Ranking without a floor filled it every time — five cards offered
    against a video that had nothing to do with any of them — and a panel that
    is always wrong is one you stop reading, which costs more than the
    suggestions were worth.
    """
    card = get_visible_card(db, user, card_id)
    if not _has_embeddings(db):
        return []

    excluded = _linked_card_ids(db, user, card.id) | {card.id}
    rows = db.execute(
        select(Card, text("embedding <=> (select embedding from cards where id = :root) as distance"))
        .where(
            visible_card_condition(user.id),
            text("embedding is not null"),
            text("(select embedding from cards where id = :root) is not null"),
            text(
                "embedding <=> (select embedding from cards where id = :root)"
                " < :max_distance"
            ),
            Card.id.notin_(excluded),
            _endorsed_only(),
        )
        .order_by(text("distance"))
        .limit(limit)
        .params(root=card.id, max_distance=MAX_SEMANTIC_DISTANCE)
    ).all()
    return [
        SuggestionOut(card=CardOut.model_validate(c), distance=float(d)) for c, d in rows
    ]


@router.get("/cards/{card_id}/canvas-suggestions", response_model=list[CanvasSuggestionOut])
def canvas_suggestions(
    card_id: uuid.UUID,
    limit: int = Query(default=3, ge=1, le=10),
    user: User = Depends(get_current_user),
    db: DbSession = Depends(get_db),
):
    """Where does this captured card belong? Ask its nearest neighbours."""
    card = get_visible_card(db, user, card_id)
    if not _has_embeddings(db):
        return []

    rows = db.execute(
        text("""
            select c.id, c.name, avg(1 - (nb.embedding <=> root.embedding)) as score
            from cards nb
            join placements p on p.card_id = nb.id
            join canvases c on c.id = p.canvas_id
            cross join (select embedding from cards where id = :root) root
            where nb.embedding is not null
              and root.embedding is not null
              and nb.id <> :root
              and (
                c.owner_id = :uid
                or exists (
                  select 1 from canvas_members m
                  where m.canvas_id = c.id and m.user_id = :uid
                )
              )
            group by c.id, c.name
            order by score desc
            limit :lim
        """).bindparams(
            bindparam("root", card.id),
            bindparam("uid", user.id),
            bindparam("lim", limit),
        )
    ).all()
    return [
        CanvasSuggestionOut(canvas_id=cid, canvas_name=name, score=float(score))
        for cid, name, score in rows
    ]


@router.get("/search/status")
def search_status(
    user: User = Depends(get_current_user), db: DbSession = Depends(get_db)
):
    """Lets the UI hide what this instance cannot do."""
    config = get_ai_config(db)
    return {
        "modes": modes_available(db),
        "embeddings_configured": config.embeddings_configured,
        "generation_configured": config.generation_configured,
    }


def _ai_payload(db: DbSession, config) -> dict:
    from app.jobs import transcription_mode

    seeded = env_seeded_fields()
    return {
        "embeddings": {
            "configured": config.embeddings_configured,
            "base_url": config.embedding_base_url,
            "model": config.embedding_model,
            "dim": config.embedding_dim,
            # Secrets are never returned; the UI only needs to know one is set.
            "api_key_set": bool(config.embedding_api_key),
        },
        "transcription": {
            "mode": transcription_mode(config),
            "base_url": config.whisper_base_url,
            "model": config.whisper_model,
            "api_key_set": bool(config.whisper_api_key),
        },
        "generation": {
            "configured": config.generation_configured,
            "base_url": config.chat_base_url,
            "model": config.chat_model,
            "api_key_set": bool(config.chat_api_key),
        },
        "search_modes": modes_available(db),
        "env_seeded": sorted(seeded),
        "embedded_card_count": db.scalar(
            text("select count(*) from cards where embedding is not null")
        ),
    }


@router.get("/ai/status")
def ai_status(user: User = Depends(get_current_user), db: DbSession = Depends(get_db)):
    """What this instance is currently pointed at."""
    return _ai_payload(db, get_ai_config(db))


@router.put("/ai/settings")
def update_ai_settings(
    body: AiSettingsIn,
    admin: User = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    """Instance-wide, so admin only.

    Changing the embedding dimension cannot be a quiet save: the stored
    vectors are the wrong shape, so they have to be discarded and every card
    re-embedded. That needs saying out loud, hence the confirmation flag.
    """
    current = get_ai_config(db)
    updates = body.model_dump(exclude_unset=True)
    new_dim = updates.get("embedding_dim", current.embedding_dim)

    if new_dim != current.embedding_dim:
        embedded = db.scalar(
            text("select count(*) from cards where embedding is not null")
        )
        if not body.confirm_reembed:
            raise ApiError(
                409,
                "dimension_change_requires_confirmation",
                f"Changing the dimension from {current.embedding_dim} to {new_dim} "
                f"discards {embedded} stored embedding(s) and re-embeds every card.",
            )
        _resize_embedding_column(db, new_dim)

    updates.pop("confirm_reembed", None)
    config = save_ai_config(db, updates, admin.id)

    if new_dim != current.embedding_dim and config.embeddings_configured:
        _queue_reindex_for_everyone(db)

    return _ai_payload(db, config)


def _resize_embedding_column(db: DbSession, dim: int) -> None:
    """Null everything first so the type change is trivial, then rebuild the
    index. Vectors of the old dimension are meaningless at the new one."""
    db.execute(text("drop index if exists cards_embedding_idx"))
    db.execute(text("update cards set embedding = null"))
    db.execute(text(f"alter table cards alter column embedding type vector({dim})"))
    db.execute(
        text(
            "create index cards_embedding_idx on cards "
            "using hnsw (embedding vector_cosine_ops)"
        )
    )


def _queue_reindex_for_everyone(db: DbSession) -> int:
    from app.jobs import enqueue

    queued = 0
    for card in db.scalars(select(Card)):
        if embeddable_text(card):
            enqueue(db, "embed", {"card_id": str(card.id)})
            queued += 1
    return queued


@router.post("/ai/test")
def ai_test(
    body: AiTestIn | None = None,
    admin: User = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    """Round-trip the endpoint and report the dimension it actually returns.

    Run against unsaved values so an admin can check a model before
    committing to the re-embed that changing dimension implies.
    """
    config = get_ai_config(db)
    if body is not None:
        overrides = {
            k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None
        }
        config = replace(config, **overrides)
    if not config.embeddings_configured:
        raise ApiError(409, "embeddings_unavailable", "No embedding endpoint configured")
    try:
        vector = embed_raw("connection test", config)
    except Exception as exc:
        raise ApiError(502, "embedding_failed", str(exc)[:300]) from exc

    current = get_ai_config(db).embedding_dim
    return {
        "ok": True,
        "dimensions": len(vector),
        "matches_current": len(vector) == current,
        "current_dim": current,
    }


@router.post("/ai/test-generation")
def ai_test_generation(
    body: GenerationTestIn | None = None,
    admin: User = Depends(require_admin),
    db: DbSession = Depends(get_db),
):
    """Split a fixed sample and report what came back.

    Reachability is the easy half. The real question with a small local model
    is whether it returns a list of objects with no commentary wrapped around
    it, so the test exercises the same path the job does.
    """
    config = get_ai_config(db)
    if body is not None:
        overrides = {
            k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None
        }
        config = replace(config, **overrides)
    if not config.generation_configured:
        raise ApiError(409, "generation_unavailable", "No generation endpoint configured")
    try:
        cards = split_text(TEST_SAMPLE, config, limit=3)
    except Exception as exc:
        raise ApiError(502, "generation_failed", str(exc)[:300]) from exc
    return {
        "ok": bool(cards),
        "cards_returned": len(cards),
        "titles": [c["title"] or "(untitled)" for c in cards],
    }


@router.get("/search/coverage")
def embedding_coverage(
    user: User = Depends(get_current_user), db: DbSession = Depends(get_db)
):
    """How much of your own library semantic search can actually see.

    Its own endpoint rather than a field on `/search/status`, which the search
    overlay hits every time it opens: this walks the caller's cards, and that
    is a strange cost to put on opening a search box.

    Counted the way `reindex` queues, not against the total. A card with
    nothing to embed — an image with no title, an empty column — is not a gap
    waiting to be filled, and counting it would hold the number short of the
    total for ever and read as stuck.
    """
    # Named columns rather than whole rows: an embedding is hundreds of
    # floats and this needs to know only whether there is one. `embedding` is
    # not mapped on `Card` — pgvector is reached through raw SQL everywhere
    # in this file — so it is asked for the same way.
    rows = db.execute(
        select(
            Card.title,
            Card.body,
            Card.payload,
            text("embedding is not null as has_vector"),
        ).where(Card.owner_id == user.id)
    ).all()

    embeddable = 0
    embedded = 0
    for title, body, payload, has_vector in rows:
        if not embeddable_text(Card(title=title, body=body, payload=payload or {})):
            continue
        embeddable += 1
        if has_vector:
            embedded += 1

    return {"embedded": embedded, "embeddable": embeddable, "cards": len(rows)}


@router.post("/search/reindex", status_code=202)
def reindex(
    user: User = Depends(get_current_user), db: DbSession = Depends(get_db)
):
    """Backfill embeddings for the caller's existing cards."""
    if not get_ai_config(db).embeddings_configured:
        raise ApiError(409, "embeddings_unavailable", "No embedding endpoint configured")
    from app.jobs import enqueue

    cards = db.scalars(select(Card).where(Card.owner_id == user.id)).all()
    queued = 0
    for card in cards:
        if embeddable_text(card):
            enqueue(db, "embed", {"card_id": str(card.id)})
            queued += 1
    return {"queued": queued}
