"""Decomposition via any OpenAI-compatible chat endpoint.

Same protocol and the same rule as embeddings.py: Ollama, LM Studio, and
llama.cpp all speak it, a user can point at a hosted API instead without a
second integration existing, and everything degrades to hidden when nothing
is configured.

The only generation task here is splitting text the user already has into
separate cards. That choice is the whole design:

- The output is one collection title plus a flat list of `{title, body}`. No
  links, positions, or references between entries. The collection title is a
  label only; every piece of information belongs in the ordinary cards.
- The cards land unplaced, in the author's inbox, like every other capture.
  Arranging and linking them stays a human act, which is where the meaning in
  this app lives.
- The input is always text that already exists on a card. The model
  rearranges; it does not invent. Every output is checkable against a source
  the user still has.
"""
import json
import logging
import re

import httpx

from app.models import Card
from app.runtime_settings import AiConfig, get_ai_config

log = logging.getLogger("generate")

TIMEOUT_SECONDS = 180.0
MAX_CHARS = 12000
MIN_SPLIT_CHARS = 200
DEFAULT_CARD_LIMIT = 6
TITLE_MAX = 120
DOCUMENT_MAX_CHARS = 40000

"""Reorganising, not chopping.

Sourcing and structuring are separate concerns, and an earlier version of
this prompt collapsed them: rules broad enough to forbid invented facts also
forbade the model from doing any organisational work, which left a splitter
that cut at paragraph boundaries in reading order. Restructuring aggressively
and inventing nothing are compatible, so the rules below permit rewriting and
rejoining freely while holding the line at new facts.
"""
SYSTEM_PROMPT = (
    "You reorganize a long note into a small group of useful cards for a "
    "visual notebook.\n\n"
    "Return JSON only, in this exact shape:\n"
    '{"group_title": "Concise collection name", "cards": ['
    '{"title": "Specific card title", "body": "Complete useful text"}, '
    '{"title": "Another specific title", "body": "Complete useful text"}]}\n\n'
    "Rules:\n"
    "- Set group_title to a concise, specific noun phrase naming the entire "
    "collection. It is displayed alone as a heading, so it has no body or "
    "summary text.\n"
    "- Group by meaning, not by position. If the note keeps returning to a "
    "subject, combine that material into one card.\n"
    "- Pick one way to divide the note — such as topic, decision, person, or "
    "day — and use it consistently across all cards.\n"
    "- When the source is a conversation or chat transcript, organize by its "
    "distinct proposals, decisions, constraints, tradeoffs, and unresolved "
    "questions. Do not organize by speaker or message order, and do not "
    "compress a multi-topic conversation into one summary card.\n"
    "- Every card must have a specific title and a substantive body. The body "
    "must stand on its own and contain the useful information.\n"
    "- Use the fewest cards that preserve the distinct useful ideas. Return "
    "at most CARD_LIMIT cards and never pad the result to reach the limit.\n"
    "- Every fact, name, number, and decision must come from the note. You "
    "may rewrite and combine its material, but may not add anything the note "
    "does not say.\n"
    "- Omit filler, repetition, acknowledgements, and closing remarks. Do not "
    "create an overview card; group_title already labels the collection.\n"
    "- Each item in cards uses exactly the title and body keys shown above.\n"
    "- No commentary, reasoning, or preamble. The JSON is the entire reply."
)


def split_response_format(limit: int) -> dict:
    """A grammar-capable endpoint can guarantee the small shape we need.

    llama.cpp and the hosted OpenAI API both understand this form. `_chat`
    degrades through plain JSON mode and then ordinary text for older
    OpenAI-compatible servers, so stronger decoding does not narrow which
    endpoints the app can use.
    """
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "card_split",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "group_title": {"type": "string", "minLength": 1},
                    "cards": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": limit,
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string", "minLength": 1},
                                "body": {"type": "string", "minLength": 1},
                            },
                            "required": ["title", "body"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["group_title", "cards"],
                "additionalProperties": False,
            },
        },
    }


def system_prompt(limit: int) -> str:
    """Substitution rather than str.format: the prompt holds a literal JSON
    example, and those braces are not format fields."""
    return SYSTEM_PROMPT.replace("CARD_LIMIT", str(limit))


