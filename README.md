# Canvas Notes

Canvas Notes is a self-hosted, canvas-first note app. Cards live freely in
space, can appear on more than one canvas, and stay connected through typed,
directional links.

![A Canvas Notes workspace with notes, a checklist, zones, a column, a live portal, and a nested board](assets/screenshots/canvas-overview.png)

Canvas Notes is source-available and freely self-hostable for noncommercial
purposes under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).
[Separate commercial licensing](COMMERCIAL-LICENSE.md) is available from the
copyright holder.

## What it does

- **Spatial canvases** — arrange, resize, group, and reuse cards on an
  auto-growing surface with placement undo.
- **Connected notes** — give links a direction, relationship type, and note,
  then reveal a focused two-hop neighborhood around any card.
- **Flexible card types** — notes, rich documents, to-dos, tables, links,
  YouTube videos, audio, images, files, boards, columns, and portals.
- **Structure without folders** — nest canvases through board cards, collect
  work in columns, and define desktop zones that become focused mobile views.
- **Live portals** — embed a filtered view of another canvas or the whole
  workspace without copying its cards.
- **Capture everywhere** — use the responsive mobile composer, REST API,
  browser extension, iOS Shortcut recipe, or Telegram bot. New items land in
  an inbox until they are placed.
- **Search and synthesis** — full-text search works out of the box. Optional
  OpenAI-compatible embedding and chat endpoints add semantic suggestions,
  card splitting, and source-aware living documents.
- **Private collaboration and publishing** — share canvases with viewer or
  editor roles, or publish a reviewed, frozen public lens that can be updated
  or revoked without exposing later private edits.
- **Personal presentation** — Studio, Pantry, and Night Garden canvas moods,
  cover images, adjustable card text, and named or custom card colours.

## Documents and mobile capture

Rich documents open in a focused editor with headings, lists, quotes, links,
inline card references, source chips, and Markdown, DOCX, or PDF export.

![The focused rich document editor](assets/screenshots/document-editor.png)

On a phone, Canvas Notes becomes a fast capture surface and a compact view of
each board's inbox and zones.

<img src="assets/screenshots/mobile-capture.png" alt="The Canvas Notes mobile composer" width="430">

## Quick start

Install Docker with the Compose plugin, then:

```bash
git clone https://github.com/josh-leclair/canvas-notes.git
cd canvas-notes
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `.env` as `SESSION_SECRET`, then start the app:

```bash
docker compose up -d --build
```

Canvas Notes is available at [http://localhost:8080](http://localhost:8080).
The first account registered becomes the administrator; registration then
closes and the administrator can issue invites.

The base Compose file binds the app to loopback. Configure `BIND_ADDRESS`,
`APP_PORT`, `COOKIE_SECURE`, and your preferred ingress or private-network
access method for the environment where you host it.

## Optional worker

The worker handles local transcription, embeddings, and capture bots. It uses
more disk and memory than the core application and is not required for ordinary
notes, canvases, sharing, or full-text search.

```bash
docker compose --profile worker up -d --build
```

The default local transcription model is controlled by `WHISPER_MODEL`.
OpenAI-compatible remote transcription, embedding, and chat endpoints can be
configured through environment variables or by an administrator under
**Settings → AI endpoints**. Saved API keys are encrypted with a key derived
from `SESSION_SECRET`.

Without an embedding endpoint, search remains lexical. Without a chat
endpoint, generation controls stay hidden. Without a bot token, the bot stays
off.

## Deployment options

The repository includes Compose overrides for a public HTTPS deployment and
for an existing PostgreSQL server:

```bash
# Bundled PostgreSQL with the included HTTPS proxy
docker compose -f docker-compose.yml -f docker-compose.production.yml up -d --build

# Existing PostgreSQL
docker compose -f docker-compose.yml -f docker-compose.external-db.yml up -d --build
```

For the included HTTPS proxy, set `DOMAIN` to a hostname whose DNS points to
the server. If you already manage ingress another way, use the base application
behind that setup instead.

An external PostgreSQL server needs the `pgcrypto`, `citext`, and pgvector
`vector` extensions. Give Canvas Notes its own database and set a
SQLAlchemy/psycopg URL in `.env`:

```dotenv
DATABASE_URL=postgresql+psycopg://canvas_notes:password@postgres.example:5432/canvas_notes
```

Append `?sslmode=require` when required by the provider. The database must be
reachable from the containers; `localhost` inside a container refers to that
container.

## Backups and updates

Back up both PostgreSQL and uploaded files. With the bundled database:

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U canvas -d canvas -Fc > backups/canvas-db.dump
docker compose exec -T backend tar -C /data/files -czf - . > backups/canvas-files.tar.gz
```

Keep `.env` secure and backed up as well. Changing or losing `SESSION_SECRET`
makes saved AI API keys unreadable.

To update:

```bash
git pull --ff-only
docker compose up -d --build
```

Database migrations run automatically when the backend starts. Take a backup
before updating and test the restore procedure for your environment.

## Capture API

Create an API token under **Settings**, then capture text or a URL:

```bash
curl -X POST http://localhost:8080/api/capture \
  -H "Authorization: Bearer cnv_..." \
  -H "Content-Type: application/json" \
  -d '{"text":"a thought","url":"https://example.com"}'
```

Upload a photo, voice memo, or other file as multipart data:

```bash
curl -X POST http://localhost:8080/api/capture/file \
  -H "Authorization: Bearer cnv_..." \
  -F file=@photo.png \
  -F title="from my phone"
```

Captured items land unplaced in the selected inbox. Images become image cards,
voice memos become audio cards with transcription queued, and other uploads
become file cards.

## Development

The backend needs PostgreSQL 16 with pgvector:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements-dev.txt
.venv\Scripts\alembic upgrade head
.venv\Scripts\uvicorn app.main:app --reload
```

The frontend development server proxies `/api` to `localhost:8000`:

```bash
cd frontend
npm install
npm run dev
```

The browser extension has its own test suite:

```bash
cd extension
npm install
npm test
```

## Tests

Backend integration tests use a disposable PostgreSQL database and skip when
none is reachable. Never point the suite at a database containing data you
care about.

```bash
docker run -d --name canvas-test-pg \
  -e POSTGRES_USER=canvas \
  -e POSTGRES_PASSWORD=canvas \
  -e POSTGRES_DB=canvas_test \
  -p 5433:5432 pgvector/pgvector:pg16
```

```powershell
cd backend
$env:DATABASE_URL="postgresql+psycopg://canvas:canvas@localhost:5433/canvas_test"
.venv\Scripts\python -m pytest tests
```

The GitHub Actions workflow runs the frontend build, extension tests, the full
backend suite against PostgreSQL, and Docker Compose build validation.

## Security

See [SECURITY.md](SECURITY.md) for private vulnerability reporting. Keep
`COOKIE_SECURE=true` whenever users connect over HTTPS, use a unique
`SESSION_SECRET`, and protect the application with the access controls suited
to your hosting environment.

## License

Copyright 2026 josh-leclair. Canvas Notes is distributed under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). The license permits use,
modification, and redistribution for permitted noncommercial purposes. Uses
outside those terms require a [separate commercial license](COMMERCIAL-LICENSE.md).

This is a source-available license, not an OSI-approved open-source license.
