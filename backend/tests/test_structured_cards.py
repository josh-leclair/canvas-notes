"""Checklists and tables: structure in the payload, markdown in the body.

The mirror is what makes a structured card searchable, embeddable and
splittable, so most of what matters here is that it is always regenerated and
never taken on trust from the client.
"""
from app.structured import (
    checklist_markdown,
    clean_items,
    clean_rows,
    clean_widths,
    mirror_body,
    table_markdown,
)
from tests.conftest import requires_db


# --- the pure mirrors -----------------------------------------------------


def test_items_survive_either_shape():
    assert clean_items(["Buy milk", {"text": "Call Sam", "done": True}]) == [
        {"text": "Buy milk", "done": False},
        {"text": "Call Sam", "done": True},
    ]


def test_newlines_in_an_item_are_folded():
    """The mirror is line-oriented, so a newline inside an item would split it
    into two checkboxes on the way out."""
    (item,) = clean_items([{"text": "two\nlines", "done": False}])
    assert item["text"] == "two lines"


def test_a_checklist_mirrors_as_gfm_tasks():
    assert checklist_markdown(
        [{"text": "Done thing", "done": True}, {"text": "Undone", "done": False}]
    ) == "- [x] Done thing\n- [ ] Undone"


def test_a_ragged_grid_is_padded_not_refused():
    """A row that lost a cell is a dropped keystroke, not a reason to reject
    the write."""
    assert clean_rows([["a", "b"], ["c"]]) == [["a", "b"], ["c", ""]]


def test_a_table_mirrors_with_its_header_row():
    assert table_markdown([["Name", "Qty"], ["Bolts", "40"]]) == (
        "| Name | Qty |\n| --- | --- |\n| Bolts | 40 |"
    )


def test_a_headerless_table_still_produces_valid_markdown():
    """GFM has no way to say "no header", so an empty one stands in — without
    it the rest of the rows are not a table at all."""
    out = table_markdown([["a", "b"]], header=False)
    assert out.splitlines()[1] == "| --- | --- |"
    assert out.splitlines()[2] == "| a | b |"


def test_a_pipe_in_a_cell_cannot_break_the_row():
    (row,) = table_markdown([["a|b", "c"]], header=False).splitlines()[2:]
    assert row == "| a\\|b | c |"


def test_widths_that_do_not_match_the_grid_are_replaced():
    """A stale list would draw the grid against the wrong tracks, so anything
    that is not one fraction per column is thrown away for even columns."""
    assert clean_widths([0.6, 0.4], 3) == [1 / 3, 1 / 3, 1 / 3]
    assert clean_widths("wide", 2) == [0.5, 0.5]
    assert clean_widths([0.5, -1], 2) == [0.5, 0.5]


def test_widths_are_rescaled_to_sum_to_one():
    assert clean_widths([2, 1, 1], 3) == [0.5, 0.25, 0.25]


def test_a_table_with_no_columns_has_no_widths():
    assert clean_widths([0.5, 0.5], 0) == []


def test_an_empty_structure_mirrors_to_nothing():
    assert mirror_body("checklist", {"items": []}) == ""
    assert mirror_body("table", {"rows": []}) == ""


def test_other_card_types_are_left_alone():
    assert mirror_body("text", {"items": [{"text": "x"}]}) is None
    assert mirror_body("image", {}) is None


# --- through the API ------------------------------------------------------


def test_a_checklist_body_is_written_for_you(client, admin):
    card = client.post(
        "/api/cards",
        json={
            "type": "checklist",
            "payload": {"items": [{"text": "First", "done": False}]},
        },
    ).json()["card"]
    assert card["body"] == "- [ ] First"


def test_the_body_is_regenerated_not_trusted(client, admin):
    """A client that sends a body alongside the structure does not get to
    decide what the card says — otherwise search and the split would read
    something the card does not show."""
    card = client.post(
        "/api/cards",
        json={
            "type": "checklist",
            "body": "totally unrelated text",
            "payload": {"items": [{"text": "Real item", "done": True}]},
        },
    ).json()["card"]
    assert card["body"] == "- [x] Real item"


def test_editing_the_structure_rewrites_the_mirror(client, admin):
    card = client.post(
        "/api/cards",
        json={"type": "table", "payload": {"rows": [["A", "B"], ["1", "2"]]}},
    ).json()["card"]
    assert "| A | B |" in card["body"]

    updated = client.patch(
        f"/api/cards/{card['id']}",
        json={"payload": {"rows": [["A", "B"], ["1", "changed"]]}},
    ).json()
    assert "| 1 | changed |" in updated["body"]
    assert "| 1 | 2 |" not in updated["body"]


