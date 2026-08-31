"""SSRF guard and unfurl parsing: pure functions, no database required."""
import pytest

from app.fetch import FetchBlocked, check_url
from app.unfurl import parse_unfurl, youtube_video_id


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/admin",
        "http://localhost:8000/api",
        "http://10.0.0.5/",
        "http://192.168.1.1/router",
        "http://172.16.0.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://0.0.0.0/",
        "ftp://example.com/file",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "http:///nohost",
    ],
)
def test_blocked_urls(url):
    with pytest.raises(FetchBlocked):
        check_url(url)


def test_unresolvable_host_blocked():
    with pytest.raises(FetchBlocked):
        check_url("http://this-host-does-not-exist.invalid/")


@pytest.mark.parametrize(
    ("url", "video_id"),
    [
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/watch?t=10&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://example.com/watch?v=nope", None),
        ("https://vimeo.com/12345", None),
    ],
)
def test_youtube_detection(url, video_id):
    assert youtube_video_id(url) == video_id


def test_parse_unfurl_prefers_opengraph():
    html = """
    <html><head>
      <title>Fallback Title</title>
      <meta property="og:title" content="OG Title">
      <meta property="og:description" content="A description.">
      <meta property="og:image" content="https://example.com/img.png">
      <meta property="og:site_name" content="Example">
    </head><body><p>ignored</p></body></html>
    """
    data = parse_unfurl(html)
    assert data["title"] == "OG Title"
    assert data["description"] == "A description."
    assert data["image"] == "https://example.com/img.png"
    assert data["site_name"] == "Example"


def test_parse_unfurl_falls_back_to_title_tag():
    data = parse_unfurl("<html><head><title>Just a Page</title></head></html>")
    assert data["title"] == "Just a Page"
    assert data["description"] is None


def test_parse_unfurl_survives_bad_markup():
    data = parse_unfurl("<html><head><meta property='og:title' content='X'><<<<>>")
    assert data["title"] == "X"


# --- structured data ------------------------------------------------------

PRODUCT_PAGE = """
<html><head>
<meta property="og:title" content="Reolink Video Doorbell">
<meta property="og:site_name" content="Amazon.com">
</head><body>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Reolink Doorbell",
 "brand":{"@type":"Brand","name":"Reolink"},
 "image":["https://example.com/doorbell.jpg"],
 "description":"4MP 2K+ video doorbell",
 "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.4","reviewCount":"2185"},
 "offers":{"@type":"Offer","price":"99.99","priceCurrency":"USD",
           "availability":"https://schema.org/InStock"}}
</script>
</body></html>
"""


def test_json_ld_fills_in_what_opengraph_leaves_out():
    """A shopping page usually publishes a bare og:title and puts everything
    worth showing in a JSON-LD block partway down the body."""
    data = parse_unfurl(PRODUCT_PAGE)
    assert data["title"] == "Reolink Video Doorbell"  # og wins where present
    assert data["description"] == "4MP 2K+ video doorbell"
    assert data["image"] == "https://example.com/doorbell.jpg"
    assert data["product"] == {
        "price": "99.99",
        "currency": "USD",
        "brand": "Reolink",
        "availability": "InStock",
        "rating": "4.4",
        "rating_count": "2185",
    }


def test_structured_data_below_the_body_is_still_read():
    """The parser used to stop at <body>, which is exactly where this lives."""
    html = (
        '<html><head><title>Shop</title></head><body><div>filler</div>'
        '<script type="application/ld+json">'
        '{"@type":"Product","name":"Widget","offers":{"@type":"Offer",'
        '"price":"12.00","priceCurrency":"GBP"}}'
        "</script></body></html>"
    )
    data = parse_unfurl(html)
    assert data["product"]["price"] == "12.00"
    assert data["product"]["currency"] == "GBP"


def test_a_graph_wrapper_is_walked():
    """Many sites wrap everything in @graph rather than listing it flat."""
    html = (
        '<html><body><script type="application/ld+json">'
        '{"@context":"https://schema.org","@graph":['
        '{"@type":"WebPage","name":"ignored"},'
        '{"@type":"Product","name":"Deep Widget",'
        '"offers":{"@type":"Offer","price":"5","priceCurrency":"EUR"}}]}'
        "</script></body></html>"
    )
    data = parse_unfurl(html)
    assert data["title"] == "Deep Widget"
    assert data["product"]["price"] == "5"


def test_broken_json_ld_costs_nothing():
    html = (
        '<html><head><meta property="og:title" content="Still Fine"></head>'
        '<body><script type="application/ld+json">{not json at all,,,</script>'
        "</body></html>"
    )
    data = parse_unfurl(html)
    assert data["title"] == "Still Fine"
    assert data["product"] is None


def test_a_page_with_no_product_reports_none():
    data = parse_unfurl("<html><head><title>A Blog Post</title></head></html>")
    assert data["title"] == "A Blog Post"
    assert data["product"] is None


def test_the_fetcher_asks_for_the_page_a_browser_would_get():
    """Unknown user agents get a stripped placeholder from large sites, which
    is what left shopping links showing nothing but a site name."""
    from app.fetch import REQUEST_HEADERS

    assert "Mozilla/5.0" in REQUEST_HEADERS["User-Agent"]
    assert REQUEST_HEADERS["Accept"].startswith("text/html")


# --- sites that publish nothing -------------------------------------------

AMAZON_PAGE = """
<html><head><title>Amazon.com: ACME Widget 2000 Wireless : Tools &amp; Home</title>
<meta name="description" content="Amazon.com: ACME Widget 2000 Wireless : Tools &amp; Home">
</head><body>
<img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/51x.jpg">
<span class="a-price-symbol">$</span><span class="a-price-whole">127</span>
<span class="a-price-fraction">47</span>
</body></html>
"""


def test_amazon_image_and_price_come_from_their_own_markup():
    """Amazon ships seven meta tags and no structured data at all, so this is
    the only place the useful detail lives."""
    data = parse_unfurl(AMAZON_PAGE, "https://www.amazon.com/dp/B0FJDRFFQ6")
    assert data["image"] == "https://m.media-amazon.com/images/I/51x.jpg"
    assert data["product"] == {"price": "127.47", "currency": "USD"}


def test_amazon_titles_lose_the_shop_furniture():
    data = parse_unfurl(AMAZON_PAGE, "https://www.amazon.com/dp/B0FJDRFFQ6")
    assert data["title"] == "ACME Widget 2000 Wireless"


def test_a_description_repeating_the_title_is_dropped():
    """Amazon sets both to the same string, which is two lines saying one
    thing on a card."""
    data = parse_unfurl(AMAZON_PAGE, "https://www.amazon.com/dp/B0FJDRFFQ6")
    assert data["description"] is None


def test_the_amazon_reader_only_runs_on_amazon():
    data = parse_unfurl(AMAZON_PAGE, "https://example.com/thing")
    assert data["product"] is None
    assert data["image"] is None
    assert data["title"].startswith("Amazon.com:")


def test_short_links_are_recognised_by_their_destination():
    from app.unfurl import AMAZON_HOST

    assert AMAZON_HOST.search("www.amazon.com")
    assert AMAZON_HOST.search("amazon.co.uk")
    assert AMAZON_HOST.search("a.co")
    assert not AMAZON_HOST.search("notamazon.com")
    assert not AMAZON_HOST.search("example.com")
