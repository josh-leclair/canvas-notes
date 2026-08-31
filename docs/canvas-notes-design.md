# Canvas Notes: Design Doc v0.1

Working title. A canvas-first note app where entries are cards, cards are placed
freely in space, and the connections between cards are first class objects with
their own data.

Status: draft. Decisions below are settled unless listed in Open Questions.

---

## 1. What it is

A visual notebook. Instead of a document tree or a tag list, notes live on
spatial canvases. New canvases begin at roughly one screen and grow as content
approaches an edge, giving small boards a useful shape without limiting giant
dumping grounds. Others will keep many small canvases organized by topic. Both
are supported without the app taking a side.

The differentiator is not the canvas. It is the link model. A link between two
cards carries its own metadata, survives the loss of its endpoints, and can be
explored two hops at a time without turning the board into a hairball.

## 2. Goals

- Spatial arrangement of notes with free placement, pan, and zoom
- Multiple media types on a card: text, links, video, audio
- Links between cards that carry their own meaning and history
- A reveal interaction that makes exploring connections readable, not noisy
- Low friction capture from a phone without a native app
- Self hostable by one person for a household, with multiple accounts

## 3. Non-goals for v1

- No hosted service. This ships as software people run themselves.
- No realtime multiplayer. Shared canvases reconcile on refresh.
- No canvas editing on mobile. Mobile is capture and consumption.
- No freehand drawing or ink.
- No AI features beyond audio transcription.

---

## 4. Core concepts

**Card.** One entry. Owns content, owns nothing about position.

**Canvas.** A named board belonging to a user, optionally shared with others.

**Placement.** A card's position on a specific canvas. A card can have zero,
one, or many placements. This is the join that makes everything else work.

**Link.** A directed connection from one card to another. Owned by whoever
created it. Carries its own metadata.

**Inbox.** Not a table. It is the query "my cards with zero placements."
Captured items arrive with no placement and therefore appear in the inbox.
Dragging one onto a canvas creates a placement and it leaves the inbox. Removing
a card's last placement returns it to the inbox rather than deleting it.

---

## 5. Data model

```
users             id, email, password_hash, is_admin, created_at
invites           id, code, created_by, used_by, expires_at
api_tokens        id, user_id, name, token_hash, created_at, last_used_at, revoked_at
bot_identities    id, user_id, platform, platform_user_id, created_at
pairing_codes     id, user_id, code, expires_at, consumed_at

canvases          id, owner_id, name, created_at
canvas_members    canvas_id, user_id, role (viewer | editor)

cards             id, owner_id, type, title, body, payload jsonb,
                  embedding vector(768), created_at, updated_at
placements        id, card_id, canvas_id, x, y, w, h, z, updated_at
                  unique (card_id, canvas_id)
files             id, card_id, path, mime, bytes, created_at

links             id, creator_id, source_card_id, target_card_id,
                  link_type, note, created_on_canvas_id,
                  source_snapshot jsonb, target_snapshot jsonb,
                  created_at, updated_at
```

Notes on the shape:

- `payload` is jsonb so a new card type is not a migration.
- `placements` is separate from `cards` so one card can appear on several
  canvases without duplicating content. Edit it anywhere, it changes everywhere.
- Position writes are per card on drop, not a canvas-wide layout blob. Two
  people rearranging different cards on a shared canvas never conflict.
- `*_snapshot` holds title, source url, and a short excerpt captured at link
  time. It is never displayed while the card is reachable. It exists only to
  render a tombstone when it is not.
- `embedding` is written on card create and edit. Dimension depends on the
  chosen model and is fixed per instance. See section 12.

---

## 6. Links

The centerpiece. Everything here is deliberate.

### Creation

One gesture. Drag a wire from a card handle to another card for same canvas
links. A "link to" action opens a search picker for everything else, which is
also the only sane path on a canvas with two thousand cards where the target is
five screens away.

The reason field is optional and addable later. Requiring prose to finish a link
means the link does not get made.

### Metadata

Never blank. Auto populated:

- created_at and updated_at
- the canvas you were on when you made it, which is context you would never
  think to write down
- endpoint snapshots for tombstone fallback

User supplied and optional:

- `link_type`, a short controlled set (supports, contradicts, source for,
  follows from, related). Typed labels get filled in far more often than free
  text does, and they give you something to color and filter by.
- `note`, free text on why.

Card titles are never copied into the link for display. The link stores two ids
and joins live, so a rename never leaves a stale title showing.

### Direction and visibility

Links are directed. Selecting a card reveals both its parents and its children,
visually distinguished.

A link is owned by its creator and visible only to users who can see both
endpoints. Without that rule, your private card titles start appearing as
incoming arrows on someone else's shared card.

### Cross canvas links

Allowed. A link is a record with its own identity, so canvas membership is a
property of a card, not a constraint on a link. Blocking cross canvas links
would mean connections could only form inside boxes you already drew, which is
folders with better graphics.

When a revealed card lives on another canvas it renders as a **ghost**: dashed
outline, dimmed, labeled with its home canvas, and **not draggable**. It
disappears on deselect. On it is one action, "add to this canvas," which creates
a real placement. Nothing about canvas membership ever changes silently from a
hover.

