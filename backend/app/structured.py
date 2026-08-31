"""Checklists and tables: structure in the payload, markdown in the body.

The editor works on a real list and a real grid. `body` is a markdown mirror
of that structure, regenerated here on every write and never hand-edited, so
the two cannot drift.

The mirror is not decoration. `search_text` is a generated column over title
and body, embeddings read the same text, and the split feature takes a card's
body as its input — so a checklist that only existed in `payload` would be
invisible to all three. It is a projection rather than a full representation:
markdown cannot express a ragged table or a merged cell, and re-importing one
would not round-trip perfectly. Nothing reads it back, which is what makes
that acceptable.
"""

MAX_ITEMS = 200
MAX_ROWS = 100
MAX_COLUMNS = 20
CELL_MAX = 500


def _text(value: object) -> str:
    """One line of plain text. Newlines would break the line-oriented markdown
    these mirrors produce, so they are folded rather than escaped."""
    if value is None:
        return ""
    return " ".join(str(value).split())[:CELL_MAX]


def clean_items(raw: object) -> list[dict]:
    """A checklist's items, from whatever the client sent."""
    if not isinstance(raw, list):
        return []
    items: list[dict] = []
    for entry in raw[:MAX_ITEMS]:
        if isinstance(entry, str):
            items.append({"text": _text(entry), "done": False})
        elif isinstance(entry, dict):
            items.append(
                {"text": _text(entry.get("text")), "done": bool(entry.get("done"))}
            )
    return items


def checklist_markdown(items: list[dict]) -> str:
    return "\n".join(
        f"- [{'x' if item['done'] else ' '}] {item['text']}" for item in items
    )


def clean_rows(raw: object) -> list[list[str]]:
    """A table's grid, rectangular and bounded.

    Ragged input is padded rather than rejected: a row that lost a cell is a
    dropped keystroke, not a reason to refuse the write.
    """
    if not isinstance(raw, list):
        return []
    rows = [row for row in raw[:MAX_ROWS] if isinstance(row, list)]
    if not rows:
        return []
    width = min(max((len(row) for row in rows), default=0), MAX_COLUMNS)
    if width == 0:
        return []
    return [
        [_text(cell) for cell in row[:width]] + [""] * (width - min(len(row), width))
        for row in rows
    ]


def clean_widths(raw: object, columns: int) -> list[float]:
    """Column widths, as fractions of the card that always sum to one.

    Presentation rather than content, so the mirror ignores them — but a stale
    or hand-edited list would leave the grid drawn against the wrong tracks, so
    anything that does not match the grid is replaced with even columns.
    """
    if columns <= 0:
        return []
    given = []
    if isinstance(raw, list):
        for value in raw:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                break
            if value <= 0 or value != value or value in (float("inf"),):
                break
            given.append(float(value))
    if len(given) != columns:
        return [1 / columns] * columns
    total = sum(given)
    return [w / total for w in given]


def table_markdown(rows: list[list[str]], header: bool = True) -> str:
    """GFM, with the first row as the header when there is one.

    A pipe inside a cell would end the cell, so it is escaped; everything else
    survives as written.
    """
    if not rows:
        return ""

    def line(cells: list[str]) -> str:
        return "| " + " | ".join(cell.replace("|", "\\|") for cell in cells) + " |"

    width = len(rows[0])
    if header:
        head, rest = rows[0], rows[1:]
    else:
        head, rest = [""] * width, rows
    out = [line(head), "| " + " | ".join(["---"] * width) + " |"]
    out.extend(line(row) for row in rest)
    return "\n".join(out)


def mirror_body(card_type: str, payload: dict) -> str | None:
    """The body a structured card should carry, or None if it is not one."""
    if card_type == "checklist":
        return checklist_markdown(clean_items(payload.get("items")))
    if card_type == "table":
        return table_markdown(
            clean_rows(payload.get("rows")), header=payload.get("header", True) is not False
        )
    return None


def normalise(card_type: str, payload: dict) -> tuple[dict, str] | None:
    """Clean a structured payload and produce its mirror in one step.

    Returns None for every other card type, so callers can leave them alone.
    """
    if card_type == "checklist":
        items = clean_items(payload.get("items"))
        return {**payload, "items": items}, checklist_markdown(items)
    if card_type == "table":
        rows = clean_rows(payload.get("rows"))
        header = payload.get("header", True) is not False
        widths = clean_widths(payload.get("widths"), len(rows[0]) if rows else 0)
        return (
            {**payload, "rows": rows, "header": header, "widths": widths},
            table_markdown(rows, header),
        )
    return None
