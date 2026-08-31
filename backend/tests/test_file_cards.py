"""File cards: any attachment as an object on the canvas."""
import io

from app.routers.files import safe_extension, safe_name
from tests.conftest import requires_db

pytestmark = requires_db


def make_file_card(client, canvas_id=None):
    body = {"type": "file"}
    if canvas_id:
        body.update({"canvas_id": canvas_id, "x": 0, "y": 0})
    resp = client.post("/api/cards", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()["card"]


def upload(client, card_id, name="spec.pdf", data=b"%PDF-1.4 fake", mime="application/pdf"):
    return client.post(
        f"/api/cards/{card_id}/file",
        files={"file": (name, io.BytesIO(data), mime)},
    )


# --- the name and extension guards ---------------------------------------


def test_extensions_are_reduced_to_something_safe():
    assert safe_extension("report.pdf") == ".pdf"
    assert safe_extension("archive.tar.gz") == ".gz"
    assert safe_extension("noextension") == ""
    assert safe_extension(None) == ""
    # Nothing that could steer a path survives: the traversal is stripped to
    # its last segment, which here leaves no extension at all.
    assert safe_extension("evil.p/../hp") == ""
    assert safe_extension("shell.php/../x.png") == ".png"
    assert safe_extension("x." + "a" * 50) == "." + "a" * 10


def test_names_cannot_escape_a_path_or_a_header():
    assert safe_name("notes.txt") == "notes.txt"
    assert safe_name("../../etc/passwd") == "passwd"
    assert safe_name('say "hello".doc') == "say hello.doc"
    assert safe_name("") == "download"
    assert safe_name(None) == "download"


# --- upload ---------------------------------------------------------------


def test_uploading_records_name_type_and_size(client, admin):
    card = make_file_card(client)
    resp = upload(client, card["id"], name="Design History.doc", data=b"x" * 2048)
    assert resp.status_code == 201, resp.text
    payload = resp.json()["payload"]
    assert payload["file_name"] == "Design History.doc"
    assert payload["file_bytes"] == 2048
    assert payload["file_mime"] == "application/pdf"
    assert payload["file_id"]


def test_an_untitled_card_takes_the_filename(client, admin):
    card = make_file_card(client)
    assert client.post(
        f"/api/cards/{card['id']}/file",
        files={"file": ("Quarterly.xlsx", io.BytesIO(b"data"), "application/vnd.ms-excel")},
    ).json()["title"] == "Quarterly.xlsx"


def test_a_title_someone_wrote_is_left_alone(client, admin):
    card = client.post("/api/cards", json={"type": "file", "title": "The spec"}).json()["card"]
    assert upload(client, card["id"]).json()["title"] == "The spec"


def test_only_a_file_card_takes_a_file(client, admin):
    text = client.post("/api/cards", json={"body": "hello"}).json()["card"]
    resp = upload(client, text["id"])
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "not_file_card"


# --- download -------------------------------------------------------------


def test_an_attachment_is_never_rendered_in_place(client, admin):
    """Serving an upload inline from the app's own origin would let a scripted
    .svg or an .html run as though the app had written it."""
    card = make_file_card(client)
    file_id = upload(
        client, card["id"], name="payload.svg", data=b"<svg onload=alert(1)>",
        mime="image/svg+xml",
    ).json()["payload"]["file_id"]

    resp = client.get(f"/api/files/{file_id}")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/octet-stream"
    assert "attachment" in resp.headers["content-disposition"]
    assert "payload.svg" in resp.headers["content-disposition"]


def test_an_image_card_still_renders_inline(client, admin):
    """The rule above is about attachments; a picture is meant to be shown."""
    card = client.post("/api/cards", json={"type": "image"}).json()["card"]
    file_id = client.post(
        f"/api/cards/{card['id']}/image",
        files={"file": ("shot.png", io.BytesIO(b"\x89PNG\r\n\x1a\n"), "image/png")},
    ).json()["payload"]["image_file_id"]

    resp = client.get(f"/api/files/{file_id}")
    assert resp.headers["content-type"] == "image/png"
    assert "attachment" not in resp.headers.get("content-disposition", "")


def test_a_file_follows_its_card(client, admin, second_client):
    """Someone who cannot see the card cannot fetch what is attached to it."""
    card = make_file_card(client)
    file_id = upload(client, card["id"]).json()["payload"]["file_id"]
    assert client.get(f"/api/files/{file_id}").status_code == 200
    assert second_client.get(f"/api/files/{file_id}").status_code == 404
