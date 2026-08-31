"""Composing selected cards into one placed document."""
from app import jobs, runtime_settings
from tests.conftest import requires_db

pytestmark = requires_db


def configure_generation(client):
    response = client.put(
        "/api/ai/settings",
        json={
            "chat_base_url": "http://localhost:11434/v1",
            "chat_model": "gemma3:12b",
        },
    )
    assert response.status_code == 200, response.text
    runtime_settings.invalidate_cache()


def selected_cards(client):
    canvas = client.post("/api/canvases", json={"name": "Research"}).json()
    cards = []
    for index, (title, body) in enumerate(
        [("Problem", "Customers cannot find saved work."), ("Evidence", "Five interviews reported it.")]
    ):
        cards.append(
            client.post(
                "/api/cards",
                json={
                    "title": title,
                    "body": body,
                    "canvas_id": canvas["id"],
                    "x": index * 300,
                    "y": 0,
                },
            ).json()["card"]
        )
    return canvas, cards


def test_composition_requires_a_generation_endpoint(client, admin):
    canvas, cards = selected_cards(client)
    response = client.post(
        f"/api/canvases/{canvas['id']}/compose",
        json={"card_ids": [card["id"] for card in cards], "x": 700, "y": 0},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "generation_unavailable"


def test_selected_cards_become_one_placed_document(client, admin, monkeypatch):
    configure_generation(client)
    canvas, cards = selected_cards(client)
    started = client.post(
        f"/api/canvases/{canvas['id']}/compose",
        json={"card_ids": [card["id"] for card in cards], "x": 700, "y": 25},
    )
    assert started.status_code == 202, started.text
    batch_id = started.json()["batch_id"]

    seen = {}

    def fake_compose(source_cards, relationships, config):
        seen["titles"] = [card.title for card in source_cards]
        return {"title": "Finding Saved Work", "body": "# Problem\n\nCustomers cannot find saved work.\n\n# Evidence\n\nFive interviews reported it."}

    monkeypatch.setattr(jobs, "compose_document", fake_compose)
    assert jobs.run_one(["compose"]) is True

    status = client.get(f"/api/compositions/{batch_id}")
    assert status.status_code == 200, status.text
    result = status.json()
    assert result["status"] == "done"
    assert result["card"]["type"] == "document"
    assert result["card"]["title"] == "Finding Saved Work"
    assert result["placement"]["canvas_id"] == canvas["id"]
    assert result["placement"]["x"] == 700
    assert seen["titles"] == ["Problem", "Evidence"]
    stamp = result["card"]["payload"]["generated_by"]
    assert stamp["kind"] == "composition"
    assert stamp["model"] == "gemma3:12b"
    assert stamp["source_card_ids"] == [card["id"] for card in cards]
    living = result["card"]["payload"]["living_document"]
    assert [source["card_id"] for source in living["sources"]] == [
        card["id"] for card in cards
    ]
    assert living["blocks"]


def test_composition_status_is_private(client, admin, second_client, monkeypatch):
    configure_generation(client)
    canvas, cards = selected_cards(client)
    batch_id = client.post(
        f"/api/canvases/{canvas['id']}/compose",
        json={"card_ids": [card["id"] for card in cards], "x": 700, "y": 0},
    ).json()["batch_id"]
    assert second_client.get(f"/api/compositions/{batch_id}").status_code == 404


def test_refresh_preserves_a_manually_edited_block(client, admin, monkeypatch):
    configure_generation(client)
    canvas, cards = selected_cards(client)
    started = client.post(
        f"/api/canvases/{canvas['id']}/compose",
        json={"card_ids": [card["id"] for card in cards], "x": 700, "y": 0},
    ).json()
    monkeypatch.setattr(
        jobs,
        "compose_document",
        lambda *args, **kwargs: {
            "title": "Brief",
            "body": "## Problem\n\nOriginal problem.\n\nOriginal evidence.",
        },
    )
    assert jobs.run_one(["compose"]) is True
    made = client.get(f"/api/compositions/{started['batch_id']}").json()["card"]
    client.patch(
        f"/api/cards/{made['id']}",
        json={"body": "## Problem\n\nOriginal problem.\n\nMy edited evidence."},
    )

    refreshed = client.post(f"/api/cards/{made['id']}/refresh-composition")
    assert refreshed.status_code == 202, refreshed.text
    monkeypatch.setattr(
        jobs,
        "compose_document",
        lambda *args, **kwargs: {
            "title": "Updated brief",
            "body": "## Problem\n\nNew problem.\n\nNew evidence.",
        },
    )
    assert jobs.run_one(["refresh_compose"]) is True
    result = client.get(
        f"/api/compositions/{refreshed.json()['batch_id']}"
    ).json()["card"]
    assert result["body"] == "## Problem\n\nNew problem.\n\nMy edited evidence."
    status = result["payload"]["living_document"]["last_refresh"]
    assert status["refreshed_blocks"] == 2
    assert status["preserved_blocks"] == 1
