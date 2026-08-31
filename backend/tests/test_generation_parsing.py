"""What a small local model actually returns.

No database and no endpoint: these are the pure functions, and they are the
ones most likely to break, so they run everywhere rather than skipping with
the rest of the suite when Postgres is absent.
"""
from app.generate import (
    TITLE_MAX,
    _extract_json,
    coerce_cards,
    coerce_document,
    compose_document,
    parse_document_response,
    splittable_text,
)


class FakeCard:
    def __init__(self, body=None, payload=None):
        self.body = body
        self.payload = payload or {}


def test_plain_json_object():
    assert _extract_json('{"cards": []}') == {"cards": []}


def test_fenced_json_is_unwrapped():
    raw = 'Sure!\n```json\n{"cards": [{"title": "A", "body": "b"}]}\n```\n'
    assert _extract_json(raw) == {"cards": [{"title": "A", "body": "b"}]}


def test_prose_around_the_object_is_discarded():
    raw = 'Here you go:\n{"cards": [{"title": "A", "body": "b"}]}\nHope that helps!'
    assert _extract_json(raw) == {"cards": [{"title": "A", "body": "b"}]}


def test_a_reasoning_block_is_stripped_before_parsing():
    """A thinking model's scratchpad reaches the parser as ordinary text, and
    a stray bracket in it defeated the outermost-delimiter fallback — the
    split then returned nothing at all rather than something wrong."""
    raw = """<think>
The list is [seedlings, fence]. I will return the cards now.
</think>
{"cards": [{"title": "Fence", "body": "rotting"}]}"""
    assert _extract_json(raw) == {"cards": [{"title": "Fence", "body": "rotting"}]}


def test_a_draft_inside_the_scratchpad_does_not_win():
    """The model reconsidering mid-thought must not leave its discarded first
    attempt as the answer."""
    raw = """<think>
Draft: {"cards": [{"title": "WRONG", "body": "draft"}]}
Actually, let me redo that.
</think>
{"cards": [{"title": "RIGHT", "body": "final"}]}"""
    assert _extract_json(raw) == {"cards": [{"title": "RIGHT", "body": "final"}]}


def test_a_dangling_close_tag_is_handled():
    """Some servers strip the opening tag and return the rest verbatim."""
    raw = 'reasoning about [things]</think>{"cards": [{"body": "b"}]}'
    assert _extract_json(raw) == {"cards": [{"body": "b"}]}


def test_reasoning_and_fencing_together():
    raw = """<thinking>two topics here</thinking>
```json
{"cards": [{"title": "A", "body": "b"}]}
```"""
    assert _extract_json(raw) == {"cards": [{"title": "A", "body": "b"}]}


def test_bare_array_is_accepted():
    assert _extract_json('[{"body": "one"}]') == [{"body": "one"}]


def test_unparseable_returns_none():
    assert _extract_json("I'm sorry, I can't do that.") is None


def test_a_single_bad_entry_costs_one_card():
    """The whole reason the output shape is a flat list: partial failure is
    survivable, where one bad reference in a graph would not be."""
    cards = coerce_cards(
        [
            {"title": "Good", "body": "text"},
            12345,
            {"title": "", "body": ""},
            {"title": "Also good", "body": "more text"},
        ],
        limit=6,
    )
    assert [c["title"] for c in cards] == ["Good", "Also good"]


def test_alternative_key_names_are_accepted():
    assert coerce_cards({"items": [{"name": "T", "content": "B"}]}, limit=6) == [
        {"title": "T", "body": "B"}
    ]


def test_strings_become_bodies():
    assert coerce_cards(["just some text"], limit=6) == [
        {"title": None, "body": "just some text"}
    ]


def test_limit_is_enforced_against_an_overrun():
    cards = coerce_cards([{"body": str(i)} for i in range(50)], limit=3)
    assert len(cards) == 3


def test_long_titles_are_truncated():
    (card,) = coerce_cards([{"title": "x" * 500, "body": "b"}], limit=6)
    assert len(card["title"]) == TITLE_MAX


def test_nothing_usable_is_an_empty_list_not_an_error():
    assert coerce_cards({"error": "no"}, limit=6) == []
    assert coerce_cards("not a list", limit=6) == []


