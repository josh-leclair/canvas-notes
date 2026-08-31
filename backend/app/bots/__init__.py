"""Chat capture bots.

Every platform-specific adapter converts its own message shape into
`handle_message`, which owns the entire policy: identity resolution, pairing,
dropping unpaired senders, and capture. Adding a platform is one adapter file.
"""
from app.bots.base import BotAdapter, handle_message
from app.bots.discord import DiscordAdapter
from app.bots.telegram import TelegramAdapter

ADAPTERS: list[type[BotAdapter]] = [TelegramAdapter, DiscordAdapter]

__all__ = ["BotAdapter", "handle_message", "ADAPTERS"]
