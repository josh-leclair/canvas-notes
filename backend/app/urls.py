"""Deciding a card's type from text.

Shared by the web app, the capture API, and every bot so all three produce
identical cards from the same paste.
"""
import re

from app.unfurl import youtube_video_id

URL_PATTERN = re.compile(r"^https?://\S+$", re.IGNORECASE)
FIRST_URL_PATTERN = re.compile(r"https?://\S+", re.IGNORECASE)
SPOTIFY_URL_PATTERN = re.compile(
    r"https?://(?:"
    r"open\.spotify\.com/(?:intl-[a-z]{2}/)?(?:track|album|playlist|episode|show|artist)/[A-Za-z0-9]+"
    r"|spotify\.link/[A-Za-z0-9]+"
    r")(?:\?[^\s<>\]\)]*)?",
    re.IGNORECASE,
)


def is_url(text: str) -> bool:
    return bool(URL_PATTERN.match(text.strip()))


def first_url(text: str) -> str | None:
    match = FIRST_URL_PATTERN.search(text)
    return match.group(0) if match else None


def spotify_url(text: str | None) -> str | None:
    match = SPOTIFY_URL_PATTERN.search(text or "")
    return match.group(0) if match else None


def youtube_url(text: str | None) -> str | None:
    """Return the first YouTube URL embedded in otherwise ordinary text."""
    for match in FIRST_URL_PATTERN.finditer(text or ""):
        candidate = match.group(0).rstrip(".,;:!?)]}")
        if youtube_video_id(candidate):
            return candidate
    return None


def card_shape_for(text: str | None, url: str | None = None) -> dict:
    """Return {type, title, body, payload} for captured content.

    A bare URL becomes a link or youtube card. Text with a trailing URL (what
    an iOS share sheet sends: selection plus page url) keeps the text as the
    body and the url in the payload.
    """
    text = (text or "").strip()
    url = (url or "").strip() or None

    if url is None and text and is_url(text):
        url, text = text, ""

    if url is None:
        return {"type": "text", "title": None, "body": text or None, "payload": {}}

    # A shared song with commentary is still a note. Keeping the URL in its
    # body makes the source visible and lets the Spotify attachment detector
    # enrich it without turning the whole thought into a link preview.
    if text and (spotify_url(url) or youtube_video_id(url)):
        return {
            "type": "text",
            "title": None,
            "body": f"{text}\n\n{url}",
            "payload": {},
        }

    card_type = "youtube" if youtube_video_id(url) else "link"
    return {
        "type": card_type,
        "title": None,
        "body": text or None,
        "payload": {"url": url},
    }
