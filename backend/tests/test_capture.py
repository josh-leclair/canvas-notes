from app.urls import card_shape_for
from tests.conftest import requires_db

pytestmark = requires_db


def test_capture_types_content(client, admin):
    text_card = client.post("/api/capture", json={"text": "just a thought"}).json()
    assert text_card["type"] == "text" and text_card["body"] == "just a thought"

    link_card = client.post(
        "/api/capture", json={"text": "https://example.com/article"}
    ).json()
    assert link_card["type"] == "link"
    assert link_card["payload"]["url"] == "https://example.com/article"

    yt = client.post("/api/capture", json={"url": "https://youtu.be/dQw4w9WgXcQ"}).json()
    assert yt["type"] == "youtube"
    assert yt["payload"]["video_id"] == "dQw4w9WgXcQ"


def test_capture_lands_in_inbox_unplaced(client, admin):
    captured = client.post("/api/capture", json={"text": "from my phone"}).json()
    inbox = client.get("/api/inbox").json()["items"]
    assert [c["id"] for c in inbox] == [captured["id"]]


def test_share_sheet_shape_keeps_selection_and_url(client, admin):
    # What an iOS share sheet sends: selected text plus the page url.
    card = client.post(
        "/api/capture",
        json={"text": "the interesting paragraph", "url": "https://example.com/post"},
    ).json()
    assert card["type"] == "link"
    assert card["body"] == "the interesting paragraph"
    assert card["payload"]["url"] == "https://example.com/post"


def _files_in(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))


def test_capture_file_makes_an_image_card(client, admin, tmp_path, monkeypatch):
    """The card has to match what the web upload produces, or crop, the
    lightbox and the cutout rendering all miss it."""
    _files_in(tmp_path, monkeypatch)
    resp = client.post(
        "/api/capture/file",
        files={"file": ("photo.png", b"png-bytes", "image/png")},
        data={"title": "from my phone"},
    )
    assert resp.status_code == 201, resp.text
    card = resp.json()
    assert card["type"] == "image"
    assert card["title"] == "from my phone"
    assert card["payload"]["image_mime"] == "image/png"

    file_id = card["payload"]["image_file_id"]
    assert client.get(f"/api/files/{file_id}").content == b"png-bytes"
    # Named after the record, the way the web upload names its own.
    assert (tmp_path / f"{file_id}.png").exists()

    # And unplaced, like everything else that arrives by capture.
    assert [c["id"] for c in client.get("/api/inbox").json()["items"]] == [card["id"]]


def test_capture_file_queues_transcription_for_audio(client, admin, tmp_path, monkeypatch):
    _files_in(tmp_path, monkeypatch)
    card = client.post(
        "/api/capture/file",
        files={"file": ("memo.m4a", b"audio-bytes", "audio/mp4")},
    ).json()
    assert card["type"] == "audio"
    assert card["payload"]["transcript_status"] == "queued"
    assert card["payload"]["audio_mime"] == "audio/mp4"


def test_capture_file_falls_back_to_a_file_card(client, admin, tmp_path, monkeypatch):
    """A share sheet offers whatever the other app happens to hold. A PDF you
    cannot capture is a worse answer than one you can capture but not
    preview."""
    _files_in(tmp_path, monkeypatch)
    card = client.post(
        "/api/capture/file",
        files={"file": ("report.pdf", b"%PDF-1.7", "application/pdf")},
    ).json()
    assert card["type"] == "file"
    # No title was sent, so the filename becomes it — a file card has no
    # preview, so its name is all there is to show.
    assert card["title"] == "report.pdf"
    assert card["payload"]["file_mime"] == "application/pdf"
    assert card["payload"]["file_bytes"] == len(b"%PDF-1.7")


def test_capture_file_refuses_something_too_large(client, admin, tmp_path, monkeypatch):
    _files_in(tmp_path, monkeypatch)
    from app.routers import tokens as tokens_router

    monkeypatch.setattr(tokens_router, "MAX_IMAGE_BYTES", 8)
    resp = client.post(
        "/api/capture/file",
        files={"file": ("big.png", b"far too many bytes", "image/png")},
    )
    assert resp.status_code == 413
    # The half-written file is cleaned up rather than left behind.
    assert list(tmp_path.iterdir()) == []


def test_capture_file_needs_authentication(client, admin, tmp_path, monkeypatch):
    _files_in(tmp_path, monkeypatch)
    from app.main import app
    from fastapi.testclient import TestClient

    with TestClient(app) as anon:
        resp = anon.post(
            "/api/capture/file",
            files={"file": ("photo.png", b"png", "image/png")},
        )
    assert resp.status_code == 401


def test_card_shape_is_pure():
    assert card_shape_for("hello")["type"] == "text"
    assert card_shape_for("  https://x.com/a  ")["type"] == "link"
    assert card_shape_for(None, "https://youtube.com/watch?v=dQw4w9WgXcQ")["type"] == "youtube"
    assert card_shape_for("")["body"] is None


def test_spotify_share_with_comment_stays_a_text_card():
    url = "https://open.spotify.com/track/6txWz9UapYHVxEd7dDIHXT?si=test"
    shape = card_shape_for("For the road trip", url)
    assert shape["type"] == "text"
    assert shape["body"] == f"For the road trip\n\n{url}"


def test_youtube_share_with_comment_stays_a_text_card():
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    shape = card_shape_for("This explains the idea", url)
    assert shape["type"] == "text"
    assert shape["body"] == f"This explains the idea\n\n{url}"


def test_api_token_auth_and_revocation(client, admin):
    created = client.post("/api/tokens", json={"name": "phone"}).json()
    token = created["token"]
    assert token.startswith("cnv_")

    # A fresh client with no cookie, using only the bearer token.
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as bare:
        headers = {"Authorization": f"Bearer {token}"}
        assert bare.get("/api/me", headers=headers).json()["email"] == "admin@example.com"
        resp = bare.post("/api/capture", json={"text": "via token"}, headers=headers)
        assert resp.status_code == 201

        assert bare.get("/api/me").status_code == 401
        assert bare.get("/api/me", headers={"Authorization": "Bearer cnv_bogus"}).status_code == 401

        client.delete(f"/api/tokens/{created['id']}")
        assert bare.get("/api/me", headers=headers).status_code == 401


def test_tokens_are_listed_without_the_secret(client, admin):
    client.post("/api/tokens", json={"name": "laptop"})
    listed = client.get("/api/tokens").json()
    assert len(listed) == 1
    assert "token" not in listed[0]


def test_tokens_are_user_scoped(client, admin, second_client):
    created = client.post("/api/tokens", json={"name": "mine"}).json()
    assert second_client.get("/api/tokens").json() == []
    assert second_client.delete(f"/api/tokens/{created['id']}").status_code == 404
