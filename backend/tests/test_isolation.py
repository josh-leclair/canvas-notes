from tests.conftest import requires_db

pytestmark = requires_db


def _make_canvas_with_card(client):
    canvas = client.post("/api/canvases", json={"name": "Mine"}).json()
    created = client.post(
        "/api/cards",
        json={"type": "text", "body": "secret", "canvas_id": canvas["id"], "x": 0, "y": 0},
    ).json()
    return canvas, created["card"], created["placement"]


def test_users_cannot_see_each_other(client, admin, second_client):
    canvas, card, placement = _make_canvas_with_card(client)

    assert second_client.get("/api/canvases").json() == []
    # Guessing ids returns 404, never 403.
    assert second_client.get(f"/api/canvases/{canvas['id']}").status_code == 404
    assert second_client.patch(
        f"/api/canvases/{canvas['id']}", json={"name": "stolen"}
    ).status_code == 404
    assert second_client.delete(f"/api/canvases/{canvas['id']}").status_code == 404
    assert second_client.patch(
        f"/api/cards/{card['id']}", json={"body": "defaced"}
    ).status_code == 404
    assert second_client.delete(f"/api/cards/{card['id']}").status_code == 404
    assert second_client.patch(
        f"/api/placements/{placement['id']}", json={"x": 1, "y": 1}
    ).status_code == 404
    assert second_client.delete(f"/api/placements/{placement['id']}").status_code == 404
    assert second_client.get(f"/api/cards/{card['id']}/placements").status_code == 404


def test_cannot_place_someone_elses_card(client, admin, second_client):
    _, card, _ = _make_canvas_with_card(client)
    other_canvas = second_client.post("/api/canvases", json={"name": "Theirs"}).json()
    resp = second_client.post(
        f"/api/canvases/{other_canvas['id']}/placements",
        json={"card_id": card["id"], "x": 0, "y": 0},
    )
    assert resp.status_code == 404
