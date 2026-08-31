"""Portable document exports without browser- or office-specific machinery.

Cards store Markdown, so Markdown is the canonical export. DOCX and PDF are
small renderers over that same source: enough structure for headings, lists,
quotes, code, links, and emphasis while keeping export available in the base
installation rather than requiring LibreOffice on the server.
"""

from __future__ import annotations

import io
import re
import textwrap
import zipfile
from collections.abc import Mapping
from xml.sax.saxutils import escape


CARD_LINK_RE = re.compile(
    r"\[([^\]]+)\]\(card:([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\)"
)
MARKDOWN_LINK_RE = re.compile(r"!?\[([^\]]*)\]\(([^)]+)\)")
INLINE_RE = re.compile(
    r"(\*\*[^*\n]+\*\*|(?<!\*)\*[^*\n]+\*(?!\*)|`[^`\n]+`|!?\[[^\]]*\]\([^)]+\))"
)
RICH_TEXT_TAG_RE = re.compile(r"</?(?:span|mark|u)\b[^>]*>", re.IGNORECASE)


def _portable_markdown(value: str) -> str:
    """Remove editor-only HTML wrappers while retaining their readable text.

    Tiptap stores colour and highlight as spans/marks because Markdown has no
    representation for them. Those implementation tags should never become
    visible prose in an exported file. Deliberately leave unrelated HTML
    alone: a document may contain an intentional HTML example or block.
    """
    return RICH_TEXT_TAG_RE.sub("", value)


def citation_ids(body: str) -> list[str]:
    """Direct inline citations, deduplicated in reading order."""
    return list(dict.fromkeys(match.group(2).lower() for match in CARD_LINK_RE.finditer(body)))


def export_markdown(
    title: str | None,
    body: str | None,
    citations: Mapping[str, tuple[str | None, str | None]],
    include_citations: bool,
) -> str:
    """Make app-only card links useful outside the app.

    Missing or inaccessible cards become their readable label with no dangling
    footnote. Citation bodies are included once and do not recurse into further
    cards; one explicit document should not silently export a whole graph.
    """
    numbers: dict[str, int] = {}

    def replace(match: re.Match[str]) -> str:
        label, raw_id = match.groups()
        card_id = raw_id.lower()
        if not include_citations or card_id not in citations:
            return label
        if card_id not in numbers:
            numbers[card_id] = len(numbers) + 1
        return f"{label} [{numbers[card_id]}]"

    sections: list[str] = []
    if title and title.strip():
        sections.append(f"# {title.strip()}")
    clean_body = CARD_LINK_RE.sub(replace, _portable_markdown(body or "")).strip()
    if clean_body:
        sections.append(clean_body)

    if include_citations and numbers:
        entries = ["# Citations"]
        for card_id, number in sorted(numbers.items(), key=lambda item: item[1]):
            cited_title, cited_body = citations[card_id]
            entries.append(f"## [{number}] {(cited_title or 'Untitled').strip()}")
            # References inside a citation stay readable but do not recursively
            # pull more cards into the export.
            readable = CARD_LINK_RE.sub(
                lambda match: match.group(1), _portable_markdown(cited_body or "")
            ).strip()
            entries.append(readable or "_(No text)_")
        sections.append("\n\n".join(entries))
    return "\n\n".join(sections).strip() + "\n"


def safe_filename(title: str | None) -> str:
    name = re.sub(r"[<>:\"/\\|?*\x00-\x1f]", "", (title or "").strip())
    name = re.sub(r"\s+", " ", name).strip(" .")
    return (name or "Untitled document")[:120]


def _plain_inline(value: str, include_urls: bool = True) -> str:
    def link(match: re.Match[str]) -> str:
        label, href = match.groups()
        if href.startswith("card:") or not include_urls:
            return label
        return f"{label} ({href})"

    value = MARKDOWN_LINK_RE.sub(link, value)
    value = re.sub(r"(\*\*|__|~~|`)", "", value)
    value = re.sub(r"(?<!\*)\*(?!\*)|(?<!_)_(?!_)", "", value)
    return value


def _run_xml(text: str, *, bold: bool = False, italic: bool = False, code: bool = False) -> str:
    props = []
    if bold:
        props.append("<w:b/>")
    if italic:
        props.append("<w:i/>")
    if code:
        props.append('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>')
    prop_xml = f"<w:rPr>{''.join(props)}</w:rPr>" if props else ""
    return f'<w:r>{prop_xml}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def _inline_xml(value: str) -> str:
    output: list[str] = []
    at = 0
    for match in INLINE_RE.finditer(value):
        if match.start() > at:
            output.append(_run_xml(value[at : match.start()]))
        token = match.group(0)
        if token.startswith("**"):
            output.append(_run_xml(token[2:-2], bold=True))
        elif token.startswith("*"):
            output.append(_run_xml(token[1:-1], italic=True))
        elif token.startswith("`"):
            output.append(_run_xml(token[1:-1], code=True))
        else:
            found = MARKDOWN_LINK_RE.fullmatch(token)
            if found:
                label, href = found.groups()
                suffix = "" if href.startswith("card:") else f" ({href})"
                output.append(_run_xml(label + suffix))
        at = match.end()
    if at < len(value):
        output.append(_run_xml(value[at:]))
    return "".join(output) or _run_xml("")


