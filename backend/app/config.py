import os


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    def __init__(self) -> None:
        self.database_url = os.environ.get(
            "DATABASE_URL", "postgresql+psycopg://canvas:canvas@localhost:5432/canvas"
        )
        self.session_secret = os.environ.get("SESSION_SECRET", "")
        self.cookie_secure = _bool("COOKIE_SECURE", True)
        self.instance_name = os.environ.get("INSTANCE_NAME", "Canvas")
        self.files_dir = os.environ.get("FILES_DIR", "./data/files")
        self.worker_inline = _bool("WORKER_INLINE", True)

        # Transcription: either a local faster-whisper model, or any
        # OpenAI-compatible /audio/transcriptions endpoint for people already
        # self-hosting whisper (whisper.cpp server, faster-whisper-server, …).
        self.whisper_model = os.environ.get("WHISPER_MODEL", "")
        self.whisper_base_url = os.environ.get("WHISPER_BASE_URL", "").rstrip("/")
        self.whisper_api_key = os.environ.get("WHISPER_API_KEY", "")

        # Capture bots. Absent token means the adapter never starts.
        self.telegram_bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        self.discord_bot_token = os.environ.get("DISCORD_BOT_TOKEN", "")

        # Embeddings: an OpenAI-compatible base url plus a model name. Ollama,
        # LM Studio, and llama.cpp all speak this, and it means a user can
        # point at a hosted API instead without a second integration.
        self.embedding_base_url = os.environ.get("EMBEDDING_BASE_URL", "").rstrip("/")
        self.embedding_model = os.environ.get("EMBEDDING_MODEL", "")
        self.embedding_api_key = os.environ.get("EMBEDDING_API_KEY", "")
        self.embedding_dim = int(os.environ.get("EMBEDDING_DIM", "768"))

        # Generation: the same OpenAI-compatible shape again. Optional
        # throughout — every feature built on it hides when it is unset.
        self.chat_base_url = os.environ.get("CHAT_BASE_URL", "").rstrip("/")
        self.chat_model = os.environ.get("CHAT_MODEL", "")
        self.chat_api_key = os.environ.get("CHAT_API_KEY", "")

    @property
    def embeddings_configured(self) -> bool:
        return bool(self.embedding_base_url and self.embedding_model)


settings = Settings()
