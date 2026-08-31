from tests.conftest import requires_db

pytestmark = requires_db


def make_canvas(client, name="Board"):
    return client.post("/api/canvases", json={"name": name}).json()


def make_card(client, canvas, title="Card"):
    return client.post(
        "/api/cards",
        json={"title": title, "canvas_id": canvas["id"], "x": 10, "y": 20},
    ).json()


def test_daily_card_is_one_card_that_can_live_on_multiple_canvases(client, admin):
    first = make_canvas(client, "First")
    second = make_canvas(client, "Second")
    body = {"day": "2026-08-21", "canvas_id": first["id"], "x": 50, "y": 60}
    opened = client.post("/api/daily-cards/open", json=body)
    assert opened.status_code == 200
    card_id = opened.json()["card"]["id"]
    assert opened.json()["card"]["payload"]["daily_card"]["date"] == "2026-08-21"

    reopened = client.post("/api/daily-cards/open", json=body).json()
    assert reopened["card"]["id"] == card_id
    assert len(client.get(f"/api/canvases/{first['id']}").json()["placements"]) == 1

    other = client.post(
        "/api/daily-cards/open",
        json={"day": "2026-08-21", "canvas_id": second["id"], "x": 1, "y": 2},
    ).json()
    assert other["card"]["id"] == card_id
    assert {p["canvas_name"] for p in client.get(f"/api/cards/{card_id}/placements").json()} == {
        "First",
        "Second",
    }


def test_touch_only_links_after_daily_card_exists_and_deduplicates(client, admin):
    canvas = make_canvas(client)
    card = make_card(client, canvas)["card"]
    touch = {"day": "2026-08-21", "canvas_id": canvas["id"]}
    assert client.post(f"/api/daily-cards/{card['id']}/touch", json=touch).json() is None

    daily = client.post(
        "/api/daily-cards/open",
        json={"day": "2026-08-21", "canvas_id": canvas["id"], "x": 0, "y": 0},
    ).json()["card"]
    first = client.post(f"/api/daily-cards/{card['id']}/touch", json=touch).json()
    second = client.post(f"/api/daily-cards/{card['id']}/touch", json=touch).json()
    assert first["id"] == second["id"]
    assert first["source_card_id"] == daily["id"]
    assert first["target_card_id"] == card["id"]
    assert first["link_type"] == "touched"


def test_focus_shelf_is_user_specific_and_uses_live_card_content(
    client, admin, second_client
):
    canvas = make_canvas(client)
    card = make_card(client, canvas, "Before")["card"]
    assert client.put(f"/api/focus-shelf/{card['id']}").status_code == 204
    assert client.put(f"/api/focus-shelf/{card['id']}").status_code == 204

    client.patch(f"/api/cards/{card['id']}", json={"title": "After"})
    shelf = client.get("/api/focus-shelf").json()
    assert len(shelf) == 1
    assert shelf[0]["card"]["title"] == "After"
    assert shelf[0]["placements"][0]["canvas_name"] == "Board"
    assert second_client.get("/api/focus-shelf").json() == []

    assert client.delete(f"/api/focus-shelf/{card['id']}").status_code == 204
    assert client.get("/api/focus-shelf").json() == []


def test_focus_shelf_cleans_up_when_card_is_deleted(client, admin):
    canvas = make_canvas(client)
    card = make_card(client, canvas)["card"]
    client.put(f"/api/focus-shelf/{card['id']}")
    client.delete(f"/api/cards/{card['id']}")
    assert client.get("/api/focus-shelf").json() == []
