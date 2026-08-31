# Build the Discord capture bot

An implementation brief. Everything the bot needs from this application
already exists and is tested; what is missing is a Discord gateway client.
This document is meant to be enough on its own — read it, then write one file
and change two lines.

**Scope.** Direct messages to the bot become cards in the sender's inbox,
exactly as the Telegram bot already does. Nothing about guilds, slash
commands, or replies-in-channels is in scope.

---

## 1. What already exists

Read these three files before writing anything. They are short.

| File | What it gives you |
|---|---|
| `backend/app/bots/base.py` | `IncomingMessage`, `handle_message`, the `BotAdapter` protocol |
| `backend/app/bots/telegram.py` | A complete working adapter to pattern-match against |
| `backend/app/bots/supervisor.py` | Starts every adapter that reports itself configured |

### The contract

`handle_message(platform: str, message: IncomingMessage) -> str | None` owns
**all** of the policy. Do not reimplement any of it:

- resolving a platform user id to an app user via `bot_identities`
- consuming a pairing code when an unpaired sender sends one
- dropping unpaired senders (it returns a one-line hint for plain text, and
  `None` for anything else)
- creating the card, including choosing text vs link vs youtube
- writing the audio file and queueing transcription

Your adapter's entire job is to turn a Discord message into this:

```python
@dataclass
class IncomingMessage:
    platform_user_id: str          # str(author.id)
    text: str | None = None        # message content, or the caption
    audio: tuple[bytes, str] | None = None   # (content, mime)
    attachments: list[str] = field(default_factory=list)
```

…call `handle_message("discord", incoming)`, and send the returned string
back to the user as a DM. Return value `None` means stay silent.

The platform string **must** be `"discord"`. `bot_identities` is unique on
`(platform, platform_user_id)`, so this is what keeps a Discord account
distinct from a Telegram account with a numerically equal id. There is a test
covering exactly that (`test_pairing_is_per_platform`).

### The adapter protocol

```python
class BotAdapter(Protocol):
    platform: str

    @staticmethod
    def configured() -> bool: ...

    def run(self, stop: threading.Event) -> None: ...
```

`run` is called on its own daemon thread and must return promptly once `stop`
is set. The supervisor already lists `DiscordAdapter` in
`backend/app/bots/__init__.py`; it is skipped only because `configured()`
currently returns `False` unconditionally.

---

## 2. What to change

### 2.1 `backend/app/bots/discord.py` — replace the stub

This is the only file with real work in it. Details in section 3.

### 2.2 `configured()` must start returning the truth

```python
@staticmethod
def configured() -> bool:
    return bool(settings.discord_bot_token)
```

`settings.discord_bot_token` already exists in `backend/app/config.py`, read
from `DISCORD_BOT_TOKEN`. Delete the `token_present()` helper — it exists only
because `configured()` was lying.

### 2.3 `backend/app/bots/__init__.py`

No change. `DiscordAdapter` is already in `ADAPTERS`.

### 2.4 `backend/requirements.txt`

Add a websocket client:

```
websockets>=12.0
```

Do **not** add `discord.py`. It brings its own event loop, its own lifecycle,
and a large dependency tree, to use perhaps 5% of it. The gateway subset this
needs is about 120 lines.

### 2.5 `docker-compose.yml`

Add to the `worker` service's environment, next to `TELEGRAM_BOT_TOKEN`:

```yaml
      DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN:-}
```

### 2.6 `README.md`

Under "Optional configuration", add `DISCORD_BOT_TOKEN` beside the Telegram
one, and delete the paragraph beginning "**Discord is foundation only.**"

---

## 3. The gateway client

### 3.1 Threading model

`run()` is synchronous and runs on a thread. `websockets` is asyncio. Bridge
them by owning an event loop for the lifetime of the thread:

```python
def run(self, stop: threading.Event) -> None:
    asyncio.run(self._main(stop))
```

