"""Instance settings that can be changed without a redeploy.

Resolution order is database, then environment, then default. Environment
variables therefore act as the seed for a fresh instance and as the fallback
for anything never set in the app, so existing deployments keep working
unchanged and nobody is forced to move their configuration.

Bootstrap settings (DATABASE_URL, SESSION_SECRET, COOKIE_SECURE) stay
environment-only: they are needed before the database is reachable.
"""
import time
from dataclasses import dataclass, replace

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import settings
from app.crypto import decrypt, encrypt
from app.db import SessionLocal
from app.models import AppSetting

AI_KEY = "ai"
CACHE_TTL_SECONDS = 10.0

SECRET_FIELDS = ("embedding_api_key", "whisper_api_key", "chat_api_key")


@dataclass(frozen=True)
class AiConfig:
    embedding_base_url: str = ""
    embedding_model: str = ""
    embedding_api_key: str = ""
    embedding_dim: int = 768
    whisper_base_url: str = ""
    whisper_model: str = ""
    whisper_api_key: str = ""
    chat_base_url: str = ""
    chat_model: str = ""
    chat_api_key: str = ""

    @property
    def embeddings_configured(self) -> bool:
        return bool(self.embedding_base_url and self.embedding_model)

    @property
    def generation_configured(self) -> bool:
        return bool(self.chat_base_url and self.chat_model)


def _from_env() -> AiConfig:
    return AiConfig(
        embedding_base_url=settings.embedding_base_url,
        embedding_model=settings.embedding_model,
        embedding_api_key=settings.embedding_api_key,
        embedding_dim=settings.embedding_dim,
        whisper_base_url=settings.whisper_base_url,
        whisper_model=settings.whisper_model,
        whisper_api_key=settings.whisper_api_key,
        chat_base_url=settings.chat_base_url,
        chat_model=settings.chat_model,
        chat_api_key=settings.chat_api_key,
    )


_cache: tuple[float, AiConfig] | None = None


def invalidate_cache() -> None:
    global _cache
    _cache = None


def _load(db: DbSession) -> AiConfig:
    row = db.get(AppSetting, AI_KEY)
    config = _from_env()
    if row is None:
        return config

    stored = dict(row.value or {})
    for field in SECRET_FIELDS:
        if field in stored:
            stored[field] = decrypt(str(stored[field]))
    # Only keys actually present in the row override the environment, so
    # clearing a field in the app is distinct from never having set it.
    known = {f for f in AiConfig.__dataclass_fields__}
    overrides = {k: v for k, v in stored.items() if k in known and v not in (None, "")}
    if "embedding_dim" in overrides:
        overrides["embedding_dim"] = int(overrides["embedding_dim"])
    return replace(config, **overrides)


def get_ai_config(db: DbSession | None = None) -> AiConfig:
    """Cached briefly: the worker asks on every loop, and a settings change
    should still land within seconds across processes."""
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < CACHE_TTL_SECONDS:
        return _cache[1]

    if db is not None:
        config = _load(db)
    else:
        with SessionLocal() as own:
            config = _load(own)
    _cache = (now, config)
    return config


def save_ai_config(db: DbSession, updates: dict, user_id) -> AiConfig:
    row = db.get(AppSetting, AI_KEY)
    stored = dict(row.value) if row is not None else {}

    for key, value in updates.items():
        if key not in AiConfig.__dataclass_fields__:
            continue
        if key in SECRET_FIELDS:
            # An omitted or unchanged secret is left alone; an explicit empty
            # string clears it.
            if value is None:
                continue
            stored[key] = encrypt(value) if value else ""
        else:
            stored[key] = value

    if row is None:
        row = AppSetting(key=AI_KEY, value=stored, updated_by=user_id)
        db.add(row)
    else:
        row.value = stored
        row.updated_by = user_id
    db.flush()
    invalidate_cache()
    return _load(db)


def env_seeded_fields() -> set[str]:
    """Which fields the environment supplies, for the settings UI to label."""
    env = _from_env()
    return {
        name
        for name in AiConfig.__dataclass_fields__
        if getattr(env, name) and name not in SECRET_FIELDS
    }
