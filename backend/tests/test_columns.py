"""Columns: a titled container that stacks cards vertically."""
from tests.conftest import requires_db

pytestmark = requires_db


def make_column(client, canvas_id, title="Filming", x=0, y=0):
    return client.post(
        "/api/cards",
        json={"type": "column", "title": title, "canvas_id": canvas_id, "x": x, "y": y},
    ).json()


def make_card(client, canvas_id, title="Note", x=400, y=0):
    return client.post(
        "/api/cards",
        json={"title": title, "canvas_id": canvas_id, "x": x, "y": y},
    ).json()


def test_a_card_joins_and_leaves_a_column(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    column = make_column(client, canvas["id"])
    card = make_card(client, canvas["id"])

    joined = client.patch(
        f"/api/placements/{card['placement']['id']}",
        json={"parent_id": column["placement"]["id"], "sort": 0},
    )
    assert joined.status_code == 200
    assert joined.json()["parent_id"] == column["placement"]["id"]

    # Membership travels with the canvas, so every viewer sees the same stack.
    detail = client.get(f"/api/canvases/{canvas['id']}").json()
    member = next(
        p for p in detail["placements"] if p["id"] == card["placement"]["id"]
    )
    assert member["parent_id"] == column["placement"]["id"]

    # Leaving needs an explicit clear, since an omitted field means "unchanged".
    left = client.patch(
        f"/api/placements/{card['placement']['id']}",
        json={"clear_parent": True, "x": 500, "y": 120},
    )
    assert left.status_code == 200
    assert left.json()["parent_id"] is None
    assert left.json()["x"] == 500


def test_order_within_a_column_is_persisted(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    column = make_column(client, canvas["id"])
    cards = [make_card(client, canvas["id"], f"Card {i}", x=400 + i) for i in range(3)]

    for index, card in enumerate(cards):
        client.patch(
            f"/api/placements/{card['placement']['id']}",
            json={"parent_id": column["placement"]["id"], "sort": index},
        )

    # Reverse them.
    for index, card in enumerate(reversed(cards)):
        client.patch(f"/api/placements/{card['placement']['id']}", json={"sort": index})

    detail = client.get(f"/api/canvases/{canvas['id']}").json()
    members = sorted(
        (p for p in detail["placements"] if p["parent_id"]),
        key=lambda p: p["sort"],
    )
    assert [m["card"]["title"] for m in members] == ["Card 2", "Card 1", "Card 0"]


def test_a_column_only_accepts_cards_from_its_own_canvas(client, admin):
    a = client.post("/api/canvases", json={"name": "A"}).json()
    b = client.post("/api/canvases", json={"name": "B"}).json()
    column = make_column(client, a["id"])
    elsewhere = make_card(client, b["id"])

    resp = client.patch(
        f"/api/placements/{elsewhere['placement']['id']}",
        json={"parent_id": column["placement"]["id"]},
    )
    assert resp.status_code == 404


def test_only_columns_can_be_parents(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    plain = make_card(client, canvas["id"], "Not a column", x=0)
    other = make_card(client, canvas["id"], "Note", x=400)

    resp = client.patch(
        f"/api/placements/{other['placement']['id']}",
        json={"parent_id": plain["placement"]["id"]},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "not_a_column"


def test_columns_do_not_nest_and_cannot_hold_themselves(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    outer = make_column(client, canvas["id"], "Outer")
    inner = make_column(client, canvas["id"], "Inner", x=400)

    resp = client.patch(
        f"/api/placements/{inner['placement']['id']}",
        json={"parent_id": outer["placement"]["id"]},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "nested_column"

    resp = client.patch(
        f"/api/placements/{outer['placement']['id']}",
        json={"parent_id": outer["placement"]["id"]},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "self_parent"


def test_removing_a_column_leaves_its_members_on_the_canvas(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    column = make_column(client, canvas["id"])
    card = make_card(client, canvas["id"])
    client.patch(
        f"/api/placements/{card['placement']['id']}",
        json={"parent_id": column["placement"]["id"]},
    )

    # Deleting the column card takes its placement with it; the cards it held
    # stay put and simply stop being stacked.
    client.delete(f"/api/cards/{column['card']['id']}")

    detail = client.get(f"/api/canvases/{canvas['id']}").json()
    assert len(detail["placements"]) == 1
    assert detail["placements"][0]["parent_id"] is None


def test_viewers_cannot_restack(client, admin, second_client):
    canvas = client.post("/api/canvases", json={"name": "Shared"}).json()
    column = make_column(client, canvas["id"])
    card = make_card(client, canvas["id"])

    other = second_client.get("/api/me").json()
    client.post(
        f"/api/canvases/{canvas['id']}/members",
        json={"email": other["email"], "role": "viewer"},
    )
    resp = second_client.patch(
        f"/api/placements/{card['placement']['id']}",
        json={"parent_id": column["placement"]["id"]},
    )
    assert resp.status_code == 403