def _paragraph_xml(line: str) -> str:
    style = ""
    indent = ""
    text = line
    run: str | None = None
    heading = re.match(r"^(#{1,6})\s+(.*)$", line)
    bullet = re.match(r"^\s*[-*+]\s+(.*)$", line)
    numbered = re.match(r"^\s*\d+[.)]\s+(.*)$", line)
    if heading:
        level = min(len(heading.group(1)), 3)
        style = f'<w:pStyle w:val="Heading{level}"/>'
        text = heading.group(2)
    elif bullet:
        style = '<w:pStyle w:val="ListBullet"/>'
        text = "•  " + bullet.group(1)
    elif numbered:
        style = '<w:pStyle w:val="ListNumber"/>'
        text = line.strip()
    elif line.startswith(">"):
        indent = '<w:ind w:left="720"/>'
        text = line.lstrip("> ")
        run = _run_xml(text, italic=True)
    elif line.strip().startswith("|"):
        run = _run_xml(text, code=True)
    props = f"<w:pPr>{style}{indent}</w:pPr>" if style or indent else ""
    return f"<w:p>{props}{run or _inline_xml(text)}</w:p>"


def docx_bytes(markdown: str) -> bytes:
    paragraphs = []
    for line in markdown.splitlines():
        paragraphs.append(_paragraph_xml(line) if line.strip() else "<w:p/>")
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{''.join(paragraphs)}"
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/>'
        "</w:sectPr></w:body></w:document>"
    )
    styles = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="34"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>"""
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""
    relationships = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""
    document_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", relationships)
        archive.writestr("word/document.xml", document)
        archive.writestr("word/styles.xml", styles)
        archive.writestr("word/_rels/document.xml.rels", document_rels)
    return output.getvalue()


def _pdf_escape(value: str) -> bytes:
    encoded = value.encode("cp1252", "replace")
    return encoded.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def pdf_bytes(markdown: str) -> bytes:
    lines: list[tuple[str, int, str]] = []
    for raw in markdown.splitlines():
        heading = re.match(r"^(#{1,6})\s+(.*)$", raw)
        if heading:
            size = 20 if len(heading.group(1)) == 1 else 15 if len(heading.group(1)) == 2 else 12
            text = _plain_inline(heading.group(2))
            font = "F2"
            width = max(28, int(92 * 11 / size))
        else:
            size = 10
            font = "F4" if raw.strip().startswith("|") else "F1"
            text = _plain_inline(raw)
            if raw.startswith(">"):
                font = "F3"
                text = "    " + text.lstrip("> ")
            width = 92
        wrapped = textwrap.wrap(text, width=width, replace_whitespace=False) or [""]
        lines.extend((part, size, font) for part in wrapped)

    pages: list[bytes] = []
    commands: list[bytes] = []
    y = 770
    for text, size, font in lines:
        leading = max(14, int(size * 1.45))
        if y - leading < 48:
            pages.append(b"\n".join(commands))
            commands = []
            y = 770
        commands.append(
            f"BT /{font} {size} Tf 54 {y} Td (".encode()
            + _pdf_escape(text)
            + b") Tj ET"
        )
        y -= leading
    pages.append(b"\n".join(commands))

    objects: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        4: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>",
        6: b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    }
    page_ids = [7 + index * 2 for index in range(len(pages))]
    objects[2] = (
        f"<< /Type /Pages /Count {len(pages)} /Kids ["
        + " ".join(f"{page_id} 0 R" for page_id in page_ids)
        + "] >>"
    ).encode()
    for index, content in enumerate(pages):
        page_id = page_ids[index]
        content_id = page_id + 1
        objects[page_id] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> "
            f"/Contents {content_id} 0 R >>"
        ).encode()
        objects[content_id] = (
            f"<< /Length {len(content)} >>\nstream\n".encode()
            + content
            + b"\nendstream"
        )

    output = io.BytesIO()
    output.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0] * (max(objects) + 1)
    for object_id in range(1, max(objects) + 1):
        offsets[object_id] = output.tell()
        output.write(f"{object_id} 0 obj\n".encode())
        output.write(objects[object_id])
        output.write(b"\nendobj\n")
    xref = output.tell()
    output.write(f"xref\n0 {len(offsets)}\n".encode())
    output.write(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.write(f"{offset:010d} 00000 n \n".encode())
    output.write(
        f"trailer << /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return output.getvalue()