def test_column_widths_survive_a_round_trip(client, admin):
    """They are presentation, not content, so the mirror ignores them — but a
    table you had widened must come back the shape you left it."""
    card = client.post(
        "/api/cards",
        json={
            "type": "table",
            "payload": {"rows": [["A", "B"], ["1", "2"]], "widths": [3, 1]},
        },
    ).json()["card"]
    assert card["payload"]["widths"] == [0.75, 0.25]
    assert "| A | B |" in card["body"]
    assert "| 1 | 2 |" in card["body"]


def test_dropping_a_column_cannot_leave_stale_widths(client, admin):
    card = client.post(
        "/api/cards",
        json={
            "type": "table",
            "payload": {"rows": [["A", "B", "C"]], "widths": [0.5, 0.3, 0.2]},
        },
    ).json()["card"]
    updated = client.patch(
        f"/api/cards/{card['id']}", json={"payload": {"rows": [["A", "B"]]}}
    ).json()
    assert updated["payload"]["widths"] == [0.5, 0.5]


def test_a_header_colour_is_not_the_header_flag(client, admin):
    """`header` is the boolean for whether the table has a header row at all.
    The header row's colour went in under the same name to begin with, and the
    normaliser rewrote it to True on every save — so the colour is stored as
    `header_color` and both have to survive together."""
    card = client.post(
        "/api/cards",
        json={
            "type": "table",
            "payload": {"rows": [["A", "B"]], "header_color": "blue"},
        },
    ).json()["card"]
    assert card["payload"]["header_color"] == "blue"
    assert card["payload"]["header"] is True


def test_a_structured_card_is_searchable_by_its_contents(client, admin):
    """The whole reason the mirror exists: search_text is generated over the
    body, so a checklist that lived only in its payload would be invisible."""
    client.post(
        "/api/cards",
        json={
            "type": "checklist",
            "title": "Shopping",
            "payload": {"items": [{"text": "aubergines", "done": False}]},
        },
    )
    hits = client.get("/api/search?q=aubergines").json()["hits"]
    assert [h["card"]["title"] for h in hits] == ["Shopping"]


test_a_checklist_body_is_written_for_you = requires_db(
    test_a_checklist_body_is_written_for_you
)
test_the_body_is_regenerated_not_trusted = requires_db(
    test_the_body_is_regenerated_not_trusted
)
test_editing_the_structure_rewrites_the_mirror = requires_db(
    test_editing_the_structure_rewrites_the_mirror
)
test_a_structured_card_is_searchable_by_its_contents = requires_db(
    test_a_structured_card_is_searchable_by_its_contents
)
test_a_header_colour_is_not_the_header_flag = requires_db(
    test_a_header_colour_is_not_the_header_flag
)
test_column_widths_survive_a_round_trip = requires_db(
    test_column_widths_survive_a_round_trip
)
test_dropping_a_column_cannot_leave_stale_widths = requires_db(
    test_dropping_a_column_cannot_leave_stale_widths
)


def test_a_document_is_a_card_type_not_a_flag(client, admin):
    """It became a type when it needed to be something you drag onto a board.
    The storage is still markdown in the body, so nothing downstream changes."""
    card = client.post(
        "/api/cards", json={"type": "document", "body": "# Title\n\nProse."}
    ).json()["card"]
    assert card["type"] == "document"
    assert card["body"] == "# Title\n\nProse."
    assert "display" not in card["payload"]


def test_a_note_can_still_be_promoted_to_a_document(client, admin):
    card = client.post("/api/cards", json={"body": "It grew."}).json()["card"]
    promoted = client.patch(
        f"/api/cards/{card['id']}", json={"type": "document"}
    ).json()
    assert promoted["type"] == "document"
    assert promoted["body"] == "It grew."


def test_a_document_is_searchable_like_any_other_body(client, admin):
    client.post(
        "/api/cards",
        json={"type": "document", "title": "Notes", "body": "About marquetry."},
    )
    hits = client.get("/api/search?q=marquetry").json()["hits"]
    assert [h["card"]["title"] for h in hits] == ["Notes"]


test_a_document_is_a_card_type_not_a_flag = requires_db(
    test_a_document_is_a_card_type_not_a_flag
)
test_a_note_can_still_be_promoted_to_a_document = requires_db(
    test_a_note_can_still_be_promoted_to_a_document
)
test_a_document_is_searchable_like_any_other_body = requires_db(
    test_a_document_is_searchable_like_any_other_body
)
