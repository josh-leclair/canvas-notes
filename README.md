# Canvas Notes

A canvas-first note app: notes are cards placed freely on auto-growing
canvases, and the links between them are first-class objects with their own metadata. See
[docs/canvas-notes-design.md](docs/canvas-notes-design.md) for the why and
[docs/milestone-1-2-spec.md](docs/milestone-1-2-spec.md) for the what.

Canvas Notes is source-available and freely self-hostable for noncommercial
purposes under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).
[Separate commercial licensing](COMMERCIAL-LICENSE.md) is available from the
copyright holder.

All eight planned milestones are implemented:

1. **Foundation** — accounts, invites, canvases, cards, drag/pan/zoom
2. **Inbox** — unplaced cards, drag-to-place, remove vs delete
3. **Links** — metadata, the 2-hop direction-locked reveal, and portals
4. **Card types** — text, link (OpenGraph unfurl), YouTube, audio +
   transcription, image (paste or upload)
5. **Capture** — API tokens, `/api/capture`, iOS Shortcut, Telegram bot
   (text, links, voice notes and images; Discord is foundation-only, see below)
6. **Sharing** — viewer/editor roles, derived visibility, link revocation
7. **Search** — full text everywhere, semantic + suggestions where embeddings exist
8. **Polish** — undo for placement, cheat sheet, discoverability

Plus the work that hands-on use asked for afterwards:

- **Nested boards** — a board card points at another canvas, so canvases nest
  spatially. The same canvas can appear on several boards at once.
- **Columns** — titled vertical stacks; membership is per-canvas, so a card can
  be stacked on one board and loose on another.
- **Hubs** — fold a card's linked children away; stored on the canvas, so a
  shared board looks the same to everyone.
- **Rich text** — GFM markdown with live checkboxes, bullets, and tables.
- **Card colours** — eight named paints, or any colour off the wheel, on as
  many of a card's parts as its type offers. A custom colour has its border
  and its text colour worked out from it, so the card stays readable.
- **Three themes** — Paper, Ink, Dusk — plus canvas cover images.
- **Daily cards** — one ordinary card per local calendar day. Once opened,
  cards you create or change are connected to it automatically; selecting a
  card without acting on it does not add noise to the day.
- **Focus shelf** — pin a temporary working set across canvases without
  copying card content; selecting a shelf item jumps back to where it lives.
- **Card references** — type `[[` in a note or document to insert a stable,
  clickable reference. Inline references create graph relationships, and
  removing the reference removes the derived relationship again.
- **Portal cards** — live, deterministic views over another canvas or the
  whole workspace. Filter by words, card type, or unfinished tasks; click a
  result to open the canonical card, drag it out to place that same card here,
  or drop a card onto a canvas portal to place it on the watched canvas.
- **Public lenses** — publish an explicitly reviewed selection as a frozen,
  anonymous, read-only canvas. Cross-boundary references are stripped, media
  is copied into the published revision, and the same URL can be updated or
  revoked without exposing later private edits.

Design calls are recorded in
[docs/milestone-3-4-decisions.md](docs/milestone-3-4-decisions.md),
[docs/milestone-5-8-decisions.md](docs/milestone-5-8-decisions.md), and
[docs/beyond-milestones-decisions.md](docs/beyond-milestones-decisions.md).
**Before changing the canvas, read [docs/invariants.md](docs/invariants.md)** —
the rules the code depends on and the mistakes already made against them.

## Self-host with Docker Compose

### Local or private-network installation

Install Docker with the Compose plugin, clone this repository, and create your
local configuration:

```bash
git clone https://github.com/josh-leclair/canvas-notes.git
cd canvas-notes
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `.env` as `SESSION_SECRET`. If you are serving over
plain HTTP on a trusted LAN, also set `COOKIE_SECURE=false` and
`BIND_ADDRESS=0.0.0.0`. Keep the default loopback binding when access is through
a reverse proxy or Tailscale Serve. Then start the core application:

```bash
docker compose up --build
```

The app is at http://localhost:8080. The first account registered becomes the
admin, then registration closes; the admin issues invites from the canvas list
page.

The worker for local transcription, embeddings, and capture bots is optional
and uses substantially more disk and memory. Include it when those features are
wanted:

```bash
docker compose --profile worker up --build
```

### Public VPS with automatic HTTPS

Point a DNS `A`/`AAAA` record at the VPS and allow inbound TCP ports 80 and 443
and UDP port 443. Set `DOMAIN` to that hostname in `.env`, leave
`COOKIE_SECURE=true`, and start the production override:

```bash
docker compose -f docker-compose.yml -f docker-compose.production.yml up -d --build
```

Caddy obtains and renews the TLS certificate automatically. The backend and
database are not published to the internet; only Caddy is public. The base app
also remains available on `127.0.0.1:8080` for local diagnostics.

### Use an existing PostgreSQL server

Canvas Notes can use PostgreSQL managed by another Compose project, another
machine, or a hosted provider. Give it a dedicated database and preferably a
dedicated login rather than sharing another application's database or schema.
The server must have the `pgcrypto`, `citext`, and pgvector `vector` extensions
available. A database administrator can enable them before first boot:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;
```

