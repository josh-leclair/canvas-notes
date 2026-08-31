"""Bot pairing and capture, driven through the platform-agnostic handler."""
from sqlalchemy import select

from app.bots.base import PAIRING_HINT, IncomingMessage, handle_message
from app.bots.discord import DiscordAdapter
from app.bots.telegram import TelegramAdapter
from app.models import BotIdentity, Card
from tests.conftest import requires_db

pytestmark = requires_db

SENDER = "telegram-user-123"


def msg(text=None, audio=None, image=None, unsupported=None, sender=SENDER):
    return IncomingMessage(
        platform_user_id=sender,
        text=text,
        audio=audio,
        image=image,
        unsupported=unsupported,
    )


def pair(client):
    code = client.post("/api/pairing-codes").json()["code"]
    handle_message("telegram", msg(code))


def test_unpaired_sender_captures_nothing(client, admin):
    reply = handle_message("telegram", msg("here is a thought"))
    assert reply == PAIRING_HINT
    assert client.get("/api/inbox").json()["items"] == []


def test_pairing_then_capture(client, admin):
    code = client.post("/api/pairing-codes").json()["code"]

    reply = handle_message("telegram", msg(code))
    assert "Paired" in reply

    reply = handle_message("telegram", msg("https://example.com/read-later"))
    assert "Captured" in reply

    inbox = client.get("/api/inbox").json()["items"]
    assert len(inbox) == 1
    assert inbox[0]["type"] == "link"
    assert inbox[0]["payload"]["url"] == "https://example.com/read-later"


def test_pairing_code_is_single_use(client, admin):
    code = client.post("/api/pairing-codes").json()["code"]
    assert "Paired" in handle_message("telegram", msg(code))
    # A different sender cannot reuse the same code.
    assert handle_message("telegram", msg(code, sender="someone-else")) == PAIRING_HINT


def test_pairing_is_per_platform(client, admin):
    code = client.post("/api/pairing-codes").json()["code"]
    handle_message("telegram", msg(code))
    # Same platform_user_id on another platform is a different identity.
    assert handle_message("discord", msg("a thought")) == PAIRING_HINT


def test_bad_code_does_not_pair(client, admin):
    assert handle_message("telegram", msg("NOTACODE")) == PAIRING_HINT
    from app.db import SessionLocal

    with SessionLocal() as db:
        assert db.scalar(select(BotIdentity)) is None


