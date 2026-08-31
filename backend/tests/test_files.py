import io

from tests.conftest import requires_db

pytestmark = requires_db


def make_audio_card(client):
    return client.post("/api/cards", json={"type": "audio", "title": "memo"}).json()[
        "card"
    ]


def upload(client, card_id, mime="audio/webm", content=b"fake-audio-bytes"):
    return client.post(
        f"/api/cards/{card_id}/audio",
        files={"file": ("memo.webm", io.BytesIO(content), mime)},
    )


def test_audio_upload_and_serve(client, admin, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    card = make_audio_card(client)
    resp = upload(client, card["id"])
    assert resp.status_code == 201, resp.text
    payload = resp.json()["payload"]
    assert payload["transcript_status"] == "queued"

    served = client.get(f"/api/files/{payload['audio_file_id']}")
    assert served.status_code == 200
    assert served.content == b"fake-audio-bytes"


def test_audio_upload_rejects_wrong_type(client, admin, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    text_card = client.post("/api/cards", json={"type": "text"}).json()["card"]
    assert upload(client, text_card["id"]).status_code == 409

    card = make_audio_card(client)
    assert upload(client, card["id"], mime="application/zip").status_code == 415


def test_image_upload_and_serve(client, admin, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    card = client.post("/api/cards", json={"type": "image"}).json()["card"]
    resp = client.post(
        f"/api/cards/{card['id']}/image",
        files={"file": ("shot.png", io.BytesIO(b"\x89PNG-fake"), "image/png")},
    )
    assert resp.status_code == 201, resp.text
    payload = resp.json()["payload"]
    assert payload["image_mime"] == "image/png"

    served = client.get(f"/api/files/{payload['image_file_id']}")
    assert served.status_code == 200
    assert served.content == b"\x89PNG-fake"


def test_image_upload_rejects_wrong_type_and_card(client, admin, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    text_card = client.post("/api/cards", json={"type": "text"}).json()["card"]
    resp = client.post(
        f"/api/cards/{text_card['id']}/image",
        files={"file": ("shot.png", io.BytesIO(b"x"), "image/png")},
    )
    assert resp.status_code == 409

    image_card = client.post("/api/cards", json={"type": "image"}).json()["card"]
    resp = client.post(
        f"/api/cards/{image_card['id']}/image",
        files={"file": ("evil.exe", io.BytesIO(b"MZ"), "application/x-msdownload")},
    )
    assert resp.status_code == 415


def test_files_are_owner_scoped(client, admin, second_client, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    card = make_audio_card(client)
    file_id = upload(client, card["id"]).json()["payload"]["audio_file_id"]
    assert second_client.get(f"/api/files/{file_id}").status_code == 404