TEST_SAMPLE = (
    "Bought seedlings on Saturday: four tomato, two basil, one rosemary. "
    "The rosemary needs a terracotta pot because it hates wet roots. "
    "Separately, the back fence panel is rotting at the base and should be "
    "replaced before winter. Quote from the yard was 180 for the panel and "
    "the post, which seems high, so it is worth asking somewhere else."
)


def splittable_text(card: Card) -> str:
    """What there is to break up: the body, a transcript, or an unfurled
    description. Deliberately not the title, which is a label rather than
    material."""
    unfurl = card.payload.get("unfurl") or {}
    parts = [
        card.body or "",
        str(card.payload.get("transcript") or ""),
        str(unfurl.get("description") or ""),
    ]
    return "\n\n".join(part for part in parts if part.strip()).strip()[:MAX_CHARS]


_REASONING_BLOCK = re.compile(
    r"<(think|thinking|reasoning)>.*?</\1>", re.DOTALL | re.IGNORECASE
)
_REASONING_TAIL = re.compile(
    r"^.*</(?:think|thinking|reasoning)>", re.DOTALL | re.IGNORECASE
)


def _strip_reasoning(text: str) -> str:
    """Drop a reasoning model's scratchpad before anything else looks at it.

    Without this the outermost-delimiter fallback below reaches into the
    scratchpad, where a stray bracket or a draft the model then discarded
    defeats the parse — and the split fails silently, returning no cards at
    all rather than bad ones.
    """
    text = _REASONING_BLOCK.sub("", text)
    # A closing tag with no opener means the opener was stripped upstream, or
    # the scratchpad ran from the very start. Either way the answer is after
    # the last one.
    return _REASONING_TAIL.sub("", text).strip()


def _extract_json(raw: str) -> object | None:
    """Pull the JSON out of whatever the model wrapped it in.

    Models fence their output, prefix it with "Sure!", think out loud first,
    or return a bare array. None of that is worth failing a job over.
    """
    text = _strip_reasoning(raw.strip())
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Fall back to the outermost braces or brackets in the response.
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        end = text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue
    return None


_PLACEHOLDER_TITLE = re.compile(
    r"^(?:[a-z0-9]+_){2,}[a-z0-9]+$|placeholder|^section[_ ]?\d+$|"
    r"^title[_ ]?\d*$|^body[_ ]?\d*$|^hero$|^group[_ ]?title$",
    re.I,
)


def looks_like_placeholder(title: str) -> bool:
    """A title the model filled in from its own template rather than from the
    note — `body_title_placeholder_for_x`, `section_2`. The prompt asks for a
    real one; this is what catches it when the model ignores that."""
    return bool(_PLACEHOLDER_TITLE.search(title.strip()))


def _clean(value: object) -> str:
    return str(value).strip() if value is not None else ""


_NUMBERED_KEY = re.compile(r"^(title|body|name|text|content)[_ ]?(\d+)$", re.I)
_LEAKED_SCHEMA = re.compile(r'^\s*"?(title|body|name|text|content)[_ ]?\d*"?\s*:', re.I)
_BARE_SCHEMA_TOKEN = re.compile(
    r"^(?:hero|group[_ ]?title|cards?|title[_ ]?\d*|body[_ ]?\d*)$", re.I
)


def looks_like_leaked_schema(text: str) -> bool:
    """A card whose text is really a fragment of the JSON the model was
    supposed to be writing — `title_2": "Eligibility Criteria", "body_2": …`.

    A model that loses its place mid-structure carries on in prose, and the
    result is a card whose body is the machinery that produced it. Better no
    card than that one.
    """
    clean = text.strip().strip('"\'`')
    return bool(_LEAKED_SCHEMA.match(clean) or _BARE_SCHEMA_TOKEN.fullmatch(clean))