### Broken links

If a card becomes unreachable, whether deleted or because a shared canvas was
unshared, the endpoint renders as a **tombstone**: greyed, showing the snapshot
title, the date linked, and your reason. Next to it, one button, "recreate as my
own card," which builds a card from the snapshot.

Explicitly rejected: automatically creating a shadow copy of any card you link
to but do not own. It voids revocation (anyone with read access silently mints
permanent copies of everything), it makes the displayed content swap to a stale
version the moment access ends, and it duplicates audio blobs per link.

---

## 7. The reveal interaction

Default state: all arrows hidden. A canvas at rest is cards, not a web.

On selecting card A:

1. Everything unrelated dims.
2. Hop 1 shows A's direct parents and children, arrows solid, full weight.
3. Hop 2 shows their connections, arrows at roughly 40 percent opacity, thinner.
4. Nothing beyond hop 2. Clicking a revealed card re-roots the reveal there,
   which walks the graph one step at a time and gives a natural breadcrumb.

**Traversal is direction locked.** Hop 1 goes both ways. Hop 2 only continues in
the direction it was already traveling: children of children, parents of
parents, never sideways. Without this rule, one popular source card that fifty
notes point at becomes a hub, and selecting anything near it lights up its
entire neighborhood through shared parents. The hairball comes back through the
side door.

**Visual encoding.** Direction gets geometry, type gets color.

- Arrowheads never flip. They always point source to target, so incoming versus
  outgoing reads without a legend.
- Opacity falls off with hop depth.
- Line weight drops slightly at hop 2.
- Hue encodes `link_type`, so you can scan a board and see every contradiction
  at once.
- Dashes are reserved for cross canvas ghosts and are not used for anything else.

Off screen linked cards are acceptable. Zoom out, the lit cards stand out
against the dimmed field. A "fit to revealed" control is cheap and worth adding.

---

## 8. Card types

All types share title, body, timestamps, and free resize in storage. How they *render* diverged later: only a text card leads with its title and body, and on other types they are an optional caption. See beyond-milestones-decisions.md.

| Type | Behavior |
|---|---|
| Text | Markdown body, inline edit |
| Link | Server side OpenGraph unfurl for title, description, image. CORS makes client side fetching impossible |
| YouTube | Static thumbnail with a play button. Becomes an iframe only on click |
| Audio | Uploaded or recorded, stored on disk, queued for transcription, transcript stored on the card and searchable |

---

## 9. Performance

The dumping ground canvas is the stress case and these are cheap to build in,
painful to retrofit.

- Only render nodes in the viewport.
- Embeds are static thumbnails until clicked. Three hundred live iframes kills
  the tab well before three hundred cards feels like a lot.
- Below a zoom threshold, every card degrades to a colored box with a title.
- Position writes debounce and fire on drop, not during drag.

---

## 10. Capture

Everything writes to one endpoint and lands in the inbox unplaced. A share sheet
cannot tell you x and y, so placement is always a separate deliberate act.

**v1:**

- REST API with per user tokens, revocable, hashed at rest, shown once
- iOS Shortcut posting url and selection to that API
- Telegram bot (polling mode)
- Discord bot (gateway)
- Web app, which can also create a card directly onto a canvas, skipping the
  inbox

**PWA:** manifest and service worker for the home screen icon and offline shell.
Not registered as a share target. Share target is Android and Chrome only and
requires a secure context, which many self hosters on a LAN IP do not have.

**Later:** bookmarklet (cheapest coverage for desktop Safari and iOS), browser
extension for right click clipping.

**Bot pairing.** One instance runs one bot serving every user, so the bot must
map platform identity to app identity. The web app issues a short code, the user
sends it to the bot once, the mapping is stored. Messages from unpaired senders
are dropped silently. This is the bot's entire auth model and cannot be deferred.

Note that both bots are outbound connections and work behind NAT with no port
forwarding, reverse proxy, or certificate. For a NAS user that may be the only
capture path that works at all.

---

## 11. Sharing and accounts

- First account registered becomes admin. Registration then closes. Admin issues
  invites. Open signup by default on self hosted software ends badly.
- Canvases are shared per user with a viewer or editor role.
- Sharing is not realtime. Last write wins, mitigated by per card position
  writes.

---

## 12. Local model integration

Optional throughout. A large share of self hosters have no GPU, and every
feature here degrades to hidden rather than broken when nothing is configured.

Small models are not a limitation to work around here. They push the design
toward the right features, because every good use in this app operates on one
card or one pair of cards, which fits in any context window.

### Two models, configured separately

| Purpose | Model | Notes |
|---|---|---|
| Embeddings | bge-small, nomic-embed, or similar | Runs on CPU. This is the one that matters most and the one most instances can actually run |
| Generation | Whatever the user points at | Optional. Everything in the generation list below is skippable |

Both are configured as an OpenAI compatible base URL plus a model name. Ollama,
LM Studio, and llama.cpp all speak that protocol, and it means a user can point
at a hosted API key instead without a second integration existing.

### Similarity, which is not an LLM feature

The highest value feature here is a vector search, not a generation call.