The Canvas Notes login needs permission to connect and to create and alter
objects in its database's `public` schema. The app runs its own migrations but
does not need permission to manage other databases.

Set the SQLAlchemy/psycopg connection URL in `.env`; percent-encode reserved
characters in the username or password:

```dotenv
DATABASE_URL=postgresql+psycopg://canvas_notes:password@postgres.example:5432/canvas_notes
```

Append `?sslmode=require` when the provider requires TLS. Then use the external
database override, which disables the bundled `db` container. This override
requires Docker Compose 2.24 or newer:

```bash
docker compose -f docker-compose.yml -f docker-compose.external-db.yml up -d --build
```

For a public HTTPS deployment, combine both overrides:

```bash
docker compose -f docker-compose.yml -f docker-compose.external-db.yml -f docker-compose.production.yml up -d --build
```

Add `--profile worker` to either command when transcription, embeddings, or
capture bots are wanted. The external PostgreSQL server must be reachable from
Docker containers; `localhost` inside a container refers to that container, not
the Docker host. On Docker Desktop, `host.docker.internal` reaches the host. On
a Linux VPS, use the database server's reachable DNS name or address and apply
appropriate firewall and TLS rules.

To update an installation:

```bash
git pull --ff-only
docker compose -f docker-compose.yml -f docker-compose.production.yml up -d --build
```

Review release notes and take a backup before updating. Database migrations run
automatically when the backend starts.

### Backups

Back up both PostgreSQL and uploaded files; one without the other is incomplete.
For the bundled database:

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U canvas -d canvas -Fc > backups/canvas-db.dump
docker compose exec -T backend tar -C /data/files -czf - . > backups/canvas-files.tar.gz
```

With external PostgreSQL, use the provider's snapshots or run `pg_dump` against
the external connection, and use the same backend command for uploaded files.
The external-database override does not move uploads into PostgreSQL.

Store `.env` securely as well. `SESSION_SECRET` is required to decrypt saved AI
API keys, so losing or changing it makes those saved keys unreadable. Test the
restore procedure before relying on a backup. See [SECURITY.md](SECURITY.md) for
private vulnerability reporting.

### Reaching it from a phone

On a phone the same URL opens the mobile projection rather than the canvas:
the home screen is a multi-type card composer, and boards open as their inbox
plus collapsible zones. Create and resize zones with the **Zone** tool on the
desktop canvas; cards outside every zone stay out of the mobile board view.

`COOKIE_SECURE=false` and the Tailscale IP is enough for a LAN, but the
better answer is to let Tailscale terminate TLS for you:

```
tailscale serve --bg http://localhost:8080
```

That publishes the app at `https://<machine>.<tailnet>.ts.net` **to your
tailnet only** — not the public internet. Three things it buys over hitting
the Tailscale IP directly: a real certificate, so iOS raises nothing about an
insecure origin; a stable hostname to put in a Shortcut, rather than an IP;
and no Windows Firewall rule, because Tailscale connects to `localhost`
rather than arriving on an interface.

`tailscale serve --https=443 off` undoes it. Do not reach for
`tailscale funnel` instead — that is the same thing exposed to the whole
internet.

The optional `worker` service transcribes audio with faster-whisper (model set by
`WHISPER_MODEL`, default `small`; first run downloads it) and runs the capture
bots. It is optional — without it, unfurls still happen in the API's inline
worker and other jobs simply wait in the queue.

### Optional configuration

