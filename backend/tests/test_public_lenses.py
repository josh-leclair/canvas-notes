"""Public lenses expose only explicit, frozen canvas selections."""

from pathlib import Path

from app.config import settings
from tests.conftest import requires_db

pytestmark = requires_db


def canvas(client):
    response = client.post("/api/canvases", json={"name": "Public source"})
    assert response.status_code == 201, response.text
    return response.json()


def card(client, canvas_id, title, *, body="", card_type="text", x=0, payload=None):
    response = client.post(
        "/api/cards",
        json={
            "type": card_type,
            "title": title,
            "body": body,
            "payload": payload or {},
            "canvas_id": canvas_id,
            "x": x,
            "y": 0,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def publish(
    client,
    canvas_id,
    placement_ids,
    *,
    title="Shared research",
    appearance="studio",
    text_size=13,
):
    response = client.post(
        "/api/public-lenses",
        json={
            "canvas_id": canvas_id,
            "placement_ids": placement_ids,
            "title": title,
            "description": "A reviewed selection",
            "appearance": appearance,
            "text_size": text_size,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_public_lens_freezes_canvas_presentation(client, admin):
    board = canvas(client)
    note = card(client, board["id"], "Styled note")

    lens = publish(
        client,
        board["id"],
        [note["placement"]["id"]],
        appearance="pantry",
        text_size=17,
    )
    snapshot = client.get(f"/api/public/lenses/{lens['slug']}").json()["snapshot"]

    assert snapshot["appearance"] == "pantry"
    assert snapshot["text_size"] == 17


def test_guided_lens_preserves_the_authored_card_order(client, admin):
    board = canvas(client)
    first = card(client, board["id"], "First")
    second = card(client, board["id"], "Second", x=400)
    response = client.post(
        "/api/public-lenses",
        json={
            "canvas_id": board["id"],
            "placement_ids": [second["placement"]["id"], first["placement"]["id"]],
            "title": "Guided research",
            "view_mode": "presentation",
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["view_mode"] == "presentation"
    snapshot = client.get(
        f"/api/public/lenses/{response.json()['slug']}"
    ).json()["snapshot"]
    assert snapshot["view_mode"] == "presentation"
    assert snapshot["sequence"] == [
        second["placement"]["id"],
        first["placement"]["id"],
    ]


def test_public_lens_is_frozen_and_strips_cross_boundary_references(client, admin):
    board = canvas(client)
    inside = card(client, board["id"], "Inside", body="First revision")
    outside = card(client, board["id"], "Private", x=500)
    reference = f"[Private details](card:{outside['card']['id']})"
    html_reference = f'<a href="card:{outside["card"]["id"]}">Private HTML details</a>'
    client.patch(
        f"/api/cards/{inside['card']['id']}",
        json={"body": f"First revision\n\n{reference}\n\n{html_reference}"},
    )
    client.post(
        "/api/links",
        json={
            "source_card_id": inside["card"]["id"],
            "target_card_id": outside["card"]["id"],
            "link_type": "related",
            "created_on_canvas_id": board["id"],
        },
    )

    lens = publish(client, board["id"], [inside["placement"]["id"]])
    public = client.get(f"/api/public/lenses/{lens['slug']}")
    assert public.status_code == 200, public.text
    snapshot = public.json()["snapshot"]
    assert len(snapshot["placements"]) == 1
    assert snapshot["links"] == []
    body = snapshot["placements"][0]["card"]["body"]
    assert "card:" not in body
    assert "Private details" in body and "Private HTML details" in body

    # The publication is a snapshot, not a live permission around the source.
    client.patch(f"/api/cards/{inside['card']['id']}", json={"body": "Second revision"})
    still_frozen = client.get(f"/api/public/lenses/{lens['slug']}").json()
    assert "First revision" in still_frozen["snapshot"]["placements"][0]["card"]["body"]

    updated = client.put(
        f"/api/public-lenses/{lens['id']}",
        json={
            "canvas_id": board["id"],
            "placement_ids": [inside["placement"]["id"]],
            "title": "Shared research",
            "description": None,
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["revision"] == 2
    refreshed = client.get(f"/api/public/lenses/{lens['slug']}").json()
    assert refreshed["snapshot"]["placements"][0]["card"]["body"] == "Second revision"

    assert client.delete(f"/api/public-lenses/{lens['id']}").status_code == 204
    assert client.get(f"/api/public/lenses/{lens['slug']}").status_code == 404


def test_selected_column_includes_its_members(client, admin):
    board = canvas(client)
    column = card(client, board["id"], "Sources", card_type="column")
    member = card(client, board["id"], "One source", x=300)
    moved = client.patch(
        f"/api/placements/{member['placement']['id']}",
        json={"parent_id": column["placement"]["id"], "sort": 0},
    )
    assert moved.status_code == 200, moved.text

    lens = publish(client, board["id"], [column["placement"]["id"]])
    snapshot = client.get(f"/api/public/lenses/{lens['slug']}").json()["snapshot"]
    assert {item["id"] for item in snapshot["placements"]} == {
        column["placement"]["id"],
        member["placement"]["id"],
    }
    published_member = next(item for item in snapshot["placements"] if item["id"] == member["placement"]["id"])
    assert published_member["parent_id"] == column["placement"]["id"]


def test_public_media_is_an_independent_snapshot(client, admin):
    board = canvas(client)
    image = card(client, board["id"], "Diagram", card_type="image")
    uploaded = client.post(
        f"/api/cards/{image['card']['id']}/image",
        files={"file": ("diagram.png", b"frozen-image-bytes", "image/png")},
    )
    assert uploaded.status_code == 201, uploaded.text
    lens = publish(client, board["id"], [image["placement"]["id"]])
    public = client.get(f"/api/public/lenses/{lens['slug']}").json()
    asset_id = public["snapshot"]["placements"][0]["card"]["payload"]["image_file_id"]

    # Hard-deleting the source also removes its private file. The copied public
    # revision remains available until the lens itself is revoked.
    assert client.delete(f"/api/cards/{image['card']['id']}").status_code == 204
    asset = client.get(f"/api/public/lenses/{lens['slug']}/assets/{asset_id}")
    assert asset.status_code == 200
    assert asset.content == b"frozen-image-bytes"


def test_permanent_removal_deletes_all_lens_revisions_but_not_source_cards(
    client, admin
):
    board = canvas(client)
    image = card(client, board["id"], "Original diagram", card_type="image")
    uploaded = client.post(
        f"/api/cards/{image['card']['id']}/image",
        files={"file": ("diagram.png", b"original-image-bytes", "image/png")},
    )
    assert uploaded.status_code == 201, uploaded.text
    source_file_id = uploaded.json()["payload"]["image_file_id"]

    lens = publish(client, board["id"], [image["placement"]["id"]])
    republished = client.put(
        f"/api/public-lenses/{lens['id']}",
        json={
            "canvas_id": board["id"],
            "placement_ids": [image["placement"]["id"]],
            "title": lens["title"],
            "description": None,
        },
    )
    assert republished.status_code == 200, republished.text

    lens_dir = Path(settings.files_dir) / "public-lenses" / lens["id"]
    assert {path.name for path in lens_dir.iterdir()} == {"1", "2"}

    removed = client.delete(f"/api/public-lenses/{lens['id']}/permanent")
    assert removed.status_code == 204, removed.text
    assert not lens_dir.exists()
    assert client.get(f"/api/public/lenses/{lens['slug']}").status_code == 404
    assert lens["id"] not in {
        row["id"] for row in client.get(
            f"/api/public-lenses?canvas_id={board['id']}"
        ).json()
    }

    # The private card and its original upload belong to the canvas, not to
    # the disposable public copy.
    detail = client.get(f"/api/canvases/{board['id']}").json()
    assert image["card"]["id"] in {
        placement["card"]["id"] for placement in detail["placements"]
    }
    source = client.get(f"/api/files/{source_file_id}")
    assert source.status_code == 200
    assert source.content == b"original-image-bytes"
