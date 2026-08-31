import os

os.environ.setdefault(
    "DATABASE_URL",
    os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://canvas:canvas@localhost:5432/canvas_test"),
)
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("SESSION_SECRET", "test-secret")
# The queue tests drive jobs by hand; the inline worker would race them.
os.environ["WORKER_INLINE"] = "false"

import pytest
from sqlalchemy import text

from app.db import engine  # noqa: E402


def _db_available() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
        return True
    except Exception:
        return False


DB_AVAILABLE = _db_available()

if DB_AVAILABLE:
    from alembic import command
    from alembic.config import Config as AlembicConfig

    cfg = AlembicConfig(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option(
        "script_location", os.path.join(os.path.dirname(__file__), "..", "alembic")
    )
    command.upgrade(cfg, "head")


requires_db = pytest.mark.skipif(
    not DB_AVAILABLE, reason="Postgres not reachable at DATABASE_URL"
)


@pytest.fixture(autouse=True)
def clean_db():
    if not DB_AVAILABLE:
        yield
        return
    # Settings are cached briefly across processes; a truncated table must not
    # leave a stale config behind for the next test.
    from app import runtime_settings

    runtime_settings.invalidate_cache()
    with engine.begin() as conn:
        conn.execute(
            text(
                "truncate public_lens_assets, public_lenses, jobs, files, links, placements, cards, canvas_members, "
                "canvases, api_tokens, bot_identities, pairing_codes, "
                "app_settings, sessions, invites, users cascade"
            )
        )
    yield


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


def register(client, email, password="password123", display_name="User", invite_code=None):
    return client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": password,
            "display_name": display_name,
            "invite_code": invite_code,
        },
    )


@pytest.fixture()
def admin(client):
    resp = register(client, "admin@example.com", display_name="Admin")
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.fixture()
def second_client(admin, client):
    """A separate authenticated client for a second, invited user."""
    from fastapi.testclient import TestClient

    from app.main import app

    invite = client.post("/api/invites", json={"expires_in_days": 7}).json()
    with TestClient(app) as c2:
        resp = register(
            c2, "second@example.com", display_name="Second", invite_code=invite["code"]
        )
        assert resp.status_code == 201, resp.text
        yield c2
