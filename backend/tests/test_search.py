from app.embeddings import embeddable_text
from app.models import Card
from tests.conftest import requires_db

pytestmark = requires_db


def make(client, title, body="", canvas_id=None, x=0):
    payload = {"title": title, "body": body}
    if canvas_id:
        payload.update({"canvas_id": canvas_id, "x": x, "y": 0})
    return client.post("/api/cards", json=payload).json()["card"]


def test_full_text_search_works_without_embeddings(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Garage"}).json()
    make(client, "Truck transmission", "the gearbox is slipping", canvas["id"])
    make(client, "Grocery list", "milk and bread")

    data = client.get("/api/search?q=gearbox").json()
    assert "text" in data["modes_available"]
    assert len(data["hits"]) == 1
    hit = data["hits"][0]
    assert hit["card"]["title"] == "Truck transmission"
    assert hit["source"] == "text"
    # Hits carry their placements so the UI can jump to them.
    assert hit["placements"][0]["canvas_name"] == "Garage"


def test_search_covers_transcripts_and_unfurl_descriptions(client, admin):
    card = client.post("/api/cards", json={"type": "audio", "title": "memo"}).json()["card"]
    client.patch(
        f"/api/cards/{card['id']}",
        json={"payload": {"transcript": "remember to renew the passport"}},
    )
    hits = client.get("/api/search?q=passport").json()["hits"]
    assert [h["card"]["id"] for h in hits] == [card["id"]]

    link = client.post(
        "/api/cards", json={"type": "link", "payload": {"url": "https://example.com"}}
    ).json()["card"]
    client.patch(
        f"/api/cards/{link['id']}",
        json={
            "payload": {
                "url": "https://example.com",
                "unfurl": {"description": "a treatise on sourdough"},
            }
        },
    )
    hits = client.get("/api/search?q=sourdough").json()["hits"]
    assert [h["card"]["id"] for h in hits] == [link["id"]]


def test_a_links_note_is_findable(client, admin):
    """The note is the one place a board records *why* two cards belong
    together, and it lived outside search_text entirely."""
    a = make(client, "Q3 forecast", "assumes 8% churn")
    b = make(client, "Retention report", "measured 14% churn")
    client.post(
        "/api/links",
        json={
            "source_card_id": a["id"],
            "target_card_id": b["id"],
            "link_type": "contradicts",
            "note": "the forecast assumes retention the report disproves",
        },
    )

    data = client.get("/api/search?q=disproves").json()
    # Nothing in either card says "disproves" — only the link does.
    assert data["hits"] == []
    (hit,) = data["link_hits"]
    assert hit["link"]["link_type"] == "contradicts"
    assert hit["source"]["title"] == "Q3 forecast"
    assert hit["target"]["title"] == "Retention report"


def test_a_link_hit_carries_both_ends(client, admin):
    """A note on its own says nothing: "because it assumes retention" is only
    meaningful once you can see what it joins."""
    a = make(client, "One", "")
    b = make(client, "Two", "")
    client.post(
        "/api/links",
        json={"source_card_id": a["id"], "target_card_id": b["id"], "note": "aubergines"},
    )
    (hit,) = client.get("/api/search?q=aubergines").json()["link_hits"]
    assert {hit["source"]["title"], hit["target"]["title"]} == {"One", "Two"}


def test_link_hits_say_where_their_ends_can_be_reached(client, admin):
    """A note lives on the link, not on either card, so neither end need turn
    up in the card hits — without placements a link result is unfollowable."""
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    a = make(client, "One", "", canvas_id=canvas["id"])
    b = make(client, "Two", "", canvas_id=canvas["id"], x=300)
    loose = make(client, "Unplaced", "")
    client.post(
        "/api/links",
        json={"source_card_id": a["id"], "target_card_id": b["id"], "note": "damsons"},
    )
    client.post(
        "/api/links",
        json={"source_card_id": loose["id"], "target_card_id": a["id"], "note": "damsons"},
    )

    hits = client.get("/api/search?q=damsons").json()["link_hits"]
    by_source = {h["source"]["title"]: h for h in hits}

    placed = by_source["One"]
    assert [p["canvas_id"] for p in placed["source_placements"]] == [canvas["id"]]
    assert [p["canvas_name"] for p in placed["source_placements"]] == ["Board"]
    assert [p["canvas_id"] for p in placed["target_placements"]] == [canvas["id"]]

    # A card on no canvas reports none, which is what tells the UI to send you
    # to the inbox rather than to a canvas.
    assert by_source["Unplaced"]["source_placements"] == []
    assert [p["canvas_id"] for p in by_source["Unplaced"]["target_placements"]] == [
        canvas["id"]
    ]


def test_link_notes_are_visibility_scoped(client, admin, second_client):
    a = make(client, "Mine", "")
    b = make(client, "Also mine", "")
    client.post(
        "/api/links",
        json={"source_card_id": a["id"], "target_card_id": b["id"], "note": "quinces"},
    )
    assert second_client.get("/api/search?q=quinces").json()["link_hits"] == []


def test_a_link_without_a_note_never_matches(client, admin):
    """An empty note coalesces to '', which must not match everything."""
    a = make(client, "One", "")
    b = make(client, "Two", "")
    client.post(
        "/api/links",
        json={"source_card_id": a["id"], "target_card_id": b["id"]},
    )
    assert client.get("/api/search?q=anything").json()["link_hits"] == []


def test_search_is_visibility_scoped(client, admin, second_client):
    make(client, "Private matter", "confidential contents")
    assert second_client.get("/api/search?q=confidential").json()["hits"] == []


def test_semantic_search_hidden_when_unconfigured(client, admin):
    status = client.get("/api/search/status").json()
    assert status["embeddings_configured"] is False
    assert status["modes"] == ["text"]

    resp = client.get("/api/search?q=anything&mode=semantic")
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "semantic_unavailable"


def _configure_embeddings(client):
    """Point the instance at an endpoint so semantic mode is offered. Nothing
    ever calls it — the tests below supply the vectors themselves."""
    resp = client.put(
        "/api/ai/settings",
        json={
            "embedding_base_url": "http://embeddings.invalid/v1",
            "embedding_model": "test-model",
        },
    )
    assert resp.status_code == 200, resp.text


def _set_embedding(card_id, vector):
    """Write a vector straight onto a card, standing in for the worker."""
    from sqlalchemy import text as sql

    from app.db import engine

    literal = "[" + ",".join(str(float(v)) for v in vector) + "]"
    with engine.begin() as conn:
        conn.execute(
            sql("update cards set embedding = :vec ::vector where id = :id"),
            {"vec": literal, "id": card_id},
        )


def _unit(index, dim=768):
    vector = [0.0] * dim
    vector[index] = 1.0
    return vector


def test_semantic_search_ignores_cards_that_are_not_close(client, admin, monkeypatch):
    """The reported bug: with no relevance floor a nearest-neighbour scan
    answers *every* query, so gibberish lit up whichever card happened to be
    nearest. It showed up most on an instance where only one card had ever
    been embedded — that card came back for everything."""
    from app.routers import search as search_router

    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    card = make(client, "Smart Features", canvas_id=canvas["id"])
    _configure_embeddings(client)
    _set_embedding(card["id"], _unit(0))

    assert "semantic" in client.get("/api/search/status").json()["modes"]

    # A query pointing the same way as the card: distance 0, a real match.
    monkeypatch.setattr(search_router, "embed_text", lambda q: _unit(0))
    hits = client.get("/api/search?q=zzz+gibberish+zzz&mode=semantic").json()["hits"]
    assert [h["card"]["title"] for h in hits] == ["Smart Features"]

    # A query pointing somewhere else entirely: distance 1, and the only
    # embedded card in the database must still not come back.
    monkeypatch.setattr(search_router, "embed_text", lambda q: _unit(1))
    data = client.get("/api/search?q=zzz+gibberish+zzz&mode=semantic").json()
    assert data["hits"] == []

    # And in the mode the UI actually defaults to, where a text pass runs too
    # and finds nothing either.
    data = client.get("/api/search?q=zzz+gibberish+zzz&mode=auto").json()
    assert data["hits"] == []
    assert data["link_hits"] == []


def test_semantic_floor_leaves_full_text_alone(client, admin, monkeypatch):
    """The floor drops a distant neighbour without touching the card whose
    words actually match — including when that card's own vector is nowhere
    near the query, which is the case the dedupe would otherwise mask."""
    from app.routers import search as search_router

    wanted = make(client, "Truck transmission", body="fixing the gearbox")
    bystander = make(client, "Grocery list", body="milk and eggs")
    _configure_embeddings(client)
    # Both vectors point away from the query, so nothing should arrive by the
    # semantic route at all.
    _set_embedding(wanted["id"], _unit(1))
    _set_embedding(bystander["id"], _unit(2))
    monkeypatch.setattr(search_router, "embed_text", lambda q: _unit(0))

    hits = client.get("/api/search?q=transmission&mode=auto").json()["hits"]
    assert [(h["card"]["title"], h["source"]) for h in hits] == [
        ("Truck transmission", "text")
    ]


def test_suggestions_empty_without_embeddings(client, admin):
    card = make(client, "A card")
    assert client.get(f"/api/cards/{card['id']}/suggestions").json() == []
    assert client.get(f"/api/cards/{card['id']}/canvas-suggestions").json() == []


def test_suggestions_stay_quiet_when_nothing_is_close(client, admin):
    """The panel says "might be related" and has to be allowed to say nothing.
    Ranking without a floor filled it every time, offering cards against a
    card that had nothing to do with any of them."""
    root = make(client, "Chocolate bar challenge", "identify every chocolate bar")
    near = make(client, "Chocolate tasting", "a very similar sort of thing")
    far = make(client, "Doorbell camera", "wire-free installation and 4MP video")
    _configure_embeddings(client)

    # `near` is tilted off `root` by a known cosine distance. `far` is put on
    # an axis of its own, so it is orthogonal to — and therefore a full 1.0
    # from — both of the others rather than merely far from `root`.
    import math

    def tilted(d):
        theta = math.acos(1.0 - d)
        return [math.cos(theta), math.sin(theta), 0.0] + [0.0] * 765

    _set_embedding(root["id"], tilted(0.0))
    _set_embedding(near["id"], tilted(0.25))
    _set_embedding(far["id"], [0.0, 0.0, 1.0] + [0.0] * 765)

    titles = [
        s["card"]["title"]
        for s in client.get(f"/api/cards/{root['id']}/suggestions").json()
    ]
    assert titles == ["Chocolate tasting"]

    # And a card whose neighbours are all beyond the floor gets an empty
    # panel rather than a list of strangers.
    assert client.get(f"/api/cards/{far['id']}/suggestions").json() == []


def test_coverage_counts_only_cards_there_is_anything_to_embed(client, admin):
    """A card with no text is not a gap waiting to be filled: counting it
    would hold the number below the total for ever and read as stuck."""
    with_text = make(client, "Has words", "and a body")
    make(client, "Also words", "")
    client.post("/api/cards", json={"type": "image", "title": None, "body": None})

    coverage = client.get("/api/search/coverage").json()
    assert coverage["cards"] == 3
    assert coverage["embeddable"] == 2
    assert coverage["embedded"] == 0

    _set_embedding(with_text["id"], _unit(0))
    coverage = client.get("/api/search/coverage").json()
    assert coverage["embedded"] == 1
    assert coverage["embeddable"] == 2


def test_coverage_is_your_own_cards_only(client, admin, second_client):
    make(client, "Mine", "words")
    assert second_client.get("/api/search/coverage").json() == {
        "embedded": 0,
        "embeddable": 0,
        "cards": 0,
    }


def test_reindex_refused_without_endpoint(client, admin):
    resp = client.post("/api/search/reindex")
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "embeddings_unavailable"


def test_link_candidates_exclude_self_and_linked(client, admin):
    a = make(client, "Alpha")
    b = make(client, "Beta")
    make(client, "Gamma")

    client.post(
        "/api/links", json={"source_card_id": a["id"], "target_card_id": b["id"]}
    )
    candidates = client.get(f"/api/cards/{a['id']}/link-candidates").json()
    titles = {c["title"] for c in candidates}
    assert titles == {"Gamma"}


def test_embeddable_text_assembles_all_sources():
    card = Card(
        title="Title",
        body="Body",
        payload={
            "unfurl": {"description": "Description"},
            "transcript": "Transcript",
        },
    )
    text = embeddable_text(card)
    for part in ("Title", "Body", "Description", "Transcript"):
        assert part in text

    assert embeddable_text(Card(title=None, body=None, payload={})) == ""
