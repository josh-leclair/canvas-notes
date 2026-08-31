from tests.conftest import requires_db

pytestmark = requires_db


def test_unplaced_card_appears_in_inbox(client, admin):
    created = client.post("/api/cards", json={"body": "floating"}).json()
    assert created["placement"] is None
    inbox = client.get("/api/inbox").json()
    assert [c["id"] for c in inbox["items"]] == [created["card"]["id"]]


def test_placing_removes_from_inbox_and_removal_returns_it(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    created = client.post("/api/cards", json={"body": "keep me"}).json()
    card_id = created["card"]["id"]

    placement = client.post(
        f"/api/canvases/{canvas['id']}/placements",
        json={"card_id": card_id, "x": 1, "y": 2},
    ).json()
    assert client.get("/api/inbox").json()["items"] == []

    # Removing the only placement returns the card, content intact.
    assert client.delete(f"/api/placements/{placement['id']}").status_code == 204
    items = client.get("/api/inbox").json()["items"]
    assert len(items) == 1
    assert items[0]["id"] == card_id
    assert items[0]["body"] == "keep me"


def test_card_placed_anywhere_never_in_inbox(client, admin):
    a = client.post("/api/canvases", json={"name": "A"}).json()
    b = client.post("/api/canvases", json={"name": "B"}).json()
    created = client.post(
        "/api/cards", json={"body": "x", "canvas_id": a["id"], "x": 0, "y": 0}
    ).json()
    client.post(
        f"/api/canvases/{b['id']}/placements",
        json={"card_id": created["card"]["id"], "x": 0, "y": 0},
    )
    # Still placed on B after A is deleted, so still not inbox.
    client.delete(f"/api/canvases/{a['id']}")
    assert client.get("/api/inbox").json()["items"] == []


def test_inbox_pagination(client, admin):
    ids = []
    for i in range(7):
        ids.append(client.post("/api/cards", json={"body": f"n{i}"}).json()["card"]["id"])

    page1 = client.get("/api/inbox?limit=3").json()
    assert len(page1["items"]) == 3 and page1["next_cursor"]
    page2 = client.get(f"/api/inbox?limit=3&cursor={page1['next_cursor']}").json()
    assert len(page2["items"]) == 3 and page2["next_cursor"]
    page3 = client.get(f"/api/inbox?limit=3&cursor={page2['next_cursor']}").json()
    assert len(page3["items"]) == 1 and page3["next_cursor"] is None

    seen = [c["id"] for c in page1["items"] + page2["items"] + page3["items"]]
    assert len(set(seen)) == 7


def test_clear_inbox_deletes_every_unplaced_card(client, admin):
    for i in range(3):
        client.post("/api/cards", json={"body": f"n{i}"})

    resp = client.delete("/api/inbox")
    assert resp.status_code == 200
    assert resp.json() == {"discarded": 3}
    assert client.get("/api/inbox").json()["items"] == []


def test_clear_inbox_keeps_placed_cards(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    placed = client.post(
        "/api/cards", json={"body": "on a canvas", "canvas_id": canvas["id"], "x": 0, "y": 0}
    ).json()["card"]
    client.post("/api/cards", json={"body": "loose"})

    assert client.delete("/api/inbox").json() == {"discarded": 1}
    assert client.get(f"/api/cards/{placed['id']}/placements").status_code == 200
    assert client.get("/api/inbox").json()["items"] == []


def test_clear_inbox_leaves_other_owners_alone(client, admin, second_client):
    second_client.post("/api/cards", json={"body": "not yours"})
    client.post("/api/cards", json={"body": "mine"})

    assert client.delete("/api/inbox").json() == {"discarded": 1}
    assert len(second_client.get("/api/inbox").json()["items"]) == 1
