"""OpenGraph, JSON-LD and title extraction, dependency-free via html.parser."""
import json
import re
from html.parser import HTMLParser

YOUTUBE_PATTERNS = (
    re.compile(r"(?:youtube\.com/watch\?(?:.*&)?v=)([\w-]{11})"),
    re.compile(r"(?:youtu\.be/)([\w-]{11})"),
    re.compile(r"(?:youtube\.com/shorts/)([\w-]{11})"),
    re.compile(r"(?:youtube\.com/embed/)([\w-]{11})"),
)


def youtube_video_id(url: str) -> str | None:
    for pattern in YOUTUBE_PATTERNS:
        match = pattern.search(url)
        if match:
            return match.group(1)
    return None


class _MetaParser(HTMLParser):
    """Collects meta tags, the title, and any JSON-LD blocks.

    Scanning does not stop at <body>. Shopping and recipe sites put their
    structured data in a script tag partway down the page, and that block is
    the only place the useful detail — price, brand, rating — actually lives.
    """

    def __init__(self) -> None:
        super().__init__()
        self.meta: dict[str, str] = {}
        self.title: str | None = None
        self.ld_blocks: list[str] = []
        self._in_title = False
        self._in_ld = False
        self._seen_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        if tag == "meta":
            key = attr.get("property") or attr.get("name") or attr.get("itemprop")
            content = attr.get("content")
            if key and content and key.lower() not in self.meta:
                self.meta[key.lower()] = content
        elif tag == "title" and not self._seen_title:
            self._in_title = True
        elif tag == "script":
            kind = (attr.get("type") or "").lower()
            if kind == "application/ld+json":
                self._in_ld = True
                self.ld_blocks.append("")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            if self._in_title:
                self._seen_title = True
            self._in_title = False
        elif tag == "script":
            self._in_ld = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title = ((self.title or "") + data)[:500]
        elif self._in_ld and self.ld_blocks:
            # Cap it: a malformed page can otherwise stream megabytes here.
            self.ld_blocks[-1] = (self.ld_blocks[-1] + data)[:200_000]


def _walk(node: object):
    """Yield every dict in a JSON-LD document, however it is nested."""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk(item)


def _types(node: dict) -> set[str]:
    raw = node.get("@type")
    values = raw if isinstance(raw, list) else [raw]
    return {str(v).lower() for v in values if v}


def _text(value: object) -> str | None:
    """JSON-LD is inconsistent: a field may be a string, a dict with a name,
    or a list of either."""
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        for key in ("name", "@id", "url", "value"):
            if key in value:
                return _text(value[key])
        return None
    if isinstance(value, list):
        for item in value:
            found = _text(item)
            if found:
                return found
    return None


def parse_ld(blocks: list[str]) -> dict[str, str]:
    """Pull product-ish detail out of the JSON-LD on the page.

    Everything here is best-effort: a page that ships broken JSON, or none at
    all, simply contributes nothing rather than failing the unfurl.
    """
    found: dict[str, str] = {}
    for block in blocks:
        try:
            document = json.loads(block)
        except (json.JSONDecodeError, ValueError):
            continue
        for node in _walk(document):
            if not isinstance(node, dict):
                continue
            kinds = _types(node)

            if "product" in kinds or "book" in kinds:
                for key, source in (
                    ("title", "name"),
                    ("brand", "brand"),
                    ("description", "description"),
                    ("image", "image"),
                ):
                    value = _text(node.get(source))
                    if value and key not in found:
                        found[key] = value

            if "offer" in kinds or "aggregateoffer" in kinds:
                price = _text(node.get("price") or node.get("lowPrice"))
                if price and "price" not in found:
                    found["price"] = price
                currency = _text(node.get("priceCurrency"))
                if currency and "currency" not in found:
                    found["currency"] = currency
                availability = _text(node.get("availability"))
                if availability and "availability" not in found:
                    # "https://schema.org/InStock" → "InStock"
                    found["availability"] = availability.rstrip("/").split("/")[-1]

            if "aggregaterating" in kinds:
                rating = _text(node.get("ratingValue"))
                if rating and "rating" not in found:
                    found["rating"] = rating
                count = _text(node.get("reviewCount") or node.get("ratingCount"))
                if count and "rating_count" not in found:
                    found["rating_count"] = count
    return found


# --- sites that publish nothing ------------------------------------------

