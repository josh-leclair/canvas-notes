"""Telegram capture bot, long polling.

Polling is an outbound connection, so it works behind NAT with no port
forwarding, reverse proxy, or certificate. For a NAS user that may be the only
capture path that works at all.
"""
import logging
import threading

import httpx

from app.bots.base import IncomingMessage, handle_message
from app.config import settings
from app.media import ALLOWED_IMAGE, MAX_IMAGE_BYTES

log = logging.getLogger("bots.telegram")

POLL_TIMEOUT = 25

# Telegram's own `getFile` will not serve anything above 20MB, so the cap that
# matters is theirs; these only stop us asking for something we would then
# refuse to store. The limit has to travel with the *kind* rather than sit on
# the adapter, or a photo is measured against the audio ceiling.
MAX_AUDIO_BYTES = 50 * 1024 * 1024


class TelegramAdapter:
    platform = "telegram"

    @staticmethod
    def configured() -> bool:
        return bool(settings.telegram_bot_token)

    def __init__(self) -> None:
        self.base = f"https://api.telegram.org/bot{settings.telegram_bot_token}"
        self.file_base = f"https://api.telegram.org/file/bot{settings.telegram_bot_token}"
        self.offset = 0

    def run(self, stop: threading.Event) -> None:
        log.info("telegram bot polling")
        with httpx.Client(timeout=POLL_TIMEOUT + 10) as client:
            while not stop.is_set():
                try:
                    self._poll_once(client)
                except Exception:
                    log.exception("telegram poll failed")
                    stop.wait(5)

    def _poll_once(self, client: httpx.Client) -> None:
        resp = client.get(
            f"{self.base}/getUpdates",
            params={"offset": self.offset, "timeout": POLL_TIMEOUT},
        )
        resp.raise_for_status()
        for update in resp.json().get("result", []):
            self.offset = update["update_id"] + 1
            message = update.get("message") or update.get("channel_post")
            if not message:
                continue
            incoming = self._to_incoming(client, message)
            if incoming is None:
                continue
            reply = handle_message(self.platform, incoming)
            if reply:
                self._send(client, message["chat"]["id"], reply)

    def _to_incoming(
        self, client: httpx.Client, message: dict
    ) -> IncomingMessage | None:
        sender = message.get("from", {}).get("id")
        if sender is None:
            return None
        platform_user_id = str(sender)

        voice = message.get("voice") or message.get("audio")
        if voice:
            content = self._download(client, voice["file_id"], MAX_AUDIO_BYTES)
            if content is None:
                return None
            mime = voice.get("mime_type", "audio/ogg")
            return IncomingMessage(
                platform_user_id=platform_user_id,
                text=message.get("caption"),
                audio=(content, mime),
            )

        photo = self._photo_of(message)
        if photo is not None:
            file_id, mime = photo
            content = self._download(client, file_id, MAX_IMAGE_BYTES)
            if content is None:
                return None
            return IncomingMessage(
                platform_user_id=platform_user_id,
                # The caption becomes the card's title, which is the only
                # text an image card ever gets — and the only thing that
                # makes it findable.
                text=message.get("caption"),
                image=(content, mime),
            )

        # Every remaining attachment is refused *before* the text branch, and
        # that ordering is the whole point. Anything carrying a caption used
        # to fall through and be filed as a text card, which reported success
        # while dropping the attachment. Refusing is honest; a caption is not
        # a substitute for the thing it was attached to.
        unsupported = self._describe(message)
        if unsupported:
            return IncomingMessage(
                platform_user_id=platform_user_id, unsupported=unsupported
            )

        text = message.get("text") or message.get("caption")
        if text:
            return IncomingMessage(platform_user_id=platform_user_id, text=text)

        # Nothing recognisable at all. Say so rather than going quiet:
        # silence is what the bot looks like when it is down.
        return IncomingMessage(platform_user_id=platform_user_id, unsupported="that")

    @staticmethod
    def _photo_of(message: dict) -> tuple[str, str] | None:
        """The file id and mime of a picture, however it was sent.

        A photo arrives as an *array of sizes*, thumbnail first and original
        last, so the last entry is the one worth keeping — taking the first
        captures a postage stamp. Telegram re-encodes those to JPEG and does
        not say so, hence the hardcoded mime.

        Sending the same picture as a file instead makes it a `document`,
        which keeps its original bytes and reports its own mime — that is the
        route to use for anything with transparency, since the photo path
        would flatten it.
        """
        sizes = message.get("photo")
        if isinstance(sizes, list) and sizes:
            return sizes[-1]["file_id"], "image/jpeg"

        document = message.get("document")
        if isinstance(document, dict):
            mime = str(document.get("mime_type", "")).split(";")[0].strip().lower()
            if mime in ALLOWED_IMAGE:
                return document["file_id"], mime
        return None

    #: Everything the bot recognises but cannot yet turn into a card, named
    #: so the reply is about what was actually sent rather than a shrug.
    UNSUPPORTED = (
        ("document", "files"),
        ("video", "video"),
        ("video_note", "video notes"),
        ("sticker", "stickers"),
        ("animation", "GIFs"),
        ("location", "locations"),
        ("contact", "contacts"),
        ("poll", "polls"),
    )

    @classmethod
    def _describe(cls, message: dict) -> str | None:
        """What is attached that cannot be captured, or None if nothing is.

        Reached only after the audio and image branches, so a `document` here
        is one that is not a picture — an image sent as a file was taken by
        `_photo_of` already.
        """
        for key, label in cls.UNSUPPORTED:
            if message.get(key):
                return label
        return None

    def _download(
        self, client: httpx.Client, file_id: str, limit: int
    ) -> bytes | None:
        info = client.get(f"{self.base}/getFile", params={"file_id": file_id})
        info.raise_for_status()
        result = info.json().get("result", {})
        path = result.get("file_path")
        if not path or result.get("file_size", 0) > limit:
            return None
        blob = client.get(f"{self.file_base}/{path}")
        blob.raise_for_status()
        return blob.content

    def _send(self, client: httpx.Client, chat_id: int, text: str) -> None:
        try:
            client.post(
                f"{self.base}/sendMessage", json={"chat_id": chat_id, "text": text}
            )
        except Exception:
            log.warning("could not send telegram reply", exc_info=True)
