# Milestone 1 and 2: Implementation Spec

Companion to the design doc. That document says why. This one says what to
build. Where the two disagree, the design doc wins on intent and this one wins
on detail.

Everything not specified here is deliberately out of scope. If something feels
missing, check that it is not a later milestone before adding it.

---

# Milestone 1: Foundation

**Goal.** A logged in user can create a canvas, add text cards to it, drag them
around, pan and zoom, and have all of it survive a refresh. Multiple accounts
exist on one instance and cannot see each other's data.

**Explicitly not in this milestone:** links, the reveal, the inbox, sharing,
capture, card types other than text, search, embeddings, transcription.

## 1.1 Stack and layout

- Backend: Python 3.12, FastAPI, SQLAlchemy 2.x, Alembic for migrations
- Database: Postgres 16
- Frontend: Vite, React 18, TypeScript, xyflow (`@xyflow/react`)
- Deploy: docker compose with two services plus Postgres

```
/backend
  /app
    main.py
    config.py
    db.py
    models/
    routers/
    schemas/
    auth.py
  /alembic
/frontend
  /src
    api/
    components/
    routes/
    store/
docker-compose.yml
```

Config comes from environment variables only. No config file.

```
DATABASE_URL
SESSION_SECRET
COOKIE_SECURE            default true, set false for LAN http
INSTANCE_NAME            default "Canvas"
```

## 1.2 Schema

```sql
create extension if not exists pgcrypto;
create extension if not exists citext;

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         citext      not null unique,
  password_hash text        not null,
  display_name  text        not null,
  is_admin      boolean     not null default false,
  created_at    timestamptz not null default now()
);

create table invites (
  id         uuid primary key default gen_random_uuid(),
  code       text        not null unique,
  created_by uuid        not null references users(id) on delete cascade,
  used_by    uuid                 references users(id) on delete set null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid        not null references users(id) on delete cascade,
  token_hash   text        not null unique,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index on sessions (user_id);

create table canvases (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid        not null references users(id) on delete cascade,
  name       text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on canvases (owner_id, created_at desc);

create type card_type as enum ('text', 'link', 'youtube', 'audio');

create table cards (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid        not null references users(id) on delete cascade,
  type       card_type   not null default 'text',
  title      text,
  body       text,
  payload    jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on cards (owner_id, created_at desc);

create table placements (
  id         uuid primary key default gen_random_uuid(),
  card_id    uuid        not null references cards(id)    on delete cascade,
  canvas_id  uuid        not null references canvases(id) on delete cascade,
  x          double precision not null,
  y          double precision not null,
  w          double precision not null default 280,
  h          double precision not null default 180,
  z          integer          not null default 0,
  updated_at timestamptz      not null default now(),
  unique (card_id, canvas_id)
);
create index on placements (canvas_id);
create index on placements (card_id);
```

Three things in there are load bearing and should not be simplified:

1. `card_type` includes all four values now even though only `text` is
   implemented. Adding an enum value later is a migration for no reason.
2. `placements` cascades from `canvases`, but `cards` does **not**. Deleting a
   canvas therefore destroys placements and leaves the cards alive with zero
   placements, which is exactly the inbox fallback from the design doc. This
   behavior needs a test in milestone 1 even though the inbox UI does not exist
   yet.
3. `unique (card_id, canvas_id)` means one card appears at most once per canvas
   while still allowing it on many canvases.

## 1.3 Coordinate system

World coordinates, floating point, unbounded in all directions. Origin is
arbitrary. `w` and `h` are world units, not pixels. A new canvas starts its
viewport at `{x: 0, y: 0, zoom: 1}`.

Zoom clamps to `[0.1, 2.5]`.

## 1.4 Auth

Session cookie, not JWT. Opaque random token, 32 bytes, base64url. Store only
`sha256(token)` in `sessions.token_hash`. Cookie is `httpOnly`, `SameSite=Lax`,
`Secure` when `COOKIE_SECURE` is true. Sessions last 30 days, sliding on use.

Passwords hashed with argon2id.

**Registration rules.** If `select count(*) from users` is zero, registration is
open and the created account gets `is_admin = true`. Otherwise a valid, unused,
unexpired invite code is required. There is no other path to an account.