```
TELEGRAM_BOT_TOKEN=   # enables the Telegram capture bot (outbound polling,
                      # so it works behind NAT with no port forwarding)
EMBEDDING_BASE_URL=   # any OpenAI-compatible endpoint, e.g. http://host:11434/v1
EMBEDDING_MODEL=      # e.g. nomic-embed-text or bge-small
EMBEDDING_API_KEY=    # only if your endpoint wants one
EMBEDDING_DIM=768     # must match the model; changing it needs a re-migration

WHISPER_BASE_URL=     # an OpenAI-compatible /audio/transcriptions endpoint,
                      # for anyone already self-hosting whisper. Leave empty
                      # to transcribe locally inside the worker container.
WHISPER_MODEL=        # blank for a remote server that loads its own model;
                      # names the weights for local transcription (default small)
WHISPER_API_KEY=

CHAT_BASE_URL=        # an OpenAI-compatible /chat/completions endpoint, for
                      # splitting a long card into inbox cards. Leave empty
                      # and the feature stays hidden.
CHAT_MODEL=           # e.g. gemma3:12b or mistral-nemo:12b
CHAT_API_KEY=
```

These are only the **seed and fallback**. An admin can set all of them in
**Settings → AI endpoints** without a redeploy; saved values take precedence,
API keys are encrypted at rest with a key derived from `SESSION_SECRET`, and
clearing a field falls back to the environment again. Bootstrap settings
(`DATABASE_URL`, `SESSION_SECRET`, `COOKIE_SECURE`) stay environment-only,
since they are needed before the database is reachable.

The Test button round-trips the embedding endpoint and reports the dimension
it actually returns. Changing that dimension discards existing embeddings and
re-embeds every card, so it asks for confirmation first rather than saving
quietly.

With a chat endpoint configured, a card's ⋯ menu gains **Split into cards**:
the model breaks a long note, transcript, or article into separate cards that
land in your inbox, unplaced. Splitting is deliberately narrow — it never writes
to a canvas, never edits the
source card, and never invents links. Arranging and connecting the results is
the human half, which is where the meaning in this app lives. A batch can be
thrown away in one action, and anything you have already placed survives that.
The Test split button exercises the real path and reports what came back,
since the question with a small local model is not whether it answers but
whether it can hold to plain JSON.

Selecting two or more cards also reveals **Draft selected**. The model turns
their content and typed relationships into a living document placed beside
the selection. Every generated block retains its source-card ids and source
timestamps outside the Markdown, and the document editor renders those as
clickable source chips. Changed source cards mark their dependent blocks
stale. **Refresh changed** performs a block-level three-way merge: untouched
generated blocks update, while manually edited blocks and titles are kept
verbatim and remain visibly stale until reconciled. Documents generated by
the earlier composer can add provenance without rewriting their existing
text.

Everything here degrades to hidden rather than broken. With no embedding
endpoint, search still works on words alone and the suggestion panels stay
out of the way. With no chat endpoint, the split menu item never appears.
With no bot token, the bot never starts.

### Capture

Create an API token under **Settings**, then post to `/api/capture`:

```bash
curl -X POST http://localhost:8080/api/capture -H "Authorization: Bearer cnv_..." -H "Content-Type: application/json" -d '{"text":"a thought","url":"https://example.com"}'
```

Files go to `/api/capture/file` instead, as multipart — text and a file
cannot travel in one request, and folding both into `/api/capture` would have
meant turning its JSON fields into form fields and breaking every shortcut
already posting to it:

```
curl -X POST http://localhost:8080/api/capture/file -H "Authorization: Bearer cnv_..." -F file=@photo.png -F title="from my phone"
```

A picture becomes an image card, a voice memo an audio card with transcription
queued, and anything else a file card.

Everything captured lands in the inbox unplaced. Settings also has the iOS
Shortcut recipe and the bot pairing flow: generate a code, send it to the bot
once, and it remembers you. Messages from unpaired senders are dropped.

**Discord is foundation only.** The pairing model, identity table, and shared
message handler are all platform-agnostic and tested; what is missing is the
gateway websocket client.
[docs/build-the-discord-bot.md](docs/build-the-discord-bot.md) is a complete
brief for finishing it — one new file and two lines elsewhere.

## Development

Backend (needs a Postgres 16 reachable via `DATABASE_URL`; default is
`postgresql+psycopg://canvas:canvas@localhost:5432/canvas`):

```
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements-dev.txt
.venv\Scripts\alembic upgrade head
.venv\Scripts\uvicorn app.main:app --reload
```

Frontend (dev server proxies `/api` to `localhost:8000`, so the session cookie
stays same-origin):

```
cd frontend
npm install
npm run dev
```

