"""Discord capture bot: foundation only, not implemented yet.

Everything a Discord bot needs from this app already exists — pairing codes
are platform-agnostic, `bot_identities.platform` distinguishes sources, and
`handle_message` owns identity resolution and capture. What is missing is the
gateway client itself (Discord needs a persistent websocket, unlike
Telegram's HTTP long poll), which is why this ships as a stub.

`docs/build-the-discord-bot.md` is a complete implementation brief for this
file: the gateway opcode sequence, the intents to ask for, how to map a
Discord message onto `IncomingMessage`, what to test, and the mistakes that
bite. Follow it.
"""
import threading

from app.config import settings


class DiscordAdapter:
    platform = "discord"

    @staticmethod
    def configured() -> bool:
        # Deliberately always False: even with a token set, the gateway client
        # does not exist yet, so the supervisor must not try to start it.
        return False

    @staticmethod
    def token_present() -> bool:
        return bool(settings.discord_bot_token)

    def run(self, stop: threading.Event) -> None:
        raise NotImplementedError(
            "The Discord adapter is a foundation stub; the gateway client is not built."
        )