Inside `_main`, poll `stop.is_set()` between reconnects and race it against
the socket read so shutdown is not delayed by an idle connection. A clean
pattern is a `asyncio.Event` mirrored from the threading one by a small
watcher task, or simply `asyncio.wait_for(ws.recv(), timeout=1)` in a loop
that re-checks `stop`.

### 3.2 Connection lifecycle

Connect to `wss://gateway.discord.gg/?v=10&encoding=json`.

Opcodes you need (field `op` on every frame):

| op | Name | Direction | Meaning |
|---|---|---|---|
| 10 | HELLO | receive | First frame. `d.heartbeat_interval` in ms |
| 1 | HEARTBEAT | send | `{"op": 1, "d": last_sequence}` |
| 11 | HEARTBEAT_ACK | receive | Response to yours |
| 2 | IDENTIFY | send | Authenticate |
| 0 | DISPATCH | receive | An event; `t` is the name, `s` the sequence |
| 7 | RECONNECT | receive | Drop and resume |
| 9 | INVALID_SESSION | receive | `d` is whether the session is resumable |
| 6 | RESUME | send | Resume after a drop |

The sequence:

1. Connect, read HELLO, note `heartbeat_interval`.
2. Start a task sending HEARTBEAT every interval (jitter the first one by a
   random fraction, as Discord asks). Always send the **last received `s`**,
   or `null` if none yet.
3. Send IDENTIFY (below).
4. Expect DISPATCH `READY`. Store `d.session_id` and `d.resume_gateway_url`.
5. Handle DISPATCH `MESSAGE_CREATE` events.
6. On RECONNECT, or a closed socket with a resumable code, reconnect to
   `resume_gateway_url` and send RESUME with `{token, session_id, seq}`.
   On INVALID_SESSION with `d == false`, discard the session and IDENTIFY
   afresh after a short wait.

Reconnect with exponential backoff, capped at ~60s. Never busy-loop: a bad
token will otherwise hammer Discord and get the instance rate-limited.

### 3.3 IDENTIFY

```json
{
  "op": 2,
  "d": {
    "token": "<DISCORD_BOT_TOKEN>",
    "intents": 4096,
    "properties": { "os": "linux", "browser": "canvas-notes", "device": "canvas-notes" }
  }
}
```

**Intents.** `4096` is `DIRECT_MESSAGES` (`1 << 12`). That is all this bot
needs: message content in DMs *to your app* is delivered without the
privileged `MESSAGE_CONTENT` intent. Do not request `MESSAGE_CONTENT`
(`1 << 15`) — it is privileged, requires review once an app is in 100+
guilds, and buys nothing here. If you also want attachments in DMs, they
arrive on the same events.

### 3.4 Handling MESSAGE_CREATE

The payload `d` is a Discord message object. Reject and ignore:

- `d.author.bot is True` — never respond to bots, including yourself. Missing
  this is the classic infinite-loop bug.
- `d.guild_id` present — this is a guild message, not a DM. Out of scope.

Then map it:

```python
author_id = str(d["author"]["id"])
channel_id = d["channel_id"]
content = (d.get("content") or "").strip()
attachments = d.get("attachments") or []
```

**Voice messages.** Discord marks them with flag `1 << 13` (8192) on
`d["flags"]`, and the attachment's `content_type` starts with `audio/`
(usually `audio/ogg`). Any audio attachment should be treated as a voice
note, flagged or not:

```python
audio_att = next(
    (a for a in attachments
     if (a.get("content_type") or "").startswith("audio/")),
    None,
)
```

Download it from `audio_att["url"]` with a plain GET — CDN links need no auth
— and cap the size the way the Telegram adapter does (`MAX_AUDIO_BYTES`,
50 MB). Pass `(content, mime)` as `IncomingMessage.audio`, and the message
content as `text` so it becomes the card title.

If there is no audio and no text, return without calling `handle_message`.

### 3.5 Replying

The gateway is receive-only for this purpose. Send the reply over REST:

```
POST https://discord.com/api/v10/channels/{channel_id}/messages
Authorization: Bot {token}
Content-Type: application/json

{"content": "<reply>"}
```

