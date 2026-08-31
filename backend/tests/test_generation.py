"""Splitting a card into inbox cards.

The model itself is stubbed: what matters here is that its output lands
unplaced, stamped, discardable as a batch, and out of the suggestion engine
until a human places it.
"""
import uuid

from app import jobs, runtime_settings
from tests.conftest import requires_db

pytestmark = requires_db

LONG_TEXT = (
    "Bought seedlings on Saturday: four tomato, two basil, one rosemary. "
    "The rosemary needs a terracotta pot because it hates having wet roots. "
    "Separately, the back fence panel is rotting at the base and should be "
    "replaced before winter comes around again this year."
)

STUB_CARDS = [
    {"title": "Seedlings", "body": "four tomato, two basil, one rosemary"},
    {"title": None, "body": "the back fence panel is rotting at the base"},
]


def configure_generation(client, **overrides):
    body = {"chat_base_url": "http://localhost:11434/v1", "chat_model": "qwen3:4b"}
    body.update(overrides)
    resp = client.put("/api/ai/settings", json=body)
    assert resp.status_code == 200, resp.text
    runtime_settings.invalidate_cache()
    return resp.json()


def canvas_with_card(client, body=LONG_TEXT):
    """A source card that sits on a canvas, so the inbox stays empty until a
    split puts something in it."""
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    card = client.post(
        "/api/cards", json={"body": body, "canvas_id": canvas["id"], "x": 0, "y": 0}
    ).json()["card"]
    return canvas, card


def placed_card(client, body=LONG_TEXT):
    return canvas_with_card(client, body)[1]


def read_card(client, canvas_id, card_id):
    """There is no GET /api/cards/{id}: a card is read through a canvas it
    sits on."""
    detail = client.get(f"/api/canvases/{canvas_id}").json()
    return next(p["card"] for p in detail["placements"] if p["card"]["id"] == card_id)


def run_split(client, monkeypatch, card, cards=None, limit=3, hero=None):
    resp = client.post(f"/api/cards/{card['id']}/split?limit={limit}")
    assert resp.status_code == 202, resp.text
    result = {"hero": hero, "cards": STUB_CARDS if cards is None else cards}
    monkeypatch.setattr(jobs, "split_text", lambda *a, **k: result)
    assert jobs.run_one(["split"]) is True
    return resp.json()["batch_id"]


# --- gating ---------------------------------------------------------------


def test_split_refused_without_an_endpoint(client, admin):
    card = placed_card(client)
    resp = client.post(f"/api/cards/{card['id']}/split")
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "generation_unavailable"


def test_worker_only_claims_split_when_generation_is_configured(client, admin):
    runtime_settings.invalidate_cache()
    assert "split" not in jobs.supported_kinds()
    configure_generation(client)
    assert "split" in jobs.supported_kinds()


def test_short_cards_are_not_worth_splitting(client, admin):
    configure_generation(client)
    card = placed_card(client, body="too short to bother with")
    resp = client.post(f"/api/cards/{card['id']}/split")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "too_short"


def test_status_reports_the_configured_endpoint(client, admin):
    configure_generation(client)
    data = client.get("/api/ai/status").json()
    assert data["generation"]["configured"] is True
    assert data["generation"]["model"] == "qwen3:4b"
    assert data["generation"]["api_key_set"] is False
    assert client.get("/api/search/status").json()["generation_configured"] is True


# --- the split itself -----------------------------------------------------


def test_split_lands_unplaced_in_the_inbox(client, admin, monkeypatch):
    configure_generation(client)
    card = placed_card(client)
    assert client.get("/api/inbox").json()["items"] == []

    batch_id = run_split(client, monkeypatch, card)

    items = client.get("/api/inbox").json()["items"]
    assert sorted(str(i["title"]) for i in items) == ["None", "Seedlings"]
    for item in items:
        stamp = item["payload"]["generated_by"]
        assert stamp["batch_id"] == batch_id
        assert stamp["source_card_id"] == card["id"]
        assert stamp["model"] == "qwen3:4b"


def test_the_source_card_is_never_modified(client, admin, monkeypatch):
    configure_generation(client)
    canvas, card = canvas_with_card(client)
    run_split(client, monkeypatch, card)
    after = read_card(client, canvas["id"], card["id"])
    assert after["body"] == LONG_TEXT
    assert after["payload"] == card["payload"]
    assert after["updated_at"] == card["updated_at"]


def test_a_model_returning_nothing_is_a_finished_job_not_a_failure(
    client, admin, monkeypatch
):
    configure_generation(client)
    card = placed_card(client)
    batch_id = run_split(client, monkeypatch, card, cards=[])

    assert client.get("/api/inbox").json()["items"] == []
    status = client.get(f"/api/inbox/batches/{batch_id}").json()
    assert status["status"] == "done"
    assert status["cards"] == []


def test_split_is_allowed_on_a_card_you_can_only_view(
    client, admin, second_client, monkeypatch
):
    """The output is yours and the source is untouched, so being able to read
    it is enough — the same right that already lets you link to it."""
    configure_generation(client)
    canvas = client.post("/api/canvases", json={"name": "Shared"}).json()
    card = client.post(
        "/api/cards", json={"body": LONG_TEXT, "canvas_id": canvas["id"], "x": 0, "y": 0}
    ).json()["card"]
    client.post(
        f"/api/canvases/{canvas['id']}/members",
        json={"email": "second@example.com", "role": "viewer"},
    )

    resp = second_client.post(f"/api/cards/{card['id']}/split")
    assert resp.status_code == 202
    monkeypatch.setattr(
        jobs, "split_text", lambda *a, **k: {"hero": None, "cards": STUB_CARDS}
    )
    assert jobs.run_one(["split"]) is True

    # The cards belong to the viewer who asked, not to the card's owner.
    assert len(second_client.get("/api/inbox").json()["items"]) == 2
    assert client.get("/api/inbox").json()["items"] == []


