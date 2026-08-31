"""Embedding via any OpenAI-compatible endpoint.

Ollama, LM Studio, and llama.cpp all speak this protocol, which also means a
user can point at a hosted API instead without a second integration existing.
Everything degrades to hidden when nothing is configured.
"""
import logging

import httpx

from app.models import Card
from app.runtime_settings import AiConfig, get_ai_config

log = logging.getLogger("embeddings")

TIMEOUT_SECONDS = 30.0
MAX_CHARS = 8000


def embeddable_text(card: Card) -> str:
    """Title, body, the unfurled description, and the transcript.

    Transcription pays for itself twice: it turns a voice memo from an opaque
    blob into something searchable and linkable.
    """
    unfurl = card.payload.get("unfurl") or {}
    parts = [
        card.title or "",
        card.body or "",
        str(unfurl.get("description") or ""),
        str(card.payload.get("transcript") or ""),
    ]
    return " ".join(part for part in parts if part).strip()[:MAX_CHARS]


def embed_raw(text: str, config: AiConfig) -> list[float]:
    """Call the endpoint and return whatever dimension it gives back.

    Used by the settings test, which needs the real dimension in order to
    tell the admin what changing models would cost.
    """
    headers = {}
    if config.embedding_api_key:
        headers["Authorization"] = f"Bearer {config.embedding_api_key}"
    resp = httpx.post(
        f"{config.embedding_base_url}/embeddings",
        json={"model": config.embedding_model, "input": text},
        headers=headers,
        timeout=TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]


def embed_text(text: str, config: AiConfig | None = None) -> list[float] | None:
    """Returns None when embeddings are not configured."""
    config = config or get_ai_config()
    if not config.embeddings_configured or not text.strip():
        return None
    vector = embed_raw(text, config)
    if len(vector) != config.embedding_dim:
        raise ValueError(
            f"model returned {len(vector)} dimensions, this instance stores "
            f"{config.embedding_dim}; change the embedding dimension in "
            f"Settings, which re-embeds every card"
        )
    return vector