The DM channel id arrives on the message itself (`d["channel_id"]`), so there
is no need to open a DM channel first. Swallow and log failures — a failed
reply must never lose a captured card, which by then is already saved.

Respect 429: read `retry_after` from the JSON body and wait. One retry is
enough for a courtesy reply.

---

## 4. Sketch

Structure to aim for. Fill in the bodies.

```python
class DiscordAdapter:
    platform = "discord"

    @staticmethod
    def configured() -> bool:
        return bool(settings.discord_bot_token)

    def __init__(self) -> None:
        self.session_id: str | None = None
        self.resume_url: str | None = None
        self.sequence: int | None = None

    def run(self, stop: threading.Event) -> None:
        asyncio.run(self._main(stop))

    async def _main(self, stop): ...        # reconnect loop with backoff
    async def _session(self, stop, url, resume: bool): ...  # one connection
    async def _heartbeat(self, ws, interval): ...
    async def _on_message(self, data): ...  # filter, map, handle_message, reply
    async def _download(self, url) -> bytes | None: ...
    async def _reply(self, channel_id, text): ...
```

Keep `handle_message` off the event loop. It does blocking database work, so
call it through `asyncio.to_thread(handle_message, "discord", incoming)`.
Getting this wrong will stall heartbeats under load and cause Discord to
disconnect you as a zombie.

---

## 5. Testing

`backend/tests/test_bots.py` already covers pairing and capture through
`handle_message` directly, including a Discord-platform case. Do not
duplicate that. Add tests for the parts that are yours:

1. **Message mapping is pure.** Factor the "Discord message object →
   `IncomingMessage` or None" step into a module-level function taking a
   dict, and test it with no network: a plain DM, a bot author (ignored), a
   guild message (ignored), an empty message (ignored), a voice attachment,
   text plus attachment.
2. **`configured()` follows the token.** Mirror
   `test_adapter_configuration_gates` in `test_bots.py`, which currently
   asserts Discord is always off — **that assertion must be updated**, it is
   the one existing test your change breaks.
3. **Sequence tracking.** Given a series of frames, the client records the
   last `s` and sends it in heartbeats.

Do not write a test that opens a real gateway connection.

Run the suite the way the README describes; it needs the pgvector Postgres on
port 5433. Everything must stay green — 137 tests at the time of writing.

---

## 6. Manual verification

1. Create an application at <https://discord.com/developers/applications>,
   add a bot, copy its token.
2. Under **Bot → Privileged Gateway Intents**, leave everything off. You do
   not need any of them.
3. Put `DISCORD_BOT_TOKEN=…` in `.env`, then `docker compose up -d --build worker`.
4. `docker compose logs -f worker` should show `discord bot started`.
5. Invite the bot with the `bot` scope, or simply DM it — a bot can be DM'd
   by users who share a guild with it, so the simplest test is to add it to
   any server you own.
6. DM it anything. Expect the pairing hint.
7. Generate a pairing code in **Settings → Chat capture**, DM the code.
   Expect `Paired with <your name>`.
8. DM a sentence → a text card in your inbox. DM a URL → a link card that
   unfurls. DM a YouTube URL → a YouTube card. Record a voice message → an
   audio card with transcription queued.
9. Restart the worker mid-session and confirm it reconnects without
   re-pairing.

---

## 7. Things that will bite

- **Responding to your own messages.** Filter `author.bot` first, always.
- **Blocking the event loop.** `handle_message` touches Postgres. Use
  `asyncio.to_thread`.
- **Heartbeating with the wrong sequence.** Send the last received `s`, not a
  counter you maintain.
- **Reconnect storms.** An invalid token fails instantly and forever; without
  backoff you will send thousands of requests a minute.
- **Assuming DMs have `guild_id: null`.** The field is *absent*, not null.
  Use `"guild_id" in d`.
- **Attachment size.** Discord allows large uploads on boosted servers. Cap
  the download.
- **Shutdown.** `docker compose down` sends SIGTERM; `app/worker.py` sets the
  stop event. If `run()` blocks on a socket read with no timeout, the
  container will take the full 10s grace period to die every time.
