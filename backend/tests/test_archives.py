import io
import json
import zipfile

from tests.conftest import requires_db

pytestmark = requires_db


def test_specific_canvas_archive_round_trip_preserves_structure_and_media(
    client, admin, tmp_path, monkeypatch
):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    canvas = client.post(
        "/api/canvases", json={"name": "Portable", "width": 1800, "height": 1200}
    ).json()
    first = client.post(
        "/api/cards",
        json={
            "type": "text",
            "title": "Source",
            "body": "A linked note",
            "canvas_id": canvas["id"],
            "x": 90,
            "y": 120,
        },
    ).json()
    image = client.post(
        "/api/cards",
        json={
            "type": "image",
            "title": "Reference image",
            "canvas_id": canvas["id"],
            "x": 520,
            "y": 180,
        },
    ).json()
    inbox_card = client.post(
        "/api/cards",
        json={"type": "text", "title": "Waiting", "inbox_canvas_id": canvas["id"]},
    ).json()["card"]
    uploaded = client.post(
        f"/api/cards/{image['card']['id']}/image",
        files={"file": ("reference.png", io.BytesIO(b"\x89PNG-archive"), "image/png")},
    )
    assert uploaded.status_code == 201, uploaded.text
    old_file_id = uploaded.json()["payload"]["image_file_id"]
    client.patch(
        f"/api/placements/{first['placement']['id']}",
        json={"w": 410, "h": 230, "z": 7, "is_hub": True},
    )
    assert client.post(
        f"/api/canvases/{canvas['id']}/zones",
        json={"name": "Research", "x": 40, "y": 50, "w": 900, "h": 600},
    ).status_code == 201
    assert client.post(
        "/api/links",
        json={
            "source_card_id": first["card"]["id"],
            "target_card_id": image["card"]["id"],
            "link_type": "related",
            "note": "Visual evidence",
            "created_on_canvas_id": canvas["id"],
        },
    ).status_code == 201
    assert client.put(
        f"/api/canvases/{canvas['id']}/cover",
        files={"file": ("cover.png", io.BytesIO(b"\x89PNG-cover"), "image/png")},
    ).status_code == 200

    exported = client.post(
        "/api/archive/export",
        json={
            "canvas_id": canvas["id"],
            "preferences": {
                canvas["id"]: {"appearance": "pantry", "text_size": 15}
            },
        },
    )
    assert exported.status_code == 200, exported.text
    assert exported.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["format"] == "canvas-notes-archive"
        assert manifest["version"] == 1
        assert len(manifest["cards"]) == 3
        assert next(
            item for item in manifest["cards"] if item["id"] == inbox_card["id"]
        )["inbox_canvas_id"] == canvas["id"]
        assert len(manifest["files"]) == 1
        assert manifest["canvases"][0]["cover_member"] in archive.namelist()

    imported = client.post(
        "/api/archive/import",
        files={
            "file": (
                "portable.canvas-notes.zip",
                io.BytesIO(exported.content),
                "application/zip",
            )
        },
    )
    assert imported.status_code == 200, imported.text
    result = imported.json()
    assert result["scope"] == "canvas"
    assert result["root_canvas_id"] != canvas["id"]
    assert result["card_count"] == 3
    assert result["canvases"][0]["appearance"] == "pantry"
    assert result["canvases"][0]["text_size"] == 15

    detail = client.get(f"/api/canvases/{result['root_canvas_id']}").json()
    assert detail["name"] == "Portable"
    assert detail["width"] == 1800
    assert len(detail["placements"]) == 2
    assert len(detail["zones"]) == 1
    assert len(detail["links"]) == 1
    restored_first = next(
        item
        for item in detail["placements"]
        if item["card"]["title"] == "Source"
    )
    assert restored_first["w"] == 410
    assert restored_first["is_hub"] is True
    restored_image = next(
        item for item in detail["placements"] if item["card"]["type"] == "image"
    )
    new_file_id = restored_image["card"]["payload"]["image_file_id"]
    assert new_file_id != old_file_id
    assert client.get(f"/api/files/{new_file_id}").content == b"\x89PNG-archive"
    assert client.get(f"/api/canvases/{result['root_canvas_id']}/cover").content == b"\x89PNG-cover"
    restored_inbox = client.get(
        "/api/cards/inbox", params={"canvas_id": result["root_canvas_id"]}
    ).json()["items"]
    assert [item["title"] for item in restored_inbox] == ["Waiting"]


def test_specific_archive_includes_nested_canvases_and_remaps_board_target(
    client, admin, tmp_path, monkeypatch
):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    parent = client.post("/api/canvases", json={"name": "Project"}).json()
    board = client.post(
        f"/api/canvases/{parent['id']}/boards",
        json={"name": "Details", "x": 100, "y": 200},
    ).json()
    child_id = board["card"]["payload"]["canvas_id"]
    client.post(
        "/api/cards",
        json={"title": "Nested note", "canvas_id": child_id, "x": 20, "y": 30},
    )

    exported = client.post("/api/archive/export", json={"canvas_id": parent["id"]})
    assert exported.status_code == 200, exported.text
    imported = client.post(
        "/api/archive/import",
        files={"file": ("project.zip", io.BytesIO(exported.content), "application/zip")},
    )
    assert imported.status_code == 200, imported.text
    result = imported.json()
    assert len(result["canvases"]) == 2

    restored_parent = client.get(f"/api/canvases/{result['root_canvas_id']}").json()
    restored_board = restored_parent["placements"][0]["card"]
    new_child_id = restored_board["payload"]["canvas_id"]
    assert new_child_id != child_id
    restored_child = client.get(f"/api/canvases/{new_child_id}").json()
    assert restored_child["name"] == "Details"
    assert restored_child["placements"][0]["card"]["title"] == "Nested note"


def test_all_canvas_archive_includes_owned_inbox_cards(client, admin, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    client.post(
        "/api/cards",
        json={"title": "Placed", "canvas_id": canvas["id"], "x": 10, "y": 20},
    )
    client.post("/api/cards", json={"title": "Inbox only"})

    exported = client.post("/api/archive/export", json={})
    assert exported.status_code == 200, exported.text
    imported = client.post(
        "/api/archive/import",
        files={"file": ("all.zip", io.BytesIO(exported.content), "application/zip")},
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["scope"] == "all"
    assert imported.json()["card_count"] == 2


def test_archive_import_rejects_non_archive(client, admin):
    response = client.post(
        "/api/archive/import",
        files={"file": ("not-an-archive.zip", io.BytesIO(b"nope"), "application/zip")},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_archive"


def test_shared_canvas_can_only_be_exported_by_its_owner(
    client, admin, second_client
):
    canvas = client.post("/api/canvases", json={"name": "Shared"}).json()
    other = second_client.get("/api/me").json()
    client.post(
        f"/api/canvases/{canvas['id']}/members",
        json={"email": other["email"], "role": "editor"},
    )

    response = second_client.post(
        "/api/archive/export", json={"canvas_id": canvas["id"]}
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "owner_only"
