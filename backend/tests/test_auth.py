from tests.conftest import register, requires_db

pytestmark = requires_db


def test_fresh_instance_needs_setup(client):
    assert client.get("/api/bootstrap").json()["needs_setup"] is True


def test_first_registration_is_admin_then_registration_closes(client):
    resp = register(client, "first@example.com")
    assert resp.status_code == 201
    assert resp.json()["is_admin"] is True
    assert client.get("/api/bootstrap").json()["needs_setup"] is False

    resp = register(client, "walkin@example.com")
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "invite_required"


def test_invite_flow(client, admin):
    invite = client.post("/api/invites", json={"expires_in_days": 7}).json()
    assert len(invite["code"]) == 12

    resp = register(client, "invited@example.com", invite_code=invite["code"])
    assert resp.status_code == 201
    assert resp.json()["is_admin"] is False

    # The same code cannot be used twice.
    resp = register(client, "third@example.com", invite_code=invite["code"])
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "invite_used"


def test_bad_invite_code(client, admin):
    resp = register(client, "x@example.com", invite_code="NOTREALCODE1")
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "invite_invalid"


def test_email_taken(client, admin):
    invite = client.post("/api/invites", json={"expires_in_days": 7}).json()
    resp = register(client, "ADMIN@example.com", invite_code=invite["code"])
    # citext: case-insensitive duplicate.
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "email_taken"


def test_login_logout(client, admin):
    client.post("/api/auth/logout")
    assert client.get("/api/me").status_code == 401

    resp = client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "password123"},
    )
    assert resp.status_code == 200
    assert client.get("/api/me").json()["email"] == "admin@example.com"


def test_login_failure_is_uniform(client, admin):
    bad_pw = client.post(
        "/api/auth/login", json={"email": "admin@example.com", "password": "wrong!"}
    )
    unknown = client.post(
        "/api/auth/login", json={"email": "nobody@example.com", "password": "wrong!"}
    )
    assert bad_pw.status_code == unknown.status_code == 401
    assert bad_pw.json() == unknown.json()


def test_invites_are_admin_only(client, admin, second_client):
    assert second_client.get("/api/invites").status_code == 403
    assert second_client.post("/api/invites", json={}).status_code == 403
