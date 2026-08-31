import pytest

from tests.conftest import register, requires_db

pytestmark = requires_db


@pytest.fixture()
def shared(client, admin, second_client):
    """A canvas owned by admin with one card, shared with the second user."""
    canvas = client.post("/api/canvases", json={"name": "Shared"}).json()
    created = client.post(
        "/api/cards",
        json={"title": "on the board", "canvas_id": canvas["id"], "x": 0, "y": 0},
    ).json()
    second = second_client.get("/api/me").json()
    return {
        "canvas": canvas,
        "card": created["card"],
        "placement": created["placement"],
        "second": second,
    }


def share(client, canvas_id, email, role="viewer"):
    resp = client.post(
        f"/api/canvases/{canvas_id}/members", json={"email": email, "role": role}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_unshared_canvas_is_invisible(client, admin, second_client, shared):
    assert second_client.get("/api/canvases").json() == []
    assert second_client.get(f"/api/canvases/{shared['canvas']['id']}").status_code == 404


def test_viewer_can_read_but_not_write(client, admin, second_client, shared):
    share(client, shared["canvas"]["id"], shared["second"]["email"], "viewer")

    listed = second_client.get("/api/canvases").json()
    assert len(listed) == 1 and listed[0]["role"] == "viewer"

    detail = second_client.get(f"/api/canvases/{shared['canvas']['id']}").json()
    assert detail["role"] == "viewer"
    assert len(detail["placements"]) == 1

    # Writes are refused with 403: the viewer already knows it exists.
    assert second_client.patch(
        f"/api/placements/{shared['placement']['id']}", json={"x": 99}
    ).status_code == 403
    assert second_client.delete(
        f"/api/placements/{shared['placement']['id']}"
    ).status_code == 403
    assert second_client.patch(
        f"/api/cards/{shared['card']['id']}", json={"title": "hijacked"}
    ).status_code == 403
    assert second_client.post(
        "/api/cards",
        json={"body": "mine", "canvas_id": shared["canvas"]["id"], "x": 1, "y": 1},
    ).status_code == 403


def test_editor_can_write_but_not_administer(client, admin, second_client, shared):
    share(client, shared["canvas"]["id"], shared["second"]["email"], "editor")

    assert second_client.patch(
        f"/api/placements/{shared['placement']['id']}", json={"x": 42}
    ).status_code == 200
    assert second_client.patch(
        f"/api/cards/{shared['card']['id']}", json={"title": "collaboratively edited"}
    ).status_code == 200
    assert second_client.post(
        "/api/cards",
        json={"body": "added by editor", "canvas_id": shared["canvas"]["id"], "x": 5, "y": 5},
    ).status_code == 201

    # Administration stays with the owner.
    assert second_client.patch(
        f"/api/canvases/{shared['canvas']['id']}", json={"name": "renamed"}
    ).status_code == 403
    assert second_client.delete(f"/api/canvases/{shared['canvas']['id']}").status_code == 403
    assert second_client.post(
        f"/api/canvases/{shared['canvas']['id']}/members",
        json={"email": "someone@example.com"},
    ).status_code == 403


def test_only_owner_deletes_a_card(client, admin, second_client, shared):
    share(client, shared["canvas"]["id"], shared["second"]["email"], "editor")
    assert second_client.delete(f"/api/cards/{shared['card']['id']}").status_code == 403
    assert client.delete(f"/api/cards/{shared['card']['id']}").status_code == 204


def test_shared_card_does_not_enter_the_other_users_inbox(
    client, admin, second_client, shared
):
    share(client, shared["canvas"]["id"], shared["second"]["email"], "editor")
    assert second_client.get("/api/inbox").json()["items"] == []


def test_link_visible_only_when_both_endpoints_are(
    client, admin, second_client, shared
):
    private = client.post("/api/cards", json={"title": "private note"}).json()["card"]
    shared_card = shared["card"]
    share(client, shared["canvas"]["id"], shared["second"]["email"], "viewer")

    # admin links their private card to the shared one.
    client.post(
        "/api/links",
        json={"source_card_id": private["id"], "target_card_id": shared_card["id"]},
    )

    # The other user can see the shared card but not the private endpoint, so
    # the link stays hidden: private titles must not appear as incoming arrows.
    reveal = second_client.get(f"/api/cards/{shared_card['id']}/reveal").json()
    assert reveal["links"] == []
    assert private["id"] not in reveal["cards"]

    # The owner sees it normally.
    own = client.get(f"/api/cards/{shared_card['id']}/reveal").json()
    assert len(own["links"]) == 1


def test_viewer_may_link_their_own_card_to_a_shared_one(
    client, admin, second_client, shared
):
    share(client, shared["canvas"]["id"], shared["second"]["email"], "viewer")
    mine = second_client.post("/api/cards", json={"title": "my response"}).json()["card"]

    resp = second_client.post(
        "/api/links",
        json={"source_card_id": mine["id"], "target_card_id": shared["card"]["id"]},
    )
    assert resp.status_code == 201, resp.text

    # Visible to its creator...
    assert len(second_client.get(f"/api/cards/{mine['id']}/reveal").json()["links"]) == 1
    # ...and hidden from the canvas owner, who cannot see the other endpoint.
    assert client.get(f"/api/cards/{shared['card']['id']}/reveal").json()["links"] == []


def test_only_the_creator_edits_a_link(client, admin, second_client, shared):
    share(client, shared["canvas"]["id"], shared["second"]["email"], "editor")
    other = client.post(
        "/api/cards",
        json={"title": "second card", "canvas_id": shared["canvas"]["id"], "x": 9, "y": 9},
    ).json()["card"]
    link = client.post(
        "/api/links",
        json={"source_card_id": shared["card"]["id"], "target_card_id": other["id"]},
    ).json()

    # The editor can see the link (both endpoints visible) but not change it.
    reveal = second_client.get(f"/api/cards/{shared['card']['id']}/reveal").json()
    assert [l["id"] for l in reveal["links"]] == [link["id"]]
    assert second_client.patch(
        f"/api/links/{link['id']}", json={"note": "not mine to write"}
    ).status_code == 403
    assert second_client.delete(f"/api/links/{link['id']}").status_code == 403


def test_unsharing_revokes_immediately(client, admin, second_client, shared):
    share(client, shared["canvas"]["id"], shared["second"]["email"], "viewer")
    assert second_client.get(f"/api/canvases/{shared['canvas']['id']}").status_code == 200

    client.delete(
        f"/api/canvases/{shared['canvas']['id']}/members/{shared['second']['id']}"
    )
    assert second_client.get(f"/api/canvases/{shared['canvas']['id']}").status_code == 404
    assert second_client.get(f"/api/cards/{shared['card']['id']}/placements").status_code == 404


def test_unshare_hides_the_other_users_link(
    client, admin, second_client, shared
):
    share(client, shared["canvas"]["id"], shared["second"]["email"], "viewer")
    mine = second_client.post("/api/cards", json={"title": "my note"}).json()["card"]
    second_client.post(
        "/api/links",
        json={"source_card_id": mine["id"], "target_card_id": shared["card"]["id"]},
    )

    client.delete(
        f"/api/canvases/{shared['canvas']['id']}/members/{shared['second']['id']}"
    )

    # Losing access hides the link without deleting either card.
    reveal = second_client.get(f"/api/cards/{mine['id']}/reveal").json()
    assert reveal["links"] == []  # target no longer visible, so the link hides
    assert shared["card"]["id"] not in reveal["cards"]


def test_deleting_a_card_with_foreign_links_proceeds(client, admin, second_client, shared):
    share(client, shared["canvas"]["id"], shared["second"]["email"], "viewer")
    mine = second_client.post("/api/cards", json={"title": "my note"}).json()["card"]
    second_client.post(
        "/api/links",
        json={"source_card_id": mine["id"], "target_card_id": shared["card"]["id"]},
    )

    # Nobody's delete is blocked by a stranger's reference.
    assert client.delete(f"/api/cards/{shared['card']['id']}").status_code == 204

    reveal = second_client.get(f"/api/cards/{mine['id']}/reveal").json()
    assert reveal["links"] == []


def test_leave_shared_canvas(client, admin, second_client, shared):
    share(client, shared["canvas"]["id"], shared["second"]["email"], "viewer")
    assert second_client.post(f"/api/canvases/{shared['canvas']['id']}/leave").status_code == 204
    assert second_client.get("/api/canvases").json() == []
    # The owner cannot leave their own canvas.
    assert client.post(f"/api/canvases/{shared['canvas']['id']}/leave").status_code == 409


def test_sharing_with_unknown_email(client, admin, shared):
    resp = client.post(
        f"/api/canvases/{shared['canvas']['id']}/members",
        json={"email": "nobody@example.com"},
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "no_such_user"


def test_role_change_and_member_list(client, admin, second_client, shared):
    share(client, shared["canvas"]["id"], shared["second"]["email"], "viewer")
    members = client.get(f"/api/canvases/{shared['canvas']['id']}/members").json()
    assert len(members) == 1 and members[0]["role"] == "viewer"

    client.patch(
        f"/api/canvases/{shared['canvas']['id']}/members/{shared['second']['id']}",
        json={"role": "editor"},
    )
    assert second_client.patch(
        f"/api/placements/{shared['placement']['id']}", json={"x": 7}
    ).status_code == 200