def test_splittable_text_gathers_body_transcript_and_description():
    card = FakeCard(
        body="written note",
        payload={"transcript": "spoken words", "unfurl": {"description": "the page"}},
    )
    text = splittable_text(card)
    assert "written note" in text
    assert "spoken words" in text
    assert "the page" in text


def test_splittable_text_is_empty_for_an_empty_card():
    assert splittable_text(FakeCard()) == ""


# --- the request itself ---------------------------------------------------


class FakeResponse:
    def __init__(self, status_code=200, content="{}"):
        self.status_code = status_code
        self._content = content

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def _config(**overrides):
    from app.runtime_settings import AiConfig

    base = {"chat_base_url": "http://model.local/v1", "chat_model": "qwen3:4b"}
    base.update(overrides)
    return AiConfig(**base)


def test_the_request_carries_the_model_and_both_messages(monkeypatch):
    from app import generate

    sent = {}

    def fake_post(url, json, headers, timeout):
        sent["url"] = url
        sent["json"] = json
        sent["headers"] = headers
        return FakeResponse(
            content=(
                '{"group_title": "Group", "cards": ['
                '{"title": "A", "body": "b"}, '
                '{"title": "B", "body": "c"}]}'
            )
        )

    monkeypatch.setattr(generate.httpx, "post", fake_post)
    result = generate.split_text("some long text", _config(), limit=4)

    assert sent["url"] == "http://model.local/v1/chat/completions"
    assert sent["json"]["model"] == "qwen3:4b"
    assert [m["role"] for m in sent["json"]["messages"]] == ["system", "user"]
    system = sent["json"]["messages"][0]["content"]
    assert "at most 4 cards" in system
    # The rule that separates reorganising from chopping, and the one that
    # keeps it grounded. Both are load-bearing; neither should quietly go.
    assert "Group by meaning, not by position" in system
    assert "may not add anything the note does not say" in system
    assert "Every card must have a specific title and a substantive body" in system
    assert "Use the fewest cards" in system
    assert sent["json"]["messages"][1]["content"] == "some long text"
    assert sent["json"]["response_format"]["type"] == "json_schema"
    assert result["cards"] == [
        {"title": "A", "body": "b"},
        {"title": "B", "body": "c"},
    ]


def test_an_api_key_becomes_a_bearer_header(monkeypatch):
    from app import generate

    seen = {}

    def fake_post(url, json, headers, timeout):
        seen.update(headers)
        return FakeResponse(content="{}")

    monkeypatch.setattr(generate.httpx, "post", fake_post)
    generate.split_text("text", _config(chat_api_key="sk-abc"), limit=2)
    assert seen["Authorization"] == "Bearer sk-abc"


def test_a_server_rejecting_json_mode_gets_a_second_try_without_it(monkeypatch):
    """The whole point of the OpenAI-compatible promise: an endpoint that has
    never heard of response_format still has to work."""
    from app import generate

    attempts = []

    def fake_post(url, json, headers, timeout):
        attempts.append(dict(json))
        if "response_format" in json:
            return FakeResponse(status_code=400)
        return FakeResponse(content='[{"body": "one"}, {"body": "two"}]')

    monkeypatch.setattr(generate.httpx, "post", fake_post)
    result = generate.split_text("text", _config(), limit=2)

    assert len(attempts) == 3
    assert "response_format" in attempts[0]
    assert attempts[0]["response_format"]["type"] == "json_schema"
    assert attempts[1]["response_format"]["type"] == "json_object"
    assert "response_format" not in attempts[2]
    assert result["cards"] == [
        {"title": None, "body": "one"},
        {"title": None, "body": "two"},
    ]


def test_nothing_is_sent_when_generation_is_unconfigured(monkeypatch):
    from app import generate

    def explode(*a, **k):
        raise AssertionError("should not have called the endpoint")

    monkeypatch.setattr(generate.httpx, "post", explode)
    empty = {"hero": None, "cards": []}
    assert generate.split_text("text", _config(chat_base_url=""), limit=2) == empty
    assert generate.split_text("   ", _config(), limit=2) == empty