AMAZON_HOST = re.compile(r"(?:^|\.)(?:amazon\.[a-z.]+|a\.co)$", re.I)
_AMZ_HIRES = re.compile(r'data-old-hires="(https://[^"]+)"')
_AMZ_DYNAMIC = re.compile(r'data-a-dynamic-image="\{&quot;(https://[^&]+)&quot;')
_AMZ_WHOLE = re.compile(r'class="a-price-whole">\s*([\d,]+)')
_AMZ_FRACTION = re.compile(r'class="a-price-fraction">\s*(\d+)')
_AMZ_SYMBOL = re.compile(r'class="a-price-symbol">\s*([^\s<]{1,3})')

CURRENCY_FOR_SYMBOL = {"$": "USD", "£": "GBP", "€": "EUR", "¥": "JPY"}


def parse_amazon(html: str) -> dict[str, str]:
    """Amazon publishes no OpenGraph, no JSON-LD and no microdata — seven meta
    tags and nothing else — so the image and price can only come from their
    own markup.

    This is scraping, and it is expected to rot: it reads private class names
    that will change without notice. It is deliberately isolated and entirely
    optional, so when it stops matching the card still shows the title,
    description and favicon it always did.
    """
    found: dict[str, str] = {}

    image = _AMZ_HIRES.search(html) or _AMZ_DYNAMIC.search(html)
    if image:
        found["image"] = image.group(1)

    whole = _AMZ_WHOLE.search(html)
    if whole:
        fraction = _AMZ_FRACTION.search(html)
        price = whole.group(1).replace(",", "")
        found["price"] = f"{price}.{fraction.group(1)}" if fraction else price
        symbol = _AMZ_SYMBOL.search(html)
        if symbol:
            found["currency"] = CURRENCY_FOR_SYMBOL.get(symbol.group(1), "")

    return {k: v for k, v in found.items() if v}


_AMZ_TITLE_PREFIX = re.compile(r"^Amazon(?:\.[a-z.]+)?\s*:\s*", re.I)


def tidy_amazon_title(title: str) -> str:
    """"Amazon.com: REOLINK Doorbell ... : Tools & Home Improvement" is mostly
    shop furniture. Drop the storefront prefix and the trailing category."""
    cleaned = _AMZ_TITLE_PREFIX.sub("", title).strip()
    if " : " in cleaned:
        head, _, tail = cleaned.rpartition(" : ")
        # Only drop the tail when it looks like a category, not part of a name.
        if head and len(tail) < 60:
            cleaned = head.strip()
    return cleaned or title


def _host_of(url: str | None) -> str:
    if not url:
        return ""
    try:
        from urllib.parse import urlparse

        return urlparse(url).hostname or ""
    except ValueError:
        return ""


def parse_site_specific(html: str, url: str | None) -> dict[str, str]:
    host = _host_of(url)
    if not host:
        return {}
    if AMAZON_HOST.search(host):
        return parse_amazon(html)
    return {}


PRODUCT_FIELDS = (
    "price",
    "currency",
    "brand",
    "availability",
    "rating",
    "rating_count",
)


def parse_unfurl(html: str, url: str | None = None) -> dict[str, object]:
    parser = _MetaParser()
    try:
        parser.feed(html)
    except Exception:
        pass  # keep whatever was parsed before the markup went bad
    meta = parser.meta
    ld = parse_ld(parser.ld_blocks)
    # Standards first; the site-specific reader only fills what is still blank.
    for key, value in parse_site_specific(html, url).items():
        ld.setdefault(key, value)

    # OpenGraph first where a page bothers to provide it, since it is what the
    # author chose to show; JSON-LD fills the gaps, which on a shopping page is
    # most of them.
    title = (
        meta.get("og:title")
        or meta.get("twitter:title")
        or ld.get("title")
        or parser.title
    )
    raw_title = title
    if title and AMAZON_HOST.search(_host_of(url)):
        title = tidy_amazon_title(title)
    description = (
        meta.get("og:description")
        or meta.get("twitter:description")
        or meta.get("description")
        or ld.get("description")
    )
    image = (
        meta.get("og:image")
        or meta.get("og:image:secure_url")
        or meta.get("twitter:image")
        or meta.get("twitter:image:src")
        or ld.get("image")
    )

    # A description that just repeats the title is two lines saying one thing.
    # Compared against the untidied title too, since the shop furniture this
    # strips from one is usually still sitting on the other.
    if description:
        same = {t.strip() for t in (title, raw_title) if t}
        if description.strip() in same:
            description = None

    product = {key: ld[key] for key in PRODUCT_FIELDS if ld.get(key)}
    return {
        "title": title.strip() if title else None,
        "description": description.strip() if description else None,
        "image": image,
        "site_name": meta.get("og:site_name"),
        # Only present when the page actually described a product, so the card
        # can decide whether it has anything worth a second line.
        "product": product or None,
    }