A convenient dev database:

```
docker run -d --name canvas-pg -e POSTGRES_USER=canvas -e POSTGRES_PASSWORD=canvas -e POSTGRES_DB=canvas -p 5432:5432 pgvector/pgvector:pg16
```

Note the pgvector image: milestone 7 adds a `vector` column, so a plain
`postgres:16` will fail that migration. The images are data-compatible, so an
existing volume can simply be pointed at the new image.

## Tests

The backend integration tests run against a real Postgres and skip when none is
reachable; pure-function tests still run. The suite truncates tables between
integration tests, so point it at a disposable database, never one with data
you care about. By default it uses
`postgresql+psycopg://canvas:canvas@localhost:5432/canvas_test`; override with
`TEST_DATABASE_URL`.

```
docker run -d --name canvas-test-pg -e POSTGRES_USER=canvas -e POSTGRES_PASSWORD=canvas -e POSTGRES_DB=canvas_test -p 5433:5432 pgvector/pgvector:pg16
```

```
cd backend
$env:DATABASE_URL="postgresql+psycopg://canvas:canvas@localhost:5433/canvas_test"
.venv\Scripts\python -m pytest tests
```

300 tests covering the milestone acceptance criteria: registration/invite rules,
cross-user isolation (404, never 403), canvas deletion leaving cards unplaced,
duplicate placement 409s, inbox derivation and pagination, link snapshots, the
direction-locked reveal (a hub card must not light up sideways), hard-delete
link cleanup, job-queue claim semantics, audio file ownership, bearer-token auth
and revocation, bot pairing (single-use codes, per-platform identities,
silence for unpaired senders), the full sharing matrix, link visibility
requiring both endpoints, revocation on unshare, and search scoping. Later work
adds board-card resolution and nesting derivation, column parent constraints
(same canvas, columns only, no self-parenting, no nesting), canvas covers, and
encrypted runtime settings, checklist and table cards (structure in the
payload, a markdown mirror regenerated on every write so search still sees
them), file-card uploads (name and extension sanitising, attachments never served inline, a file following its card), and card splitting (output lands unplaced and
stamped, batches discard without touching what you already placed, generated
cards stay out of link suggestions until one is placed). The SSRF guard, unfurl
parser, URL-typing, and model-output parsing tests are pure functions and run
without a database.

The suite is backend-only. The canvas interactions it does not reach — drag,
drop-into-column, resize, undo — are exactly where the bugs have been, so
changes there need hands-on verification; see
[docs/invariants.md](docs/invariants.md) for the checklist.

## Notes

- Press `?` in a canvas for every gesture and shortcut.
- Position writes are per placement, debounced 200ms, fired on drop only.
- Undo (`Ctrl/Cmd+Z`) covers placement geometry and removals only — moves,
  resizes, and remove-from-canvas. Content edits and deletions are not
  undoable; both have confirmations instead.
- All permission logic lives in `backend/app/access.py`. Nothing else should
  hand-roll an ownership check.
- Adding a chat platform means writing one adapter in `backend/app/bots/`;
  pairing, identity, and capture are already platform-agnostic.
- Card bodies are GFM markdown. Checkboxes are clickable on the card itself.
- Never use `window.confirm` / `prompt` / `alert` — they are suppressed in the
  target browser and fail silently. Use `dialogStore`. This one has bitten.
- Colours, radii, shadows, and motion are tokens in `frontend/src/theme.css`;
  no literal values anywhere else, or the themes drift apart.

### Still open

- **Discord gateway client** — everything around it is built and tested.
- **Realtime collaboration.** Sharing reconciles on refresh, per the design
  doc's non-goals; last write wins, mitigated by per-card position writes.
- **Generation features** (auto-titles for captured cards, audio cleanup,
  drafted link reasons) — the job queue and the "every output is a
  suggestion" rule are in place to hang them on.

### Known rough edges

- Dragging several cards at once pushes one undo entry per card, so undoing
  that move takes several presses.
- Searching while a reveal is active leaves the reveal's arrows drawn over
  dimmed cards.
- Colour is not yet a search filter, though named paints were chosen to make
  that possible.

## License

Copyright 2026 josh-leclair. Canvas Notes is distributed under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). The license permits use,
modification, and redistribution for permitted noncommercial purposes. Uses
outside those terms require a [separate commercial license](COMMERCIAL-LICENSE.md).

This is a source-available license, not an OSI-approved open-source license.