def test_placeholder_titles_are_dropped_not_shown():
    """The model sometimes emits its own template key as the title. Better an
    untitled card than one called body_title_placeholder_for_x."""
    cards = coerce_cards(
        [
            {"title": "body_title_placeholder_for_communication_features",
             "body": "Real content here."},
            {"title": "section_2", "body": "More content."},
            {"title": "Battery Life", "body": "Ten months."},
        ],
        limit=6,
    )
    assert [c["title"] for c in cards] == [None, None, "Battery Life"]
    # The card itself survives — only the useless title goes.
    assert cards[0]["body"] == "Real content here."


# --- a model that loses its place in the schema ---------------------------

LEAK = (
    'title_2": "Eligibility Criteria", "body_2": "Only videos longer than 30 '
    'seconds are eligible for thumbnail previews."'
)


def test_a_card_made_of_leaked_schema_is_dropped():
    """Seen in the wild: the model wrote one good card, lost its place, and
    carried on emitting the rest of the structure as prose. That arrived as a
    card whose body was the machinery that produced it."""
    cards = coerce_cards(
        [
            {"title": "Automatic Thumbnail Preview Selection", "body": "Real content."},
            {"title": None, "body": LEAK},
        ],
        limit=6,
    )
    assert [c["title"] for c in cards] == ["Automatic Thumbnail Preview Selection"]


def test_bare_schema_tokens_and_title_only_cards_are_dropped():
    cards = coerce_cards(
        [
            {"body": "title_2"},
            {"body": "hero"},
            {"title": "Looks finished", "body": ""},
            {"title": "Useful", "body": "Real information."},
        ],
        limit=6,
    )
    assert cards == [{"title": "Useful", "body": "Real information."}]


def test_ordinary_text_with_a_colon_survives():
    """The guard keys off the schema's own field names, so a normal sentence
    that happens to start with a word and a colon is untouched."""
    cards = coerce_cards(
        [{"title": "Note", "body": "Summary: the preview is chosen automatically."}],
        limit=6,
    )
    assert len(cards) == 1


def test_numbered_keys_become_separate_cards():
    """The other half of the same failure: rather than adding entries to the
    list, the model numbers the keys of one object."""
    cards = coerce_cards(
        [
            {
                "title_1": "Automatic Selection",
                "body_1": "A three second clip from the first half.",
                "title_2": "Eligibility Criteria",
                "body_2": "Only videos longer than thirty seconds.",
            }
        ],
        limit=6,
    )
    assert [c["title"] for c in cards] == ["Automatic Selection", "Eligibility Criteria"]
    assert cards[1]["body"] == "Only videos longer than thirty seconds."


def test_numbered_keys_keep_their_order_past_nine():
    cards = coerce_cards(
        [{f"title_{n}": f"T{n}" for n in (1, 2, 10)} | {f"body_{n}": f"B{n}" for n in (1, 2, 10)}],
        limit=6,
    )
    assert [c["title"] for c in cards] == ["T1", "T2", "T10"]


def test_the_hero_is_held_apart_from_the_cards(monkeypatch):
    """It is the one card the others are arranged around, so it must not
    quietly arrive as an ordinary entry in the list."""
    from app import generate

    monkeypatch.setattr(
        generate.httpx,
        "post",
        lambda url, json, headers, timeout: FakeResponse(
            content=(
                '{"hero": {"title": "YouTube Thumbnail Previews", '
                '"body": "How the preview clip is chosen."}, '
                '"cards": [{"title": "Eligibility", "body": "Over 30 seconds."}, '
                '{"title": "Selection", "body": "The first half supplies the clip."}]}'
            )
        ),
    )
    result = generate.split_text("text", _config(), limit=6)
    assert result["hero"] == {
        "title": "YouTube Thumbnail Previews",
        "body": None,
    }
    assert [c["title"] for c in result["cards"]] == ["Eligibility", "Selection"]


def test_a_hero_without_a_title_is_not_a_hero():
    """A heading card with no heading is just a note; better none at all."""
    from app.generate import coerce_hero

    assert coerce_hero({"hero": {"body": "no title here"}}) is None
    assert coerce_hero({"cards": []}) is None
    assert coerce_hero("nonsense") is None


def test_group_title_becomes_a_title_only_heading(monkeypatch):
    from app import generate

    monkeypatch.setattr(
        generate.httpx,
        "post",
        lambda url, json, headers, timeout: FakeResponse(
            content=(
                '{"group_title": "YouTube Thumbnail Previews", '
                '"cards": [{"title": "Eligibility", "body": "Over 30 seconds."}, '
                '{"title": "Selection", "body": "The first half supplies the clip."}]}'
            )
        ),
    )
    result = generate.split_text("text", _config(), limit=6)
    assert result["hero"] == {
        "title": "YouTube Thumbnail Previews",
        "body": None,
    }


