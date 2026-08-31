from tests.conftest import requires_db

pytestmark = requires_db


def make_card(client, title, body="", canvas_id=None, x=0, y=0):
    payload = {"type": "text", "title": title, "body": body}
    if canvas_id:
        payload.update({"canvas_id": canvas_id, "x": x, "y": y})
    return client.post("/api/cards", json=payload).json()["card"]


def link(client, source, target, **kwargs):
    resp = client.post(
        "/api/links",
        json={"source_card_id": source["id"], "target_card_id": target["id"], **kwargs},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def reveal_ids(client, card, canvas_id=None):
    qs = f"?canvas_id={canvas_id}" if canvas_id else ""
    data = client.get(f"/api/cards/{card['id']}/reveal{qs}").json()
    return data


def test_link_metadata_never_blank(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Ctx"}).json()
    a = make_card(client, "A", body="alpha body", canvas_id=canvas["id"])
    b = make_card(client, "B", body="beta body", canvas_id=canvas["id"], x=100)
    l = link(client, a, b, created_on_canvas_id=canvas["id"])
    assert l["created_on_canvas_id"] == canvas["id"]
    assert l["source_snapshot"]["title"] == "A"
    assert l["source_snapshot"]["excerpt"] == "alpha body"
    assert l["target_snapshot"]["title"] == "B"
    assert l["created_at"] and l["updated_at"]


def test_self_link_rejected(client, admin):
    a = make_card(client, "A")
    resp = client.post(
        "/api/links", json={"source_card_id": a["id"], "target_card_id": a["id"]}
    )
    assert resp.status_code == 400


def test_link_type_validated(client, admin):
    a, b = make_card(client, "A"), make_card(client, "B")
    resp = client.post(
        "/api/links",
        json={"source_card_id": a["id"], "target_card_id": b["id"], "link_type": "likes"},
    )
    assert resp.status_code == 422
    link(client, a, b, link_type="contradicts")


def test_reveal_two_hops_direction_locked(client, admin):
    # root -> child -> grandchild        (visible: both links)
    # parent -> root, grandparent -> parent  (visible: both links)
    # child -> sibling_target? No: sideways cases below.
    root = make_card(client, "root")
    child = make_card(client, "child")
    grandchild = make_card(client, "grandchild")
    parent = make_card(client, "parent")
    grandparent = make_card(client, "grandparent")

    l1 = link(client, root, child)
    l2 = link(client, child, grandchild)
    l3 = link(client, parent, root)
    l4 = link(client, grandparent, parent)

    data = reveal_ids(client, root)
    hops = {l["id"]: l["hop"] for l in data["links"]}
    assert hops == {l1["id"]: 1, l3["id"]: 1, l2["id"]: 2, l4["id"]: 2}
    assert set(data["cards"].keys()) == {
        c["id"] for c in (root, child, grandchild, parent, grandparent)
    }


def test_hub_does_not_light_up_sideways(client, admin):
    # fifty notes point at one source. Selecting one of them must not reveal
    # the others through the shared hub: hop 2 from a child continues to the
    # child's children only, and from a parent to the parent's parents only.
    root = make_card(client, "note-0")
    hub = make_card(client, "popular source")
    link(client, root, hub)
    siblings = []
    for i in range(5):
        sib = make_card(client, f"note-{i + 1}")
        link(client, sib, hub)  # sideways: other parents of the hub
        siblings.append(sib)
    hub_source = make_card(client, "hub cites this")
    deeper = link(client, hub, hub_source)  # children of children: visible

    data = reveal_ids(client, root)
    revealed_cards = set(data["cards"].keys())
    assert root["id"] in revealed_cards
    assert hub["id"] in revealed_cards
    assert hub_source["id"] in revealed_cards
    for sib in siblings:
        assert sib["id"] not in revealed_cards
    hops = {l["id"]: l["hop"] for l in data["links"]}
    assert hops[deeper["id"]] == 2
    assert len(hops) == 2  # root->hub and hub->source, nothing sideways


def test_reveal_marks_ghosts_with_home_canvas(client, admin):
    here = client.post("/api/canvases", json={"name": "Here"}).json()
    elsewhere = client.post("/api/canvases", json={"name": "Elsewhere"}).json()
    a = make_card(client, "A", canvas_id=here["id"])
    b = make_card(client, "B", canvas_id=elsewhere["id"])
    inboxed = make_card(client, "unplaced")
    link(client, a, b)
    link(client, a, inboxed)

    data = reveal_ids(client, a, canvas_id=here["id"])
    entry_a = data["cards"][a["id"]]
    entry_b = data["cards"][b["id"]]
    entry_i = data["cards"][inboxed["id"]]
    assert entry_a["placement"] is not None
    assert entry_b["placement"] is None
    assert entry_b["home_canvas_name"] == "Elsewhere"
    assert entry_i["placement"] is None and entry_i["home_canvas_name"] is None


def test_deleted_endpoint_removes_the_link_instead_of_leaving_a_restore_entry(
    client, admin
):
    a = make_card(client, "A")
    b = make_card(client, "B", body="the important note")
    l = link(client, a, b, note="because reasons")
    client.delete(f"/api/cards/{b['id']}")

    data = reveal_ids(client, a)
    assert data["links"] == []
    assert b["id"] not in data["cards"]
    assert client.post(f"/api/links/{l['id']}/recreate?side=target").status_code == 404


def test_inline_card_references_create_and_remove_one_derived_link(client, admin):
    target = make_card(client, "Referenced")
    source = make_card(client, "Document")
    token = f"[Referenced](card:{target['id']})"

    assert client.patch(
        f"/api/cards/{source['id']}", json={"body": f"See {token} and {token}."}
    ).status_code == 200
    reveal = reveal_ids(client, source)
    assert len(reveal["links"]) == 1
    assert reveal["links"][0]["link_type"] == "references"
    assert reveal["links"][0]["target_card_id"] == target["id"]

    assert client.patch(
        f"/api/cards/{source['id']}", json={"body": "Reference removed."}
    ).status_code == 200
    assert reveal_ids(client, source)["links"] == []


def test_flip_link_swaps_endpoints_and_snapshots(client, admin):
    canvas = client.post("/api/canvases", json={"name": "Flip"}).json()
    a = make_card(client, "A", body="alpha body", canvas_id=canvas["id"])
    b = make_card(client, "B", body="beta body", canvas_id=canvas["id"], x=100)
    l = link(client, a, b, link_type="supports", note="because")

    flipped = client.post(f"/api/links/{l['id']}/flip")
    assert flipped.status_code == 200, flipped.text
    flipped = flipped.json()
    assert flipped["source_card_id"] == b["id"]
    assert flipped["target_card_id"] == a["id"]
    # The snapshots travel with the ids, or a tombstone would be captioned
    # with the wrong card.
    assert flipped["source_snapshot"]["title"] == "B"
    assert flipped["target_snapshot"]["title"] == "A"
    # Everything the link means is untouched.
    assert flipped["link_type"] == "supports"
    assert flipped["note"] == "because"
    assert flipped["id"] == l["id"]

    # The reveal follows: A now has an incoming link where it had an outgoing.
    data = reveal_ids(client, a, canvas["id"])
    assert [link_["source_card_id"] for link_ in data["links"]] == [b["id"]]

    # And flipping twice is where it started.
    again = client.post(f"/api/links/{l['id']}/flip").json()
    assert again["source_card_id"] == a["id"]
    assert again["source_snapshot"]["title"] == "A"


def test_flip_link_is_creator_only(client, admin, second_client):
    a, b = make_card(client, "A"), make_card(client, "B")
    l = link(client, a, b)
    assert second_client.post(f"/api/links/{l['id']}/flip").status_code == 404


def test_links_isolated_between_users(client, admin, second_client):
    a = make_card(client, "A")
    b = make_card(client, "B")
    l = link(client, a, b)

    assert second_client.patch(
        f"/api/links/{l['id']}", json={"note": "defaced"}
    ).status_code == 404
    assert second_client.delete(f"/api/links/{l['id']}").status_code == 404
    # Cannot link to someone else's card.
    mine = second_client.post("/api/cards", json={"title": "mine"}).json()["card"]
    resp = second_client.post(
        "/api/links", json={"source_card_id": mine["id"], "target_card_id": a["id"]}
    )
    assert resp.status_code == 404


def test_card_search(client, admin):
    make_card(client, "Truck transmission", body="fixing the gearbox")
    make_card(client, "Grocery list")
    hits = client.get("/api/cards/search?q=transmission").json()
    assert len(hits) == 1 and hits[0]["title"] == "Truck transmission"
    hits = client.get("/api/cards/search?q=gearbox").json()
    assert len(hits) == 1
