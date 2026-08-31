import io

from tests.conftest import requires_db

pytestmark = requires_db


def png(content=b"\x89PNG-cover"):
    return {"file": ("cover.png", io.BytesIO(content), "image/png")}


def test_set_get_and_clear_cover(client, admin, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()

    assert client.get(f"/api/canvases/{canvas['id']}/cover").status_code == 404
    assert client.get("/api/canvases").json()[0]["has_cover"] is False

    assert client.put(f"/api/canvases/{canvas['id']}/cover", files=png()).status_code == 200
    assert client.get("/api/canvases").json()[0]["has_cover"] is True
    served = client.get(f"/api/canvases/{canvas['id']}/cover")
    assert served.status_code == 200 and served.content == b"\x89PNG-cover"

    assert client.delete(f"/api/canvases/{canvas['id']}/cover").status_code == 204
    assert client.get(f"/api/canvases/{canvas['id']}/cover").status_code == 404


def test_replacing_a_cover_removes_the_old_file(client, admin, tmp_path, monkeypatch):
    import os

    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    client.put(f"/api/canvases/{canvas['id']}/cover", files=png(b"first"))
    client.put(f"/api/canvases/{canvas['id']}/cover", files=png(b"second"))

    covers = [f for f in os.listdir(tmp_path) if f.startswith("cover-")]
    assert len(covers) == 1
    assert client.get(f"/api/canvases/{canvas['id']}/cover").content == b"second"


def test_cover_rejects_non_images(client, admin, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    resp = client.put(
        f"/api/canvases/{canvas['id']}/cover",
        files={"file": ("x.exe", io.BytesIO(b"MZ"), "application/x-msdownload")},
    )
    assert resp.status_code == 415


def test_cover_is_owner_only_but_members_can_see_it(
    client, admin, second_client, tmp_path, monkeypatch
):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    canvas = client.post("/api/canvases", json={"name": "Shared"}).json()
    client.put(f"/api/canvases/{canvas['id']}/cover", files=png())

    other = second_client.get("/api/me").json()
    client.post(
        f"/api/canvases/{canvas['id']}/members",
        json={"email": other["email"], "role": "editor"},
    )

    # An editor can look at it...
    assert second_client.get(f"/api/canvases/{canvas['id']}/cover").status_code == 200
    # ...but not change it.
    assert (
        second_client.put(f"/api/canvases/{canvas['id']}/cover", files=png()).status_code
        == 403
    )
    assert second_client.delete(f"/api/canvases/{canvas['id']}/cover").status_code == 403


def test_canvas_detail_includes_on_canvas_links(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Board"}).json()
    a = client.post(
        "/api/cards", json={"title": "A", "canvas_id": canvas["id"], "x": 0, "y": 0}
    ).json()["card"]
    b = client.post(
        "/api/cards", json={"title": "B", "canvas_id": canvas["id"], "x": 300, "y": 0}
    ).json()["card"]
    elsewhere = client.post("/api/cards", json={"title": "Off"}).json()["card"]

    client.post(
        "/api/links", json={"source_card_id": a["id"], "target_card_id": b["id"]}
    )
    # A link to a card that is not on this canvas must not appear here; the
    # reveal handles those as portals.
    client.post(
        "/api/links", json={"source_card_id": a["id"], "target_card_id": elsewhere["id"]}
    )

    detail = client.get(f"/api/canvases/{canvas['id']}").json()
    assert len(detail["links"]) == 1
    assert detail["links"][0]["source_card_id"] == a["id"]
    assert detail["links"][0]["target_card_id"] == b["id"]


def test_canvas_links_respect_visibility(client, admin, second_client):
    canvas = client.post("/api/canvases", json={"name": "Shared"}).json()
    a = client.post(
        "/api/cards", json={"title": "A", "canvas_id": canvas["id"], "x": 0, "y": 0}
    ).json()["card"]
    b = client.post(
        "/api/cards", json={"title": "B", "canvas_id": canvas["id"], "x": 300, "y": 0}
    ).json()["card"]
    client.post(
        "/api/links", json={"source_card_id": a["id"], "target_card_id": b["id"]}
    )

    other = second_client.get("/api/me").json()
    client.post(
        f"/api/canvases/{canvas['id']}/members",
        json={"email": other["email"], "role": "viewer"},
    )
    # Both endpoints are visible to the viewer, so the link is too.
    assert len(second_client.get(f"/api/canvases/{canvas['id']}").json()["links"]) == 1
