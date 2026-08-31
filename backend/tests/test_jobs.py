import uuid

from sqlalchemy import select

from app import jobs
from app.models import Card, Job
from tests.conftest import requires_db

pytestmark = requires_db


def test_link_card_create_enqueues_unfurl(client, admin):
    created = client.post(
        "/api/cards",
        json={"type": "link", "payload": {"url": "https://example.com/article"}},
    ).json()
    assert created["card"]["payload"]["unfurl_status"] == "queued"

    from app.db import SessionLocal

    with SessionLocal() as db:
        job = db.scalar(select(Job).where(Job.kind == "unfurl"))
        assert job is not None
        assert job.payload["card_id"] == created["card"]["id"]


def test_youtube_id_extracted_on_create(client, admin):
    created = client.post(
        "/api/cards",
        json={
            "type": "youtube",
            "payload": {"url": "https://youtu.be/dQw4w9WgXcQ"},
        },
    ).json()
    assert created["card"]["payload"]["video_id"] == "dQw4w9WgXcQ"


def test_patch_converts_text_card_to_youtube_and_unfurls(client, admin):
    created = client.post(
        "/api/cards", json={"type": "text", "body": "https://youtu.be/dQw4w9WgXcQ"}
    ).json()
    patched = client.patch(
        f"/api/cards/{created['card']['id']}",
        json={
            "type": "youtube",
            "body": None,
            "payload": {"url": "https://youtu.be/dQw4w9WgXcQ"},
        },
    ).json()
    assert patched["type"] == "youtube"
    assert patched["payload"]["video_id"] == "dQw4w9WgXcQ"
    assert patched["payload"]["unfurl_status"] == "queued"


def test_text_card_create_enqueues_nothing(client, admin):
    client.post("/api/cards", json={"type": "text", "body": "no jobs"})
    from app.db import SessionLocal

    with SessionLocal() as db:
        assert db.scalar(select(Job)) is None


def test_text_card_with_spotify_link_stays_a_note_and_enqueues_unfurl(client, admin):
    url = "https://open.spotify.com/track/6txWz9UapYHVxEd7dDIHXT?si=test"
    created = client.post(
        "/api/cards",
        json={"type": "text", "body": f"Play this on the drive\n\n{url}"},
    ).json()["card"]
    assert created["type"] == "text"
    assert created["payload"]["spotify_url"] == url
    assert created["payload"]["spotify_status"] == "queued"


def test_spotify_unfurl_adds_safe_footer_metadata(client, admin, monkeypatch):
    url = "https://open.spotify.com/track/6txWz9UapYHVxEd7dDIHXT?si=test"
    created = client.post(
        "/api/cards",
        json={"type": "text", "body": f"A song for this scene\n{url}"},
    ).json()["card"]

    def fake_get(endpoint):
        assert endpoint.startswith("https://open.spotify.com/oembed?url=")
        return endpoint, b'{"title":"The Adults Are Talking","thumbnail_url":"https://i.scdn.co/cover.jpg"}'

    monkeypatch.setattr(jobs, "guarded_get", fake_get)
    assert jobs.run_one(["unfurl"]) is True

    from app.db import SessionLocal

    with SessionLocal() as db:
        card = db.get(Card, uuid.UUID(created["id"]))
        assert card.payload["spotify_status"] == "done"
        assert card.payload["spotify"] == {
            "url": url,
            "title": "The Adults Are Talking",
            "thumbnail_url": "https://i.scdn.co/cover.jpg",
            "kind": "Track",
        }


def test_text_card_with_youtube_link_gets_footer_metadata(client, admin, monkeypatch):
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    created = client.post(
        "/api/cards",
        json={"type": "text", "body": f"Useful explanation\n\n{url}"},
    ).json()["card"]
    assert created["type"] == "text"
    assert created["payload"]["youtube_url"] == url

    def fake_get(requested):
        assert requested == url
        return url, b'<html><head><title>Video title</title><meta property="og:image" content="https://img.youtube.com/thumb.jpg"></head></html>'

    monkeypatch.setattr(jobs, "guarded_get", fake_get)
    assert jobs.run_one(["unfurl"]) is True

    from app.db import SessionLocal

    with SessionLocal() as db:
        card = db.get(Card, uuid.UUID(created["id"]))
        assert card.payload["youtube_status"] == "done"
        assert card.payload["youtube"]["url"] == url
        assert card.payload["youtube"]["title"] == "Video title"


def test_worker_claims_only_supported_kinds(client, admin):
    from app.db import SessionLocal

    with SessionLocal() as db:
        card = Card(owner_id=uuid.UUID(admin["id"]), type="audio")
        db.add(card)
        db.flush()
        jobs.enqueue(db, "transcribe", {"card_id": str(card.id), "file_id": str(uuid.uuid4())})
        db.commit()

    # An unfurl-only worker drains nothing: the transcribe job stays queued.
    assert jobs.run_one(["unfurl"]) is False
    with SessionLocal() as db:
        job = db.scalar(select(Job))
        assert job.status == "queued"


def test_failed_job_retries_then_parks(client, admin, monkeypatch):
    from app.db import SessionLocal

    def explode(db, payload):
        raise RuntimeError("boom")

    monkeypatch.setitem(jobs.HANDLERS, "unfurl", explode)
    with SessionLocal() as db:
        jobs.enqueue(db, "unfurl", {"card_id": str(uuid.uuid4())})
        db.commit()

    for _ in range(jobs.MAX_ATTEMPTS):
        # Force the retry delay to zero so the test doesn't wait.
        with SessionLocal() as db:
            job = db.scalar(select(Job))
            if job.status == "queued":
                job.run_at = job.created_at
                db.commit()
        jobs.run_one(["unfurl"])

    with SessionLocal() as db:
        job = db.scalar(select(Job))
        assert job.status == "error"
        assert job.attempts == jobs.MAX_ATTEMPTS
        assert "boom" in job.last_error


def test_unfurl_handler_marks_blocked_url_as_error(client, admin):
    created = client.post(
        "/api/cards",
        json={"type": "link", "payload": {"url": "http://127.0.0.1/admin"}},
    ).json()
    assert jobs.run_one(["unfurl"]) is True

    from app.db import SessionLocal

    with SessionLocal() as db:
        card = db.get(Card, uuid.UUID(created["card"]["id"]))
        assert card.payload["unfurl_status"] == "error"
        job = db.scalar(select(Job))
        assert job.status == "done"  # blocked URLs are not retried