def test_a_hero_arrives_as_a_heading_card_above_its_siblings(
    client, admin, monkeypatch
):
    """The card the others get arranged around. It is created last so the
    inbox, which is newest first, lists it above them."""
    configure_generation(client)
    card = placed_card(client)
    run_split(
        client,
        monkeypatch,
        card,
        hero={"title": "YouTube Thumbnail Previews", "body": "How previews are chosen."},
    )

    items = client.get("/api/inbox").json()["items"]
    assert len(items) == 3
    # Order is not asserted: a batch is written in one transaction, so every
    # card shares a created_at and the inbox falls back to a random uuid. The
    # panel is what puts the hero first.
    heroes = [i for i in items if i["payload"]["generated_by"].get("hero")]
    assert len(heroes) == 1
    assert heroes[0]["title"] == "YouTube Thumbnail Previews"
    assert heroes[0]["body"] is None
    assert heroes[0]["payload"]["display"] == "heading"
    for other in items:
        if other is heroes[0]:
            continue
        assert "display" not in other["payload"]


def test_no_links_are_made_between_generated_cards(client, admin, monkeypatch):
    """Arranging and connecting is the half of the job the split leaves to a
    person. A link here is a claim nobody made."""
    configure_generation(client)
    card = placed_card(client)
    run_split(client, monkeypatch, card, hero={"title": "Hero", "body": "Summary."})

    for item in client.get("/api/inbox").json()["items"]:
        reveal = client.get(f"/api/cards/{item['id']}/reveal").json()
        assert reveal["links"] == []


def test_a_hero_alone_is_still_worth_writing(client, admin, monkeypatch):
    configure_generation(client)
    card = placed_card(client)
    run_split(client, monkeypatch, card, cards=[], hero={"title": "Only", "body": "One."})
    items = client.get("/api/inbox").json()["items"]
    assert [i["title"] for i in items] == ["Only"]


# --- batches --------------------------------------------------------------


def test_batch_status_is_scoped_to_the_person_who_asked(
    client, admin, second_client, monkeypatch
):
    configure_generation(client)
    card = placed_card(client)
    batch_id = run_split(client, monkeypatch, card)

    assert client.get(f"/api/inbox/batches/{batch_id}").status_code == 200
    assert second_client.get(f"/api/inbox/batches/{batch_id}").status_code == 404
    assert client.get(f"/api/inbox/batches/{uuid.uuid4()}").status_code == 404


def test_discarding_a_batch_removes_the_whole_thing(client, admin, monkeypatch):
    configure_generation(client)
    card = placed_card(client)
    batch_id = run_split(client, monkeypatch, card)

    resp = client.delete(f"/api/inbox/batches/{batch_id}")
    assert resp.status_code == 200
    assert resp.json()["discarded"] == 2
    assert client.get("/api/inbox").json()["items"] == []


def test_discarding_a_batch_keeps_what_you_already_placed(client, admin, monkeypatch):
    """Placing a card is how you keep it, so a late discard can never take
    back something already committed to."""
    configure_generation(client)
    card = placed_card(client)
    batch_id = run_split(client, monkeypatch, card)

    canvas = client.post("/api/canvases", json={"name": "Keep"}).json()
    kept = client.get("/api/inbox").json()["items"][0]
    client.post(
        f"/api/canvases/{canvas['id']}/placements",
        json={"card_id": kept["id"], "x": 10, "y": 10},
    )

    assert client.delete(f"/api/inbox/batches/{batch_id}").json()["discarded"] == 1
    assert client.get("/api/inbox").json()["items"] == []
    # Still reachable: a deleted card would 404 out of this endpoint.
    surviving = client.get(f"/api/cards/{kept['id']}/placements")
    assert surviving.status_code == 200
    assert len(surviving.json()) == 1


# --- keeping the model out of its own input -------------------------------


def _give_embedding(seed: float, card_id: str) -> None:
    """Write a vector straight in: the point here is the exclusion rule, not
    the embedding endpoint."""
    from sqlalchemy import bindparam, text

    from app.db import engine

    vector = "[" + ",".join([str(seed)] * 768) + "]"
    with engine.begin() as conn:
        conn.execute(
            text("update cards set embedding = :vec ::vector where id = :id").bindparams(
                bindparam("vec", vector), bindparam("id", uuid.UUID(card_id))
            )
        )


def test_unplaced_generated_cards_stay_out_of_suggestions(client, admin, monkeypatch):
    configure_generation(
        client, embedding_base_url="http://localhost:11434/v1", embedding_model="nomic"
    )
    card = placed_card(client)
    run_split(client, monkeypatch, card)

    _give_embedding(0.1, card["id"])
    generated = client.get("/api/inbox").json()["items"]
    for item in generated:
        _give_embedding(0.1, item["id"])

    assert client.get(f"/api/cards/{card['id']}/suggestions").json() == []

    # Placing one is the endorsement that lets it back in.
    canvas = client.post("/api/canvases", json={"name": "Keep"}).json()
    client.post(
        f"/api/canvases/{canvas['id']}/placements",
        json={"card_id": generated[0]["id"], "x": 5, "y": 5},
    )
    suggested = client.get(f"/api/cards/{card['id']}/suggestions").json()
    assert [s["card"]["id"] for s in suggested] == [generated[0]["id"]]