## 1.5 Permission model

Every table in this milestone is owner scoped. Every query filters on
`owner_id = current_user.id`, including the ones that look like they cannot
possibly need it.

Requesting a row owned by someone else returns **404, not 403**. A 403 confirms
the row exists.

Placement writes check ownership of both the card and the canvas.

## 1.6 API

All routes under `/api`. All bodies JSON. Errors as
`{"error": {"code": "...", "message": "..."}}`.

### Bootstrap and auth

```
GET  /api/bootstrap
  -> 200 {"needs_setup": true, "instance_name": "Canvas"}

POST /api/auth/register
  {"email", "password", "display_name", "invite_code": null}
  -> 201 {"id", "email", "display_name", "is_admin"}  + session cookie
  -> 403 invite_required | invite_invalid | invite_expired | invite_used
  -> 409 email_taken

POST /api/auth/login     {"email", "password"} -> 200 user  + cookie
POST /api/auth/logout    -> 204
GET  /api/me             -> 200 user | 401
```

Login failure is always 401 `invalid_credentials`, never distinguishing a bad
password from an unknown email.

### Invites (admin only, 403 otherwise)

```
GET    /api/invites          -> [{"id","code","expires_at","used_by","used_at"}]
POST   /api/invites          {"expires_in_days": 7} -> 201 {"id","code","expires_at"}
DELETE /api/invites/{id}     -> 204
```

Code is 12 characters, unambiguous alphabet, no lookalikes.

### Canvases

```
GET  /api/canvases
  -> [{"id","name","card_count","created_at","updated_at"}]

POST /api/canvases            {"name"} -> 201 canvas
PATCH /api/canvases/{id}      {"name"} -> 200 canvas
DELETE /api/canvases/{id}     -> 204

GET  /api/canvases/{id}
  -> 200 {
       "id", "name",
       "placements": [
         {"id","x","y","w","h","z",
          "card": {"id","type","title","body","payload","created_at","updated_at"}}
       ]
     }
```

The canvas GET returns placements with cards hydrated inline. One request loads
a board. Do not make the client fetch cards separately.

### Cards

```
POST /api/cards
  {"type":"text","title":null,"body":"...",
   "canvas_id": null, "x": null, "y": null}
  -> 201 {"card": {...}, "placement": {...} | null}
```

If `canvas_id` is present, `x` and `y` are required and a placement is created
in the same transaction. If it is absent the card is created unplaced, which is
the inbox path that milestone 2 builds a UI for. The endpoint supports it now.

```
PATCH  /api/cards/{id}   {"title","body","payload"}  -> 200 card
DELETE /api/cards/{id}   -> 204
```

Deleting a card removes it everywhere including all placements. This is
destructive and distinct from removing it from one canvas.

### Placements

```
POST   /api/canvases/{id}/placements  {"card_id","x","y"} -> 201 placement
  -> 409 already_placed if the card is already on this canvas

PATCH  /api/placements/{id}  {"x","y","w","h","z"} -> 200 placement
DELETE /api/placements/{id}  -> 204
```

`PATCH` is per placement, one card at a time. There is no endpoint that saves a
whole canvas layout at once, and there should not be. Per card writes are what
keeps two people rearranging a shared canvas from stomping each other later.

## 1.7 Frontend

**Routes**

```
/setup           only reachable when needs_setup is true
/login
/register?code=  invite acceptance
/                canvas list
/c/:canvasId     the canvas
```

**Canvas behavior**

- xyflow with a custom node type `card`
- Pan on drag of empty space, and on space plus drag
- Zoom on wheel and pinch, clamped to `[0.1, 2.5]`
- Drag a card to move it. On drag end, `PATCH /api/placements/{id}`, debounced
  200ms. Never write during the drag.
- Optimistic local update, rollback and toast on failure
- Multi select with a rubber band, drag moves the selection, one PATCH per moved
  card
- Viewport persisted per canvas in localStorage keyed `viewport:{canvasId}`,
  restored on load
- Minimap and zoom controls bottom right

**Card node (text type)**

- Title line, optional. Empty renders nothing rather than a placeholder.
- Markdown body, rendered. Click to edit, edit in place, save on blur or
  cmd/ctrl+enter, escape cancels.