On card create and edit, the card's text is embedded and stored in the
`embedding` column. Related cards are then a distance query:

```sql
SELECT id, title
FROM cards
WHERE owner_id = $1 AND id != $2
ORDER BY embedding <=> $3
LIMIT 10;
```

`<=>` is cosine distance. An HNSW index keeps this fast into the hundreds of
thousands of rows. Note that this is deterministic, fast, and needs no GPU.

What gets embedded: title, body, the unfurled description on a link card, and
the transcript on an audio card. Transcription therefore pays for itself twice,
turning a voice memo from an opaque blob into something searchable and linkable.
The weak case is a YouTube card holding only a URL and a title, which is an
argument for pulling the video description at unfurl time.

Position on the canvas is deliberately **not** a similarity signal. Proximity
often means "added the same week" rather than "related." It is defensible as a
small tiebreaker between two equally similar cards, and bad as a primary input.

This unlocks:

- **Link suggestions.** A quiet panel on the selected card. Accept or ignore.
  This attacks the real failure mode of a spatial app, which is cards you forgot
  you had.
- **Inbox triage.** A captured item suggests which canvas it belongs on based on
  its nearest neighbors.
- **Semantic search**, so a card about fixing a truck transmission surfaces for
  "car repair" despite sharing no words with it.

### Generation tasks

All small input, all async through the same job queue as transcription.

- **Titles for captured cards.** Share sheet and bot captures arrive without
  titles. Highest value per token spent of anything on this list.
- **Audio note cleanup.** Whisper output is an unpunctuated wall. A small model
  paragraphs it and extracts action items.
- **Draft the link reason.** Two card bodies in, one sentence on how they relate.
  Editable, discardable. This is what keeps link metadata from sitting empty,
  since reasons only get written when writing them is nearly free.
- **Suggest a link_type** from the controlled set, same input.
- **Ask about a revealed subgraph.** The 2-hop reveal already produces a bounded
  set, usually five to fifteen cards. That is the retrieval unit, and it fits a
  small context naturally. The reveal doubles as the context builder.

### Rules

1. Nothing blocks the UI. All of it runs in the job queue.
2. Every output is a suggestion, stored apart from user data, never written into
   a card or a link silently. Same principle as the tombstone decision.
3. If no endpoint is configured, the features hide rather than erroring.

### Explicitly rejected

Chat with your whole canvas. It is the obvious feature and the worst fit. Small
model, large corpus, and retrieval over your own notes tends to return confident
mush that has to be verified against the cards anyway, which is the work you were
trying to avoid.

---

## 13. Stack

| Layer | Choice | Why |
|---|---|---|
| Canvas | React + xyflow | The app is literally nodes and edges. Nodes are real DOM, so iframes, audio elements, and editable text just work. Pan, zoom, drag, minimap, and fitView are built in. MIT |
| DB | Postgres | Recursive CTE gives the depth capped reveal in one query. jsonb for card payloads. Built in full text search. pgvector for similarity, which is core rather than optional |
| Embeddings | bge-small or nomic-embed via an OpenAI compatible endpoint | CPU capable, so it works on instances with no GPU |
| API | Python + FastAPI | Transcription and unfurling are both Python shaped work |
| Transcription | faster-whisper in a job queue | A twenty minute recording cannot block an upload response |
| Files | Local disk behind the API | Audio blobs only. No object store until there is a reason |
| Deploy | Docker compose | Single tenant, one command |

Considered and rejected: tldraw (better if freehand drawing mattered, worse when
cards need to be arbitrary React components), WebGL rendering (unnecessary below
a few thousand cards, and it makes rich media in cards impossible).

---

## 14. Suggested build order

1. Auth, invites, cards, canvases, placements, drag, pan, zoom
2. Inbox and direct to canvas creation
3. Links with metadata, the reveal, direction locked traversal
4. Card types: link unfurl, YouTube, audio and transcription
5. Capture: API tokens, Shortcut, Telegram, Discord
6. Sharing, ghosts, tombstones
7. Embeddings on write, plus search and link suggestions built on them
8. Optional generation features
9. Dark mode polish, performance passes

Links come before media types on purpose. The link model is the thing that makes
this app different, and it should be proven before effort goes into card
rendering.

---

## 15. Open questions

- Do suggested links exist as real rows in an unconfirmed state, so the reveal
  can show them as faint dotted arrows to accept or dismiss? Or do suggestions
  stay out of the graph entirely and live only in a side panel? This adds a
  status column to `links` if the answer is the former, so it is worth deciding
  before that table is built.
- Search. Nothing is designed yet. Full text across titles, bodies, and
  transcripts is the floor, and semantic search sits on top of the embeddings.
  Does search return a list, or does it filter the canvas in place and dim non
  matches, reusing the reveal machinery?
- Can a viewer on a shared canvas create links from their own cards to cards on
  it, or does that need editor role?
- Delete semantics for a card with inbound links from other users.
- Does the reveal traverse into ghosts at hop 2, producing ghosts of ghosts?
- Undo. Free placement means accidental drags, and there is no undo stack
  designed.
- Whether link_type is a fixed list or user extensible.
- The name.
