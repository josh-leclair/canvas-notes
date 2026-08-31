"""Settings that can be changed in the app rather than only in .env."""
from sqlalchemy import select

from app import runtime_settings
from app.crypto import decrypt, encrypt
from app.models import AppSetting
from tests.conftest import requires_db

pytestmark = requires_db


def test_encryption_round_trip():
    secret = "sk-not-a-real-key"
    stored = encrypt(secret)
    assert stored.startswith("enc:")
    assert secret not in stored
    assert decrypt(stored) == secret
    assert decrypt("") == ""
    # Plain values (seeded from the environment) pass through untouched.
    assert decrypt("plain-value") == "plain-value"


def test_bad_ciphertext_reads_as_unset(monkeypatch):
    from app.config import settings

    stored = encrypt("secret")
    monkeypatch.setattr(settings, "session_secret", "a-completely-different-secret")
    # A rotated SESSION_SECRET must not crash every job that reads a key.
    assert decrypt(stored) == ""


def test_database_overrides_environment(client, admin, monkeypatch):
    from app.config import settings
    from app.db import SessionLocal

    monkeypatch.setattr(settings, "embedding_base_url", "http://from-env/v1")
    monkeypatch.setattr(settings, "embedding_model", "env-model")
    runtime_settings.invalidate_cache()

    with SessionLocal() as db:
        assert runtime_settings.get_ai_config(db).embedding_model == "env-model"

    resp = client.put(
        "/api/ai/settings",
        json={"embedding_base_url": "http://from-db/v1", "embedding_model": "db-model"},
    )
    assert resp.status_code == 200
    runtime_settings.invalidate_cache()

    with SessionLocal() as db:
        config = runtime_settings.get_ai_config(db)
        assert config.embedding_base_url == "http://from-db/v1"
        assert config.embedding_model == "db-model"


def test_cleared_value_falls_back_to_environment(client, admin, monkeypatch):
    from app.config import settings
    from app.db import SessionLocal

    monkeypatch.setattr(settings, "whisper_model", "env-whisper")
    client.put("/api/ai/settings", json={"whisper_model": "db-whisper"})
    runtime_settings.invalidate_cache()
    with SessionLocal() as db:
        assert runtime_settings.get_ai_config(db).whisper_model == "db-whisper"

    client.put("/api/ai/settings", json={"whisper_model": ""})
    runtime_settings.invalidate_cache()
    with SessionLocal() as db:
        assert runtime_settings.get_ai_config(db).whisper_model == "env-whisper"


def test_api_keys_are_encrypted_at_rest(client, admin):
    from app.db import SessionLocal

    client.put("/api/ai/settings", json={"embedding_api_key": "sk-secret-value"})
    with SessionLocal() as db:
        row = db.scalar(select(AppSetting).where(AppSetting.key == "ai"))
        assert "sk-secret-value" not in str(row.value)
        assert row.value["embedding_api_key"].startswith("enc:")

    # And the API never hands the key back.
    status = client.get("/api/ai/status").json()
    assert status["embeddings"]["api_key_set"] is True
    assert "api_key" not in str(status["embeddings"].get("base_url", ""))
    assert "sk-secret-value" not in str(status)


def test_settings_are_admin_only(client, admin, second_client):
    assert second_client.get("/api/ai/status").status_code == 200
    resp = second_client.put("/api/ai/settings", json={"embedding_model": "sneaky"})
    assert resp.status_code == 403
    assert second_client.post("/api/ai/test", json={}).status_code == 403


def test_dimension_change_needs_confirmation(client, admin):
    resp = client.put(
        "/api/ai/settings",
        json={
            "embedding_base_url": "http://x/v1",
            "embedding_model": "m",
            "embedding_dim": 1024,
        },
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "dimension_change_requires_confirmation"

    # Unchanged until confirmed.
    assert client.get("/api/ai/status").json()["embeddings"]["dim"] == 768

    resp = client.put(
        "/api/ai/settings",
        json={
            "embedding_base_url": "http://x/v1",
            "embedding_model": "m",
            "embedding_dim": 1024,
            "confirm_reembed": True,
        },
    )
    assert resp.status_code == 200
    assert resp.json()["embeddings"]["dim"] == 1024


def test_dimension_change_resizes_the_column(client, admin):
    from sqlalchemy import text

    from app.db import SessionLocal

    client.put(
        "/api/ai/settings",
        json={"embedding_dim": 384, "confirm_reembed": True},
    )
    with SessionLocal() as db:
        # The vector column and its index survive the resize.
        dim = db.scalar(
            text("""
                select a.atttypmod
                from pg_attribute a
                join pg_class c on c.oid = a.attrelid
                where c.relname = 'cards' and a.attname = 'embedding'
            """)
        )
        assert dim == 384
        assert db.scalar(
            text("select count(*) from pg_indexes where indexname = 'cards_embedding_idx'")
        ) == 1

    # Put it back so later tests see the default.
    client.put("/api/ai/settings", json={"embedding_dim": 768, "confirm_reembed": True})


def test_status_reports_env_seeded_fields(client, admin, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "embedding_base_url", "http://seeded/v1")
    runtime_settings.invalidate_cache()
    seeded = client.get("/api/ai/status").json()["env_seeded"]
    assert "embedding_base_url" in seeded
