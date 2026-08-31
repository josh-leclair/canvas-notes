import io
import zipfile

from app.document_export import (
    citation_ids,
    docx_bytes,
    export_markdown,
    pdf_bytes,
    safe_filename,
)


FIRST = "11111111-1111-1111-1111-111111111111"
SECOND = "22222222-2222-2222-2222-222222222222"


def test_citations_are_numbered_once_in_reading_order():
    body = (
        f"Read [Alpha](card:{FIRST}), then [Beta](card:{SECOND}), "
        f"then [Alpha again](card:{FIRST})."
    )
    citations = {
        FIRST: ("Alpha card", "Full **alpha** text."),
        SECOND: ("Beta card", f"Links [elsewhere](card:{FIRST})."),
    }

    exported = export_markdown("Report", body, citations, include_citations=True)

    assert "Read Alpha [1], then Beta [2], then Alpha again [1]." in exported
    assert exported.count("## [1] Alpha card") == 1
    assert exported.count("## [2] Beta card") == 1
    assert "Links elsewhere." in exported
    assert citation_ids(body) == [FIRST, SECOND]


def test_export_without_citations_removes_app_only_links():
    body = f"A [readable label](card:{FIRST})."
    exported = export_markdown(None, body, {}, include_citations=False)
    assert exported == "A readable label.\n"


def test_export_removes_rich_text_storage_tags_but_keeps_text():
    body = (
        '<span style="color: rgb(53, 132, 243);">'
        '<mark data-color="#3969ac" style="background-color: rgb(57, 105, 172);">'
        "New feature drop!!!!"
        "</mark></span>"
    )
    exported = export_markdown("Testing exports!", body, {}, False)
    assert exported == "# Testing exports!\n\nNew feature drop!!!!\n"
    assert "<span" not in exported
    assert "<mark" not in exported


def test_docx_is_a_readable_openxml_package():
    payload = docx_bytes("# A title\n\nA **bold** paragraph.\n")
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        assert "word/document.xml" in archive.namelist()
        document = archive.read("word/document.xml").decode()
    assert "A title" in document
    assert "<w:b/>" in document


def test_pdf_has_a_valid_header_and_cross_reference_table():
    payload = pdf_bytes("# A title\n\nA paragraph.\n")
    assert payload.startswith(b"%PDF-1.4")
    assert b"xref" in payload
    assert payload.rstrip().endswith(b"%%EOF")


def test_filename_is_safe_and_has_a_fallback():
    assert safe_filename('  A: document / name?  ') == "A document name"
    assert safe_filename(" ") == "Untitled document"
