"""Portal cards are live, filtered views over canonical cards."""
import uuid
from datetime import datetime, timedelta, timezone

from app.db import SessionLocal
from app.models import Card
from tests.conftest import requires_db

pytestmark = requires_db


def make_card(client, canvas_id, *, title, body="", card_type="text"):
    response = client.post(
        "/api/cards",
        json={
            "type": card_type,
            "title": title,
            "body": body,
            "canvas_id": canvas_id,
            "x": 0,
            "y": 0,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["card"]


def make_portal(client, dashboard_id, payload):
    response = client.post(
        "/api/cards",
        json={
            "type": "portal",
            "title": "Live view",
            "payload": payload,
            "canvas_id": dashboard_id,
            "x": 20,
            "y": 20,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["card"]


def test_canvas_portal_filters_live_cards_without_copying(client, admin):
    dashboard = client.post("/api/canvases", json={"name": "Dashboard"}).json()
    source = client.post("/api/canvases", json={"name": "Launch"}).json()
    matching = make_card(
        client,
        source["id"],
        title="Camera checklist",
        body="- [ ] Charge camera\n- [x] Pack tripod",
    )
    make_card(client, source["id"], title="Catering", body="Order lunch")
    portal = make_portal(
        client,
        dashboard["id"],
        {
            "scope": "canvas",
            "canvas_id": source["id"],
            "query": "camera",
            "card_type": "any",
            "open_tasks": True,
            "limit": 20,
        },
    )

    result = client.get(f"/api/cards/{portal['id']}/portal")
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["source_name"] == "Launch"
    assert data["total"] == 1
    assert [item["card"]["id"] for item in data["items"]] == [matching["id"]]

    # It is a view: editing the source is visible immediately and never
    # writes a second card into the portal.
    client.patch(
        f"/api/cards/{matching['id']}",
        json={"title": "Audio checklist", "body": "- [ ] Charge recorder\n- [x] Pack tripod"},
    )
    assert client.get(f"/api/cards/{portal['id']}/portal").json()["items"] == []


def test_workspace_portal_can_include_unplaced_owned_cards(client, admin):
    dashboard = client.post("/api/canvases", json={"name": "Dashboard"}).json()
    inbox_card = client.post(
        "/api/cards", json={"title": "Loose receipt", "body": "tax paperwork"}
    ).json()["card"]
    portal = make_portal(
        client,
        dashboard["id"],
        {
            "scope": "workspace",
            "query": "tax",
            "card_type": "any",
            "open_tasks": False,
        },
    )
    items = client.get(f"/api/cards/{portal['id']}/portal").json()["items"]
    assert [item["card"]["id"] for item in items] == [inbox_card["id"]]
    assert items[0]["placements"] == []


def test_today_portal_only_includes_cards_changed_today(client, admin):
    dashboard = client.post("/api/canvases", json={"name": "Dashboard"}).json()
    old = client.post("/api/cards", json={"title": "Old note"}).json()["card"]
    current = client.post("/api/cards", json={"title": "Current note"}).json()["card"]
    with SessionLocal() as db:
        card = db.get(Card, uuid.UUID(old["id"]))
        card.updated_at = datetime.now(timezone.utc) - timedelta(days=2)
        db.commit()
    portal = make_portal(
        client,
        dashboard["id"],
        {"scope": "workspace", "timeframe": "today", "card_type": "any"},
    )
    items = client.get(f"/api/cards/{portal['id']}/portal").json()["items"]
    ids = {item["card"]["id"] for item in items}
    assert current["id"] in ids
    assert old["id"] not in ids


def test_dropping_on_canvas_portal_places_the_canonical_card(client, admin):
    dashboard = client.post("/api/canvases", json={"name": "Dashboard"}).json()
    source = client.post("/api/canvases", json={"name": "Projects"}).json()
    loose = client.post("/api/cards", json={"title": "Roadmap"}).json()["card"]
    portal = make_portal(
        client,
        dashboard["id"],
        {"scope": "canvas", "canvas_id": source["id"], "card_type": "any"},
    )

    first = client.post(f"/api/cards/{portal['id']}/portal/items/{loose['id']}")
    assert first.status_code == 201, first.text
    # Repeating the gesture is idempotent rather than creating a duplicate.
    second = client.post(f"/api/cards/{portal['id']}/portal/items/{loose['id']}")
    assert second.status_code == 201
    assert second.json()["id"] == first.json()["id"]

    detail = client.get(f"/api/canvases/{source['id']}").json()
    assert [placement["card"]["id"] for placement in detail["placements"]] == [loose["id"]]


def test_workspace_portal_rejects_drop_membership(client, admin):
    dashboard = client.post("/api/canvases", json={"name": "Dashboard"}).json()
    loose = client.post("/api/cards", json={"title": "Loose"}).json()["card"]
    portal = make_portal(client, dashboard["id"], {"scope": "workspace"})
    response = client.post(f"/api/cards/{portal['id']}/portal/items/{loose['id']}")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "portal_not_placeable"
