"""Board cards: a card that stands for another canvas."""
from tests.conftest import requires_db

pytestmark = requires_db


def make_board(client, canvas_id, name="Storyboard", x=0, y=0):
    resp = client.post(
        f"/api/canvases/{canvas_id}/boards", json={"name": name, "x": x, "y": y}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_creating_a_board_makes_a_canvas_and_the_card_that_opens_it(client, admin):
    parent = client.post("/api/canvases", json={"name": "Filming"}).json()
    created = make_board(client, parent["id"], "Storyboard")

    card = created["card"]
    assert card["type"] == "board"
    assert card["board"]["name"] == "Storyboard"
    assert card["board"]["card_count"] == 0
    # Card and placement arrive together, so a board is never half-created.
    assert created["placement"]["x"] == 0

    # The child is a real canvas, reachable on its own.
    child_id = card["board"]["canvas_id"]
    child = client.get(f"/api/canvases/{child_id}").json()
    assert child["name"] == "Storyboard"
    assert child["is_infinite"] is False
    assert child["width"] == 1920
    assert child["height"] == 1080


def test_board_card_reports_a_live_count(client, admin):
    parent = client.post("/api/canvases", json={"name": "Filming"}).json()
    child_id = make_board(client, parent["id"])["card"]["board"]["canvas_id"]

    for i in range(3):
        client.post(
            "/api/cards",
            json={"body": f"c{i}", "canvas_id": child_id, "x": i * 10, "y": 0},
        )

    detail = client.get(f"/api/canvases/{parent['id']}").json()
    board_card = detail["placements"][0]["card"]
    # Resolved on read, so it cannot drift from the canvas it describes.
    assert board_card["board"]["card_count"] == 3


def test_nesting_is_derived_and_keeps_children_out_of_the_top_level(client, admin):
    parent = client.post("/api/canvases", json={"name": "Filming"}).json()
    created = make_board(client, parent["id"], "Storyboard")
    child_id = created["card"]["board"]["canvas_id"]

    listed = {c["id"]: c for c in client.get("/api/canvases").json()}
    assert listed[parent["id"]]["is_nested"] is False
    assert listed[child_id]["is_nested"] is True

    # Remove the board card and the child returns to the top level: there is
    # no separate nesting record to fall out of step.
    client.delete(f"/api/cards/{created['card']['id']}")
    listed = {c["id"]: c for c in client.get("/api/canvases").json()}
    assert listed[child_id]["is_nested"] is False


def test_parents_endpoint_drives_the_breadcrumb(client, admin):
    a = client.post("/api/canvases", json={"name": "Filming"}).json()
    b = client.post("/api/canvases", json={"name": "Ideas"}).json()
    child_id = make_board(client, a["id"], "Storyboard")["card"]["board"]["canvas_id"]

    assert [p["id"] for p in client.get(f"/api/canvases/{child_id}/parents").json()] == [
        a["id"]
    ]

    # A board can sit on more than one canvas, like any other card.
    card_id = client.get(f"/api/canvases/{a['id']}").json()["placements"][0]["card"]["id"]
    client.post(
        f"/api/canvases/{b['id']}/placements", json={"card_id": card_id, "x": 0, "y": 0}
    )
    parents = {p["id"] for p in client.get(f"/api/canvases/{child_id}/parents").json()}
    assert parents == {a["id"], b["id"]}


def test_deleting_the_target_leaves_the_card_without_a_destination(client, admin):
    parent = client.post("/api/canvases", json={"name": "Filming"}).json()
    created = make_board(client, parent["id"])
    child_id = created["card"]["board"]["canvas_id"]

    client.delete(f"/api/canvases/{child_id}")

    detail = client.get(f"/api/canvases/{parent['id']}").json()
    card = detail["placements"][0]["card"]
    # The card survives with no board attached, rather than 500ing.
    assert card["type"] == "board"
    assert card["board"] is None


def test_board_target_must_be_visible(client, admin, second_client):
    parent = client.post("/api/canvases", json={"name": "Mine"}).json()
    created = make_board(client, parent["id"], "Private")
    card_id = created["card"]["id"]

    # Share only the parent, not the nested board.
    other = second_client.get("/api/me").json()
    client.post(
        f"/api/canvases/{parent['id']}/members",
        json={"email": other["email"], "role": "viewer"},
    )

    detail = second_client.get(f"/api/canvases/{parent['id']}").json()
    card = next(p["card"] for p in detail["placements"] if p["card"]["id"] == card_id)
    # They can see the card but not follow it: the nested canvas was not shared.
    assert card["board"] is None


def test_boards_need_edit_rights_on_the_parent(client, admin, second_client):
    parent = client.post("/api/canvases", json={"name": "Shared"}).json()
    other = second_client.get("/api/me").json()
    client.post(
        f"/api/canvases/{parent['id']}/members",
        json={"email": other["email"], "role": "viewer"},
    )
    resp = second_client.post(
        f"/api/canvases/{parent['id']}/boards", json={"name": "Nope", "x": 0, "y": 0}
    )
    assert resp.status_code == 403
