"""Provenance and safe refresh behavior without a database."""
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.jobs import living_document_metadata, merge_refreshed_document


def source(title: str, updated_at: datetime):
    return SimpleNamespace(id=uuid.uuid4(), title=title, updated_at=updated_at)


def document(title: str, first: str, second: str, cards: list) -> dict:
    return {
        "title": title,
        "body": f"## Summary\n\n{first}\n\n{second}",
        "blocks": [
            {
                "id": "block-1",
                "markdown": "## Summary",
                "source_card_ids": [str(cards[0].id)],
            },
            {
                "id": "block-2",
                "markdown": first,
                "source_card_ids": [str(cards[0].id)],
            },
            {
                "id": "block-3",
                "markdown": second,
                "source_card_ids": [str(cards[1].id)],
            },
        ],
    }


def test_metadata_keeps_source_snapshots_per_block():
    now = datetime.now(timezone.utc)
    cards = [source("Claim", now), source("Evidence", now)]
    living = living_document_metadata(document("Brief", "Claim.", "Evidence.", cards), cards)

    assert [item["title"] for item in living["sources"]] == ["Claim", "Evidence"]
    assert living["blocks"][1]["source_card_ids"] == [str(cards[0].id)]
    assert living["blocks"][2]["source_versions"][str(cards[1].id)] == now.isoformat()


def test_refresh_updates_untouched_blocks_and_preserves_manual_edits():
    before = datetime.now(timezone.utc)
    cards = [source("Claim", before), source("Evidence", before)]
    original = document("Brief", "Original claim.", "Original evidence.", cards)
    living = living_document_metadata(original, cards)

    # The user changed only the evidence paragraph. Both source cards then changed.
    current = "## Summary\n\nOriginal claim.\n\nMy carefully edited evidence."
    for card in cards:
        card.updated_at = before + timedelta(hours=1)
    incoming = document("Updated brief", "New claim.", "New evidence.", cards)

    merged = merge_refreshed_document("Brief", current, living, incoming, cards)

    assert merged["title"] == "Updated brief"
    assert merged["body"] == "## Summary\n\nNew claim.\n\nMy carefully edited evidence."
    refresh = merged["living_document"]["last_refresh"]
    assert refresh["refreshed_blocks"] == 2
    assert refresh["preserved_blocks"] == 1
    # The preserved block keeps its old source version, so it stays visibly stale.
    evidence = merged["living_document"]["blocks"][2]
    assert evidence["source_versions"][str(cards[1].id)] == before.isoformat()


def test_refresh_does_not_replace_a_manually_changed_title():
    now = datetime.now(timezone.utc)
    cards = [source("A", now), source("B", now)]
    original = document("Generated title", "One.", "Two.", cards)
    living = living_document_metadata(original, cards)
    incoming = document("New generated title", "One updated.", "Two updated.", cards)

    merged = merge_refreshed_document("My title", original["body"], living, incoming, cards)

    assert merged["title"] == "My title"
    assert merged["living_document"]["generated_title"] == "Generated title"


def test_legacy_composition_gains_provenance_without_rewriting_it():
    now = datetime.now(timezone.utc)
    cards = [source("A", now), source("B", now)]
    incoming = document("New title", "New first.", "New second.", cards)
    legacy_body = "## Existing\n\nWords already in the document.\n\nMore existing words."

    merged = merge_refreshed_document("Existing title", legacy_body, {}, incoming, cards)

    assert merged["title"] == "Existing title"
    assert merged["body"] == legacy_body
    assert merged["living_document"]["blocks"][1]["generated_markdown"] == (
        "Words already in the document."
    )
    assert merged["living_document"]["last_refresh"]["preserved_blocks"] == 3
