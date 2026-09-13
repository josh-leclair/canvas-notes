import uuid
from datetime import datetime, timedelta, timezone

from app.db import SessionLocal
from app.models import Card
from tests.conftest import requires_db

pytestmark = requires_db


def test_new_canvas_starts_at_client_viewport_and_only_grows(client, admin):
    created = client.post(
        "/api/canvases", json={"name": "Growing", "width": 1440, "height": 900}
    )
    assert created.status_code == 201
    assert created.json()["is_infinite"] is False
    assert created.json()["width"] == 1440
    assert created.json()["height"] == 900

    grown = client.patch(
        f"/api/canvases/{created.json()['id']}/bounds",
        json={"width": 2080, "height": 1260},
    )
    assert grown.status_code == 200
    assert grown.json()["width"] == 2080
    assert grown.json()["height"] == 1260

    not_shrunk = client.patch(
        f"/api/canvases/{created.json()['id']}/bounds",
        json={"width": 1440, "height": 900},
    ).json()
    assert not_shrunk["width"] == 2080
    assert not_shrunk["height"] == 1260


def test_card_create_with_canvas_places_in_one_transaction(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    resp = client.post(
        "/api/cards",
        json={"type": "text", "body": "hi", "canvas_id": canvas["id"], "x": 10, "y": 20},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["placement"]["x"] == 10
    assert data["placement"]["w"] == 280 and data["placement"]["h"] == 180

    detail = client.get(f"/api/canvases/{canvas['id']}").json()
    assert len(detail["placements"]) == 1
    assert detail["placements"][0]["card"]["body"] == "hi"


def test_timer_card_is_persistent(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Timers"}).json()
    created = client.post(
        "/api/cards",
        json={
            "type": "timer",
            "title": "Timed work",
            "eta_minutes": 30,
            "canvas_id": canvas["id"],
            "x": 40,
            "y": 60,
        },
    )
    assert created.status_code == 201, created.text
    card = created.json()["card"]
    assert card["eta_minutes"] == 30
    assert card["timer_elapsed_seconds"] == 0
    assert created.json()["placement"]["w"] == 320
    assert created.json()["placement"]["h"] == 440

    started = client.post(
        f"/api/cards/{card['id']}/timer", json={"action": "start"}
    )
    assert started.status_code == 200, started.text
    assert started.json()["timer_started_at"] is not None

    with SessionLocal() as db:
        row = db.get(Card, uuid.UUID(card["id"]))
        row.timer_started_at = datetime.now(timezone.utc) - timedelta(seconds=75)
        db.commit()

    paused = client.post(
        f"/api/cards/{card['id']}/timer", json={"action": "pause"}
    )
    assert paused.status_code == 200, paused.text
    assert paused.json()["timer_started_at"] is None
    assert 74 <= paused.json()["timer_elapsed_seconds"] < 90

    reset = client.post(
        f"/api/cards/{card['id']}/timer", json={"action": "reset"}
    )
    assert reset.status_code == 200, reset.text
    assert reset.json()["timer_elapsed_seconds"] == 0

    ordinary = client.post(
        "/api/cards", json={"title": "Just an estimate"}
    ).json()["card"]
    rejected = client.post(
        f"/api/cards/{ordinary['id']}/timer", json={"action": "start"}
    )
    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "timer_card_required"


def test_card_create_requires_position_with_canvas(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    resp = client.post("/api/cards", json={"body": "hi", "canvas_id": canvas["id"]})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "position_required"


def test_placement_position_survives(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    created = client.post(
        "/api/cards", json={"body": "x", "canvas_id": canvas["id"], "x": 0, "y": 0}
    ).json()
    pid = created["placement"]["id"]
    resp = client.patch(f"/api/placements/{pid}", json={"x": 123.5, "y": -44.25})
    assert resp.status_code == 200
    detail = client.get(f"/api/canvases/{canvas['id']}").json()
    p = detail["placements"][0]
    assert p["x"] == 123.5 and p["y"] == -44.25


def test_magic_fixed_is_per_placement(client, admin):
    first = client.post("/api/canvases", json={"name": "First"}).json()
    second = client.post("/api/canvases", json={"name": "Second"}).json()
    created = client.post(
        "/api/cards",
        json={"title": "Anchor", "canvas_id": first["id"], "x": 0, "y": 0},
    ).json()
    other = client.post(
        f"/api/canvases/{second['id']}/placements",
        json={"card_id": created["card"]["id"], "x": 10, "y": 10},
    ).json()

    fixed = client.patch(
        f"/api/placements/{created['placement']['id']}",
        json={"magic_fixed": True},
    )
    assert fixed.status_code == 200, fixed.text
    assert fixed.json()["magic_fixed"] is True
    assert other["magic_fixed"] is False
    assert client.get(f"/api/canvases/{first['id']}").json()["placements"][0][
        "magic_fixed"
    ] is True
    assert client.get(f"/api/canvases/{second['id']}").json()["placements"][0][
        "magic_fixed"
    ] is False


def test_duplicate_placement_is_409(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    created = client.post(
        "/api/cards", json={"body": "x", "canvas_id": canvas["id"], "x": 0, "y": 0}
    ).json()
    resp = client.post(
        f"/api/canvases/{canvas['id']}/placements",
        json={"card_id": created["card"]["id"], "x": 5, "y": 5},
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "already_placed"


def test_card_on_multiple_canvases_edits_everywhere(client, admin):
    a = client.post("/api/canvases", json={"name": "A"}).json()
    b = client.post("/api/canvases", json={"name": "B"}).json()
    created = client.post(
        "/api/cards", json={"body": "v1", "canvas_id": a["id"], "x": 0, "y": 0}
    ).json()
    card_id = created["card"]["id"]
    client.post(
        f"/api/canvases/{b['id']}/placements", json={"card_id": card_id, "x": 9, "y": 9}
    )
    client.patch(f"/api/cards/{card_id}", json={"body": "v2"})
    for canvas in (a, b):
        detail = client.get(f"/api/canvases/{canvas['id']}").json()
        assert detail["placements"][0]["card"]["body"] == "v2"

    placements = client.get(f"/api/cards/{card_id}/placements").json()
    assert {p["canvas_name"] for p in placements} == {"A", "B"}


def test_delete_canvas_leaves_cards_alive_unplaced(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Doomed"}).json()
    card_ids = []
    for i in range(5):
        created = client.post(
            "/api/cards", json={"body": f"c{i}", "canvas_id": canvas["id"], "x": i, "y": 0}
        ).json()
        card_ids.append(created["card"]["id"])

    assert client.delete(f"/api/canvases/{canvas['id']}").status_code == 204

    inbox = client.get("/api/inbox").json()
    assert {c["id"] for c in inbox["items"]} == set(card_ids)


def test_hub_is_canvas_state_not_a_local_preference(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    created = client.post(
        "/api/cards", json={"title": "Hub", "canvas_id": canvas["id"], "x": 0, "y": 0}
    ).json()
    placement = created["placement"]
    assert placement["is_hub"] is False

    assert (
        client.patch(f"/api/placements/{placement['id']}", json={"is_hub": True}).json()[
            "is_hub"
        ]
        is True
    )

    # It comes back with the canvas, so any browser or machine sees it.
    detail = client.get(f"/api/canvases/{canvas['id']}").json()
    assert detail["placements"][0]["is_hub"] is True

    client.patch(f"/api/placements/{placement['id']}", json={"is_hub": False})
    detail = client.get(f"/api/canvases/{canvas['id']}").json()
    assert detail["placements"][0]["is_hub"] is False


def test_hub_is_per_placement_not_per_card(client, admin):
    a = client.post("/api/canvases", json={"name": "A"}).json()
    b = client.post("/api/canvases", json={"name": "B"}).json()
    created = client.post(
        "/api/cards", json={"title": "Shared", "canvas_id": a["id"], "x": 0, "y": 0}
    ).json()
    card_id = created["card"]["id"]
    other = client.post(
        f"/api/canvases/{b['id']}/placements", json={"card_id": card_id, "x": 0, "y": 0}
    ).json()

    client.patch(f"/api/placements/{created['placement']['id']}", json={"is_hub": True})

    assert client.get(f"/api/canvases/{a['id']}").json()["placements"][0]["is_hub"] is True
    assert client.get(f"/api/canvases/{b['id']}").json()["placements"][0]["is_hub"] is False
    assert other["is_hub"] is False


def test_viewers_see_hubs_but_cannot_set_them(client, admin, second_client):
    canvas = client.post("/api/canvases", json={"name": "Shared"}).json()
    created = client.post(
        "/api/cards", json={"title": "Hub", "canvas_id": canvas["id"], "x": 0, "y": 0}
    ).json()
    client.patch(f"/api/placements/{created['placement']['id']}", json={"is_hub": True})

    other = second_client.get("/api/me").json()
    client.post(
        f"/api/canvases/{canvas['id']}/members",
        json={"email": other["email"], "role": "viewer"},
    )

    # Shared: the viewer sees the board the way its owner arranged it.
    detail = second_client.get(f"/api/canvases/{canvas['id']}").json()
    assert detail["placements"][0]["is_hub"] is True
    assert (
        second_client.patch(
            f"/api/placements/{created['placement']['id']}", json={"is_hub": False}
        ).status_code
        == 403
    )


def test_delete_card_removes_it_everywhere(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    created = client.post(
        "/api/cards", json={"body": "x", "canvas_id": canvas["id"], "x": 0, "y": 0}
    ).json()
    assert client.delete(f"/api/cards/{created['card']['id']}").status_code == 204
    detail = client.get(f"/api/canvases/{canvas['id']}").json()
    assert detail["placements"] == []
    assert client.get("/api/inbox").json()["items"] == []
