from tests.conftest import requires_db


@requires_db
def test_cards_can_be_routed_to_general_or_board_inboxes(client, admin):
    board = client.post("/api/canvases", json={"name": "Research"}).json()

    general = client.post("/api/cards", json={"type": "text", "body": "loose"})
    routed = client.post(
        "/api/cards",
        json={
            "type": "document",
            "title": "Draft",
            "body": "# On the phone",
            "inbox_canvas_id": board["id"],
        },
    )

    assert general.status_code == 201
    assert routed.status_code == 201
    assert routed.json()["card"]["inbox_canvas_id"] == board["id"]
    assert [card["id"] for card in client.get("/api/inbox?general=true").json()["items"]] == [
        general.json()["card"]["id"]
    ]
    assert [card["id"] for card in client.get(f"/api/inbox?canvas_id={board['id']}").json()["items"]] == [
        routed.json()["card"]["id"]
    ]


@requires_db
def test_placing_a_board_inbox_card_clears_its_route(client, admin):
    board = client.post("/api/canvases", json={"name": "Research"}).json()
    card = client.post(
        "/api/cards",
        json={"body": "ready", "inbox_canvas_id": board["id"]},
    ).json()["card"]

    placed = client.post(
        f"/api/canvases/{board['id']}/placements",
        json={"card_id": card["id"], "x": 10, "y": 20},
    )
    assert placed.status_code == 201

    client.delete(f"/api/placements/{placed.json()['id']}")
    returned = client.get("/api/inbox?general=true").json()["items"]
    assert [item["id"] for item in returned] == [card["id"]]


@requires_db
def test_zone_crud_is_returned_with_canvas_detail(client, admin):
    board = client.post("/api/canvases", json={"name": "Research"}).json()
    created = client.post(
        f"/api/canvases/{board['id']}/zones",
        json={"name": "Sources", "x": 100, "y": 120, "w": 600, "h": 400},
    )
    assert created.status_code == 201
    zone = created.json()

    detail = client.get(f"/api/canvases/{board['id']}").json()
    assert [(item["id"], item["name"]) for item in detail["zones"]] == [
        (zone["id"], "Sources")
    ]

    updated = client.patch(
        f"/api/zones/{zone['id']}", json={"name": "Primary sources", "w": 720}
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Primary sources"
    assert updated.json()["w"] == 720

    assert client.delete(f"/api/zones/{zone['id']}").status_code == 204
    assert client.get(f"/api/canvases/{board['id']}").json()["zones"] == []


@requires_db
def test_viewer_cannot_route_a_new_card_to_a_board_inbox(client, admin, second_client):
    board = client.post("/api/canvases", json={"name": "Shared"}).json()
    second = second_client.get("/api/me").json()
    client.post(
        f"/api/canvases/{board['id']}/members",
        json={"email": second["email"], "role": "viewer"},
    )

    response = second_client.post(
        "/api/cards",
        json={"body": "not allowed", "inbox_canvas_id": board["id"]},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "read_only"
