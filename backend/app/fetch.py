"""Guarded HTTP fetching for user-supplied URLs.

The unfurler fetches whatever URL a user pastes, and a self-hosted instance
usually sits on a LAN next to a router admin page and a NAS. So: http/https
only, every hostname resolved and checked against non-public ranges, redirects
followed manually with every hop re-checked, a short timeout, and a hard read
cap.
"""
import ipaddress
import socket
from urllib.parse import urlparse

import httpx

MAX_REDIRECTS = 5
# Product pages are heavy, and the structured data that makes a link card
# worth looking at often sits well past the first couple of megabytes.
MAX_BYTES = 5 * 1024 * 1024
TIMEOUT_SECONDS = 8.0

# Large sites serve a stripped placeholder to user agents they do not
# recognise, which is why an unfurl of a shopping link used to come back with
# nothing but the site name. This asks for the page a browser would get: the
# request is for a URL the user pasted themselves, one page at a time, not a
# crawl.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
REQUEST_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


class FetchBlocked(Exception):
    pass


def check_url(url: str) -> None:
    """Raise FetchBlocked unless every resolved address is publicly routable."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise FetchBlocked(f"scheme not allowed: {parsed.scheme or '(none)'}")
    host = parsed.hostname
    if not host:
        raise FetchBlocked("no host in URL")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise FetchBlocked(f"cannot resolve {host}") from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if not address.is_global or address.is_multicast:
            raise FetchBlocked(f"{host} resolves to non-public address {address}")


def guarded_get(url: str) -> tuple[str, bytes]:
    """Fetch url with every redirect hop re-checked. Returns (final_url, body)."""
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        check_url(current)
        with httpx.Client(
            follow_redirects=False,
            timeout=TIMEOUT_SECONDS,
            headers=REQUEST_HEADERS,
        ) as client:
            with client.stream("GET", current) as resp:
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = resp.headers.get("location")
                    if not location:
                        raise FetchBlocked("redirect without location")
                    current = str(httpx.URL(current).join(location))
                    continue
                resp.raise_for_status()
                chunks: list[bytes] = []
                total = 0
                for chunk in resp.iter_bytes():
                    total += len(chunk)
                    if total > MAX_BYTES:
                        break
                    chunks.append(chunk)
                return current, b"".join(chunks)
    raise FetchBlocked("too many redirects")