def test_an_under_split_response_gets_one_repair_attempt(monkeypatch):
    from app import generate

    responses = iter(
        [
            '{"group_title":"Topic","cards":['
            '{"title":"Summary","body":"Everything together."}]}',
            '{"group_title":"Topic","cards":['
            '{"title":"Decision","body":"The chosen direction."},'
            '{"title":"Constraint","body":"The limiting condition."}]}',
        ]
    )
    calls = []

    def fake_post(url, json, headers, timeout):
        calls.append(json)
        return FakeResponse(content=next(responses))

    monkeypatch.setattr(generate.httpx, "post", fake_post)
    result = generate.split_text("text", _config(), limit=6)
    assert len(calls) == 2
    assert "previous response was unusable" in calls[1]["messages"][0]["content"]
    assert [card["title"] for card in result["cards"]] == [
        "Decision",
        "Constraint",
    ]


def test_the_prompt_asks_for_a_group_title_not_a_hero_object():
    from app.generate import system_prompt

    prompt = system_prompt(6)
    assert '"group_title"' in prompt
    assert '"hero"' not in prompt
    assert "displayed alone as a heading" in prompt


def test_the_schema_example_shows_more_than_one_card():
    """A single-card example taught the model that a second card meant a
    second set of keys."""
    from app.generate import system_prompt

    prompt = system_prompt(6)
    assert prompt.count('"title"') >= 2
    assert "exactly the title and body keys shown above" in prompt


# --- document composition ------------------------------------------------


def test_document_aliases_are_coerced_and_empty_results_rejected():
    assert coerce_document({"document": {"name": "Brief", "markdown": "# One"}}) == {
        "title": "Brief",
        "body": "# One",
    }
    assert coerce_document({"title": "Nothing", "body": ""}) is None
    assert coerce_document(["not", "a", "document"]) is None


def test_plain_markdown_document_uses_the_first_heading_as_its_title():
    assert parse_document_response(
        "# Finding Saved Work\n\n## Problem\n\nCustomers cannot find it."
    ) == {
        "title": "Finding Saved Work",
        "body": "## Problem\n\nCustomers cannot find it.",
    }


def test_fenced_markdown_is_recovered_from_a_small_model():
    assert parse_document_response("```markdown\n# Brief\n\nUseful body.\n```") == {
        "title": "Brief",
        "body": "Useful body.",
    }


def test_composer_sends_cards_and_relationships_to_the_model(monkeypatch):
    import json
    import uuid

    from app import generate

    first = FakeCard(body="The proposal reduces setup time.")
    first.id, first.title = uuid.uuid4(), "Proposal"
    second = FakeCard(body="Three trials were faster.")
    second.id, second.title = uuid.uuid4(), "Trials"
    sent = {}

    def fake_post(url, json, headers, timeout):
        sent.update(json)
        return FakeResponse(
            content=(
                "# Setup\n\n<!-- sources: S1 -->\n## Proposal\n\n"
                "<!-- sources: S1,S2 -->\nThree trials were faster."
            )
        )

    monkeypatch.setattr(generate.httpx, "post", fake_post)
    relationship = {
        "source": str(second.id),
        "target": str(first.id),
        "type": "supports",
        "note": "Measured evidence",
    }
    result = compose_document([first, second], [relationship], _config())

    request = json.loads(sent["messages"][1]["content"])
    assert [card["title"] for card in request["cards"]] == ["Proposal", "Trials"]
    assert request["relationships"] == [
        {**relationship, "source": "S2", "target": "S1"}
    ]
    assert "contradicts" in sent["messages"][0]["content"]
    assert "response_format" not in sent
    assert result == {
        "title": "Setup",
        "body": "## Proposal\n\nThree trials were faster.",
        "blocks": [
            {
                "id": "block-1",
                "markdown": "## Proposal",
                "source_card_ids": [str(first.id)],
            },
            {
                "id": "block-2",
                "markdown": "Three trials were faster.",
                "source_card_ids": [str(first.id), str(second.id)],
            },
        ],
    }