def _expand_numbered(entry: dict) -> list[dict]:
    """Recover a model that numbered its keys instead of adding list entries:
    `{title_1, body_1, title_2, body_2}` is two cards, not one."""
    grouped: dict[str, dict[str, str]] = {}
    for key, value in entry.items():
        match = _NUMBERED_KEY.match(str(key))
        if not match:
            continue
        field, index = match.group(1).lower(), match.group(2)
        slot = grouped.setdefault(index, {})
        slot["title" if field in ("title", "name") else "body"] = _clean(value)
    return [grouped[i] for i in sorted(grouped, key=lambda n: int(n))]


def coerce_cards(data: object, limit: int) -> list[dict]:
    """Keep the entries that are usable and drop the rest.

    Forgiving on purpose. A model that returns nine good cards and one
    malformed one should cost the caller the malformed one, not the request.
    """
    if isinstance(data, dict):
        for key in ("cards", "items", "results", "output"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        return []

    # One dict can hold several cards, if the model numbered its keys rather
    # than adding entries to the list.
    flattened: list[object] = []
    for entry in data:
        expanded = _expand_numbered(entry) if isinstance(entry, dict) else []
        flattened.extend(expanded or [entry])

    out: list[dict] = []
    for entry in flattened:
        if isinstance(entry, str):
            title, body = "", _clean(entry)
        elif isinstance(entry, dict):
            title = _clean(entry.get("title") or entry.get("name"))
            body = _clean(entry.get("body") or entry.get("text") or entry.get("content"))
        else:
            continue
        if body and looks_like_leaked_schema(body):
            continue
        if title and looks_like_placeholder(title):
            title = ""
        # An ordinary output card is useful information, not a label. The
        # heading is parsed separately; title-only entries here are malformed
        # schema debris and should never become empty canvas objects.
        if not body:
            continue
        out.append({"title": title[:TITLE_MAX] or None, "body": body or None})
        if len(out) >= limit:
            break
    return out


def _chat(
    prompt: str,
    system: str,
    config: AiConfig,
    *,
    json_mode: bool = True,
    response_format: dict | None = None,
) -> str:
    headers = {}
    if config.chat_api_key:
        headers["Authorization"] = f"Bearer {config.chat_api_key}"
    body = {
        "model": config.chat_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "stream": False,
    }
    if json_mode:
        # Honoured by Ollama, llama.cpp, LM Studio, and the OpenAI API. Servers
        # that don't know it mostly ignore it; the ones that reject it get a
        # second try without, which is what keeps "point it anywhere" true.
        body["response_format"] = response_format or {"type": "json_object"}
    url = f"{config.chat_base_url}/chat/completions"
    resp = httpx.post(url, json=body, headers=headers, timeout=TIMEOUT_SECONDS)
    if resp.status_code in (400, 422) and response_format is not None:
        log.info("endpoint rejected JSON schema, retrying with JSON object mode")
        body["response_format"] = {"type": "json_object"}
        resp = httpx.post(url, json=body, headers=headers, timeout=TIMEOUT_SECONDS)
    if resp.status_code in (400, 422) and "response_format" in body:
        log.info("endpoint rejected response_format, retrying without it")
        body.pop("response_format")
        resp = httpx.post(url, json=body, headers=headers, timeout=TIMEOUT_SECONDS)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"] or ""


def coerce_hero(data: object) -> dict | None:
    """Turn the collection label into the existing title-card payload.

    `hero` remains the downstream name for compatibility with stored batches
    and the inbox UI. The model-facing contract uses a plain `group_title`
    string so it cannot confuse a heading with another informational card.
    Legacy object responses are still read, but their body is intentionally
    discarded.
    """
    if not isinstance(data, dict):
        return None
    raw = data.get("group_title")
    if isinstance(raw, dict):
        raw = raw.get("title") or raw.get("name")
    if raw is None:
        legacy = data.get("hero") or data.get("header") or data.get("summary")
        raw = (
            legacy.get("title") or legacy.get("name")
            if isinstance(legacy, dict)
            else legacy
        )
    title = _clean(raw)
    if not title or looks_like_placeholder(title) or looks_like_leaked_schema(title):
        return None
    return {"title": title[:TITLE_MAX], "body": None}


def split_text(
    text: str, config: AiConfig | None = None, limit: int = DEFAULT_CARD_LIMIT
) -> dict:
    """Returns `{"hero": card | None, "cards": [...]}`.

    An empty result is reported to the caller, never written anywhere. The
    hero is optional in both directions: the model may not produce one, and
    nothing downstream requires it.
    """
    empty: dict = {"hero": None, "cards": []}
    config = config or get_ai_config()
    if not config.generation_configured or not text.strip():
        return empty
    system = system_prompt(limit)
    response_format = split_response_format(limit)

    def parse(raw: str) -> dict:
        parsed = _extract_json(raw)
        if parsed is None:
            log.info("model returned no parseable split JSON: %s", raw[:200])
            return empty
        cards = coerce_cards(parsed, limit)
        if len(cards) < 2:
            raw_cards = parsed.get("cards") if isinstance(parsed, dict) else parsed
            count = len(raw_cards) if isinstance(raw_cards, list) else None
            log.info(
                "model returned an under-split result: parsed_entries=%s usable_cards=%s",
                count,
                len(cards),
            )
            return empty
        return {"hero": coerce_hero(parsed), "cards": cards}

    first = parse(
        _chat(text, system, config, response_format=response_format)
    )
    if first["cards"]:
        return first

    # One repair attempt is cheaper than making the person repeat the same
    # action several times. This is only reached when schema decoding was
    # ignored/rejected or the model still returned too little to be a split.
    repair = (
        system
        + "\n\nThe previous response was unusable. Return the required JSON now, "
        "with at least two substantive informational cards."
    )
    return parse(_chat(text, repair, config, response_format=response_format))


DOCUMENT_SYSTEM_PROMPT = (
    "You turn a set of connected note cards into one useful document. "
    "You are an editor, not a researcher.\n\n"
    "Return Markdown only. The first line must be one H1 heading containing "
    "the document title. Before every block after the title — a heading, "
    "paragraph, list, table, or code block — write an HTML comment naming "
    "the source labels, for example <!-- sources: S1,S3 -->.\n\n"
    "Rules:\n"
    "- Use only facts present in the supplied cards. Do not invent missing "
    "facts, examples, dates, or conclusions.\n"
    "- Choose a reader-first structure: context, central idea, development, "
    "evidence and counterpoints, then implications or next steps when present.\n"
    "- Relationship types are editorial instructions: follows_from sets "
    "sequence; supports and source_for place evidence with its claim; "
    "contradicts places the counterpoint beside the challenged claim.\n"
    "- Group repeated ideas instead of repeating them. Preserve meaningful "
    "disagreement rather than smoothing it away.\n"
    "- If existing_outline is supplied, preserve those headings and their "
    "order so a refreshed document remains structurally stable.\n"
    "- Write clear Markdown with short descriptive headings. Do not add a "
    "References section unless the cards contain actual references.\n"
    "- Every factual block must have a source comment. Use only the S labels "
    "provided with the cards. A synthesized block may cite several labels.\n"
    "- Never mention source labels in the prose, card IDs, the canvas, these "
    "rules, or that an AI wrote it.\n"
    "- Do not wrap the Markdown in a code fence and do not add commentary."
)


def document_source(card: Card) -> str:
    """The human-readable material from a selected card, without UI metadata."""
    unfurl = card.payload.get("unfurl") or {}
    parts = [
        card.body or "",
        str(card.payload.get("transcript") or ""),
        str(unfurl.get("description") or ""),
        str(card.payload.get("url") or ""),
    ]
    return "\n\n".join(part for part in parts if part.strip()).strip()


def coerce_document(data: object) -> dict | None:
    """Accept a few predictable aliases without accepting an ungrounded blob."""
    if not isinstance(data, dict):
        return None
    nested = data.get("document")
    if isinstance(nested, dict):
        data = nested
    title = _clean(data.get("title") or data.get("name"))[:TITLE_MAX]
    body = _clean(data.get("body") or data.get("markdown") or data.get("content"))
    if not body:
        return None
    return {"title": title or None, "body": body[:DOCUMENT_MAX_CHARS]}


def parse_document_response(raw: str) -> dict | None:
    """Accept Markdown natively and the old JSON response for compatibility.

    A long Markdown value inside JSON is needlessly difficult for small local
    models: one literal newline inside the string invalidates the whole reply.
    Markdown already carries its own title cleanly, so it is the primary wire
    format for composition.
    """
    parsed = _extract_json(raw)
    document = coerce_document(parsed) if parsed is not None else None
    if document is not None:
        return document

    text = _strip_reasoning(raw).strip()
    fenced = re.fullmatch(
        r"```(?:markdown|md)?\s*\n?(.*?)\n?```", text, re.DOTALL | re.IGNORECASE
    )
    if fenced:
        text = fenced.group(1).strip()
    if not text:
        return None

    heading = re.match(r"^#\s+(.+?)\s*(?:\n+|$)", text)
    title = None
    if heading:
        title = heading.group(1).strip()[:TITLE_MAX] or None
        text = text[heading.end() :].strip()
    if not text:
        return None
    return {"title": title, "body": text[:DOCUMENT_MAX_CHARS]}


_SOURCE_MARKER = re.compile(
    r"<!--\s*sources?\s*:\s*([^>]+?)\s*-->", re.IGNORECASE
)


def markdown_blocks(body: str) -> list[str]:
    """A conservative fallback when a model omits provenance markers."""
    return [block.strip() for block in re.split(r"\n\s*\n", body) if block.strip()]


def source_blocks(body: str, labels: dict[str, str]) -> tuple[str, list[dict]]:
    """Strip model-only markers and retain their block-level provenance."""
    all_sources = list(labels.values())
    matches = list(_SOURCE_MARKER.finditer(body))
    blocks: list[dict] = []

    # Anything before the first marker was not attributed. Keep it rather
    # than dropping prose, but conservatively attach every selected source.
    prefix = body[: matches[0].start()].strip() if matches else body.strip()
    for markdown in markdown_blocks(prefix):
        blocks.append({"markdown": markdown, "source_card_ids": all_sources})

    for index, marker in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        markdown = body[marker.end() : end].strip()
        if not markdown:
            continue
        requested = [part.strip().upper() for part in marker.group(1).split(",")]
        sources = list(dict.fromkeys(labels[label] for label in requested if label in labels))
        blocks.append(
            {
                "markdown": markdown,
                "source_card_ids": sources or all_sources,
            }
        )

    if not blocks:
        return body.strip(), []
    clean = "\n\n".join(block["markdown"] for block in blocks)
    for index, block in enumerate(blocks, start=1):
        block["id"] = f"block-{index}"
    return clean[:DOCUMENT_MAX_CHARS], blocks


def compose_document(
    cards: list[Card],
    relationships: list[dict],
    config: AiConfig | None = None,
    outline: list[str] | None = None,
) -> dict | None:
    """Ask the configured small model to plan and write one grounded document."""
    config = config or get_ai_config()
    if not config.generation_configured:
        return None

    sources = []
    labels: dict[str, str] = {}
    remaining = DOCUMENT_MAX_CHARS
    for card in cards:
        content = document_source(card)
        if not content and not card.title:
            continue
        # Share the budget across cards in selection order. The endpoint caps
        # the count, and truncation is explicit so a modest local context
        # window never receives an accidentally unbounded prompt.
        content = content[: max(0, remaining)]
        remaining -= len(content)
        label = f"S{len(sources) + 1}"
        labels[label] = str(card.id)
        sources.append({"id": label, "title": card.title or "", "content": content})
        if remaining <= 0:
            break

    if len(sources) < 2:
        return None
    id_to_label = {card_id: label for label, card_id in labels.items()}
    links = []
    for relation in relationships:
        source = id_to_label.get(str(relation.get("source")))
        target = id_to_label.get(str(relation.get("target")))
        if source and target:
            links.append({**relation, "source": source, "target": target})
    request = {"cards": sources, "relationships": links}
    if outline:
        request["existing_outline"] = outline
    prompt = json.dumps(request, ensure_ascii=False)
    raw = _chat(prompt, DOCUMENT_SYSTEM_PROMPT, config, json_mode=False)
    document = parse_document_response(raw)
    if document is None:
        log.info("document composer returned no usable Markdown: %s", raw[:200])
        return None
    body, blocks = source_blocks(document["body"], labels)
    document["body"] = body
    document["blocks"] = blocks
    return document
