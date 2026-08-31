from app import jobs
from tests.conftest import requires_db

pytestmark = requires_db


def test_ai_status_reports_unconfigured_instance(client, admin):
    data = client.get("/api/ai/status").json()
    assert data["embeddings"]["configured"] is False
    assert data["embeddings"]["dim"] == 768
    assert data["transcription"]["mode"] in ("local", "unavailable")
    assert data["search_modes"] == ["text"]


def test_ai_test_refused_without_endpoint(client, admin):
    resp = client.post("/api/ai/test")
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "embeddings_unavailable"


def test_remote_whisper_takes_precedence():
    from app.runtime_settings import AiConfig

    local = AiConfig(whisper_base_url="")
    assert jobs.transcription_mode(local) in ("local", "unavailable")

    # A configured endpoint makes transcription available even where
    # faster-whisper is not installed.
    remote = AiConfig(whisper_base_url="http://whisper.local/v1")
    assert jobs.transcription_mode(remote) == "remote"
    assert jobs.transcription_available(remote) is True


def test_saved_whisper_endpoint_reaches_the_worker(client, admin):
    """Changing the endpoint in the app must change what the queue accepts,
    without restarting the worker."""
    from app import runtime_settings

    runtime_settings.invalidate_cache()
    client.put("/api/ai/settings", json={"whisper_base_url": "http://whisper.local/v1"})
    runtime_settings.invalidate_cache()
    assert "transcribe" in jobs.supported_kinds()
    assert client.get("/api/ai/status").json()["transcription"]["mode"] == "remote"