- Resizable from the bottom right corner, minimum 160 by 100 world units.
- Selected state gets a visible ring. This selection is the same mechanism the
  reveal will hook into later, so it should be a real state in the store, not
  just CSS.

**Theme**

CSS custom properties, two themes, class on `<html>`. Default from
`prefers-color-scheme`, override persisted in localStorage. Every color in the
app comes from a variable. No hardcoded hex outside the token file, because
retrofitting dark mode later is exactly the mess the design doc is trying to
avoid.

## 1.8 Acceptance criteria

- Fresh instance shows setup. First registration succeeds without an invite and
  yields an admin. Second registration without an invite is rejected.
- An admin creates an invite, a second user registers with it, and neither user
  can see the other's canvases or cards by any route, including by guessing ids.
- A card dragged and released stays in place after a hard refresh.
- Dragging twenty cards in one selection produces twenty PATCH calls and no lost
  positions.
- Deleting a canvas leaves its cards in the database with zero placements.
- Zoom out to 0.1 and in to 2.5 without layout breaking.
- Toggling theme changes every surface with no unstyled flash on reload.

---

# Milestone 2: Inbox and placement

**Goal.** Cards can exist without living anywhere, and getting them onto a
canvas is a deliberate, pleasant action. This is a small milestone by volume
because the schema already supports it. Most of the work is interface.

## 2.1 API additions

```
GET /api/inbox?limit=50&cursor=
  -> {"items": [card, ...], "next_cursor": "..."}
```

Implementation is one query:

```sql
select c.*
from cards c
left join placements p on p.card_id = c.id
where c.owner_id = $1 and p.id is null
order by c.created_at desc
limit $2;
```

There is no `inbox` table and no `in_inbox` flag. Any code that adds one is
wrong. The inbox is a derived state, which is what makes it impossible to
desynchronize.

```
GET /api/cards/{id}/placements
  -> [{"id","canvas_id","canvas_name","x","y"}]
```

Needed so the UI can tell a user which canvases a card already appears on before
they delete it.

## 2.2 Inbox panel

- Left side, collapsible, persisted open or closed
- Count badge, live after any placement change
- Compact card previews, roughly three lines
- Empty state that explains where captured items will appear, since in this
  milestone the only way to fill the inbox is creating a card with no canvas

**Drag from panel to canvas.** On drop, convert the screen point to world
coordinates with xyflow's `screenToFlowPosition`, then
`POST /api/canvases/{id}/placements`. The card leaves the panel immediately,
optimistically, and returns on failure. The drop point is the card's top left
corner, not its center, so the card lands where the cursor is rather than
jumping up and left.

## 2.3 Direct creation on canvas

- Double click empty canvas creates a text card at that point, already in edit
  mode with focus in the body
- Paste onto empty canvas creates a card at the cursor from clipboard text
- Toolbar button creates one at viewport center

All three call `POST /api/cards` with `canvas_id`, `x`, `y`, so the card never
passes through the inbox.

## 2.4 Remove versus delete

This distinction needs to be obvious in the interface, because one is reversible
and one is not.

- **Remove from canvas** deletes the placement. If it was the card's last
  placement, the card returns to the inbox. Say so in the confirmation: "This
  card will move back to your inbox." No confirmation dialog needed when other
  placements remain.
- **Delete card** destroys the card everywhere. Confirmation required, and the
  dialog lists the other canvases it currently appears on, using the placements
  endpoint above.

Keyboard: `Delete` removes from canvas. Deleting the card itself is menu only.
The destructive action should not be the one under the obvious key.

## 2.5 Acceptance criteria

- A card created with no canvas appears in the inbox immediately
- Dragging it to a canvas removes it from the inbox and it lands where it was
  dropped, at any zoom level
- Removing its only placement returns it to the inbox with its content intact
- Deleting a canvas containing five cards results in five cards in the inbox
- The inbox query returns nothing for cards placed on any canvas, including
  canvases the user has since scrolled away from or forgotten

---

## What this sets up

Milestone 3 is links and the reveal, and it depends on two things built here:
selection as real application state rather than a CSS class, and per card
position writes. Both are easy now and awkward to retrofit, which is why they
are specified this early.