def test_audio_capture_queues_transcription(client, admin, tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    code = client.post("/api/pairing-codes").json()["code"]
    handle_message("telegram", msg(code))

    reply = handle_message("telegram", msg(audio=(b"fake-ogg-bytes", "audio/ogg")))
    assert "Voice note" in reply

    from app.db import SessionLocal

    with SessionLocal() as db:
        card = db.scalar(select(Card).where(Card.type == "audio"))
        assert card.payload["transcript_status"] == "queued"


def test_image_capture_makes_an_image_card(client, admin, tmp_path, monkeypatch):
    """The bot's card has to be the same shape as one dragged onto the canvas,
    or crop, transparency and the lightbox all miss it."""
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    pair(client)

    reply = handle_message(
        "telegram", msg(text="a chart", image=(b"fake-png-bytes", "image/png"))
    )
    assert "Image captured" in reply

    inbox = client.get("/api/inbox").json()["items"]
    assert len(inbox) == 1
    card = inbox[0]
    assert card["type"] == "image"
    assert card["title"] == "a chart"
    assert card["payload"]["image_mime"] == "image/png"

    # The file is real, stored under the extension the web upload would use,
    # and reachable by the same route the canvas fetches it from.
    file_id = card["payload"]["image_file_id"]
    assert client.get(f"/api/files/{file_id}").content == b"fake-png-bytes"
    assert (tmp_path / f"{file_id}.png").exists()


def test_a_captioned_photo_is_not_filed_as_text(client, admin, tmp_path, monkeypatch):
    """The reported bug. A photo with a caption fell through to the text
    branch, so the caption became a text card, the picture was discarded, and
    the reply said it had worked."""
    from app.config import settings

    monkeypatch.setattr(settings, "files_dir", str(tmp_path))
    pair(client)

    handle_message(
        "telegram", msg(text="look at this", image=(b"png", "image/png"))
    )
    (card,) = client.get("/api/inbox").json()["items"]
    assert card["type"] == "image"
    assert card["payload"].get("image_file_id")


def test_unsupported_attachments_are_refused_out_loud(client, admin):
    """The other half of the bug: a photo with no caption produced no reply at
    all, which is exactly what a bot that has crashed looks like."""
    pair(client)

    reply = handle_message("telegram", msg(unsupported="video"))
    assert reply == "I can't capture video yet."
    assert client.get("/api/inbox").json()["items"] == []


def test_identities_are_listed_and_removable(client, admin):
    code = client.post("/api/pairing-codes").json()["code"]
    handle_message("telegram", msg(code))

    identities = client.get("/api/bot-identities").json()
    assert len(identities) == 1
    assert identities[0]["platform"] == "telegram"

    client.delete(f"/api/bot-identities/{identities[0]['id']}")
    assert client.get("/api/bot-identities").json() == []
    # Unpaired again.
    assert handle_message("telegram", msg("hello")) == PAIRING_HINT


def incoming(message):
    """Drive the real adapter's parsing without a token or a network.

    Built with `__new__` so `__init__` does not demand a bot token, and with
    `_download` replaced on the instance — the parsing is where the traps are
    (the size array, the branch ordering), and none of it needs Telegram to be
    reachable. Deliberately the real class rather than a stand-in, so the test
    cannot drift away from what actually runs.
    """
    bot = TelegramAdapter.__new__(TelegramAdapter)
    asked: list[tuple[str, int]] = []

    def fake_download(client, file_id, limit):
        asked.append((file_id, limit))
        return b"bytes"

    bot._download = fake_download
    return asked, bot._to_incoming(None, message)


BASE = {"from": {"id": 7}, "chat": {"id": 7}}


def test_photo_takes_the_largest_size_offered():
    """Telegram sends a photo as an array of sizes, thumbnail first. Taking
    the first entry captures a postage stamp."""
    asked, msg_in = incoming(
        {
            **BASE,
            "photo": [
                {"file_id": "thumb", "width": 90},
                {"file_id": "middle", "width": 320},
                {"file_id": "original", "width": 1280},
            ],
            "caption": "the chart",
        }
    )
    assert asked == [("original", 25 * 1024 * 1024)]
    assert msg_in.image == (b"bytes", "image/jpeg")
    assert msg_in.text == "the chart"


def test_an_image_sent_as_a_file_keeps_its_own_type():
    """The document route is the one that survives transparency: the photo
    route is re-encoded to JPEG by Telegram."""
    _asked, msg_in = incoming(
        {**BASE, "document": {"file_id": "doc", "mime_type": "image/png"}}
    )
    assert msg_in.image == (b"bytes", "image/png")
    assert msg_in.unsupported is None


def test_a_document_that_is_not_an_image_is_refused_not_swallowed():
    _asked, msg_in = incoming(
        {
            **BASE,
            "document": {"file_id": "doc", "mime_type": "application/pdf"},
            "caption": "the report",
        }
    )
    assert msg_in.image is None
    # Crucially not captured as a text card built from the caption.
    assert msg_in.text is None
    assert msg_in.unsupported == "files"


def test_audio_is_measured_against_the_audio_ceiling():
    asked, msg_in = incoming(
        {**BASE, "voice": {"file_id": "v", "mime_type": "audio/ogg"}}
    )
    assert asked == [("v", 50 * 1024 * 1024)]
    assert msg_in.audio == (b"bytes", "audio/ogg")


def test_plain_text_still_goes_straight_through():
    _asked, msg_in = incoming({**BASE, "text": "just a thought"})
    assert msg_in.text == "just a thought"
    assert msg_in.image is None and msg_in.unsupported is None


def test_a_message_with_nothing_in_it_still_answers():
    _asked, msg_in = incoming({**BASE})
    assert msg_in.unsupported == "that"


def test_adapter_configuration_gates():
    from app.config import settings

    assert TelegramAdapter.configured() is bool(settings.telegram_bot_token)
    # Discord is a foundation stub: never started, even with a token set.
    assert DiscordAdapter.configured() is False
