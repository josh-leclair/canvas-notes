# Invariants and traps

Rules this codebase depends on, and the mistakes that have already been made
against them. Everything here cost real debugging time; several were found only
because a user noticed something moving back after a refresh. If you are about
to change the canvas, read the first two sections at least.

The design docs say what the app is. This says what will bite you.

## Adding a node type to the canvas

**The recurring bug in this project.** A canvas renders four xyflow node types
(`frontend/src/routes/CanvasPage.tsx`):

| type        | what it is                    | backed by a placement? |
| ----------- | ----------------------------- | ---------------------- |
| `card`      | every card type except column | yes                    |
| `column`    | a stack container             | yes                    |
| `ghost`     | a portal to another canvas    | no                     |
| `tombstone` | an echo of a deleted card     | no                     |

Columns were added late. Three separate bugs followed, all the same shape:
code written when `card` was the only real node type kept a check like

```ts
if (node.type !== "card") continue;   // silently excludes columns
```

and columns fell straight through it. The symptoms looked unrelated — a drop
onto a column that never took, a column position that reverted on refresh —
but the cause was identical each time, and each was found by a user rather
than by a test.

**The rule: branch on what a node *is*, not on how it renders.** The question
almost every canvas code path actually wants to ask is "does this have a
placement behind it?", and the answer is a store lookup, not a type string:

```ts
const source = live.find((n) => n.id === node.id);
if (!source) continue;                 // portals and echoes have no placement
if (source.data.parentId) continue;    // a column owns its members' geometry
```

Written that way, a new node type is handled correctly the day it is added.
Written as a type check, it is a bug waiting for someone to notice.

If you add a node type, walk these deliberately — each one has been wrong
before:

- **Persistence after a drag** (`onNodeDragStop`) — the one that reverted.
- **Hit testing during a drag** (`onNodeDrag`) — see the coordinate rule below.
- **Resize**, if the type is resizable, and the per-type minimum in
  `CardNode`'s `MIN_SIZE`.
- **Multi-select drag**, which pushes one undo entry per node.
- **Undo** — geometry entries are keyed by placement id, so a type without one
  must not create them.
- **z-order**, if the type can open a menu (see `menuOpenFor`).

## Coordinates and hit testing during a drag

- **Hit test with the cursor, never the dragged card's centre.** An empty
  column is 116px tall and a card is 180px; the centre of a card held over an
  empty column falls below the column entirely and never matches. "Drop it
  here" means where the pointer is. Get it from the event via
  `screenToFlowPosition`.
- **A card inside a column reports its position *relative to that column*.**
  Convert to world space before comparing against anything else, or every hit
  test after a card joins a stack is wrong by the column's offset.
- **Hit tests must use the *rendered* height.** A card folded away by a hub is
  drawn at `COLLAPSED_HEIGHT` while keeping its stored `h`; using the stored
  value makes drops land on empty space.
- **xyflow drag callbacks must list every piece of React state they read in
  their deps.** Miss one and the callback keeps the value it captured when it
  was first built — usually `null` — with no error anywhere. This is what made
  dropping into a column look like dropping onto bare canvas.

## Never persist measured dimensions

`onNodesChange` writes back **only** `position` and `select`. Storing a
dimension change makes new node objects, which makes xyflow measure again,
which emits another dimension change: "Maximum update depth exceeded", React
unmounts, blank page. Card size belongs to the placement, and collapsing a hub
changes rendered height on purpose, so a measurement is never something to
save. Any effect that both watches `nodes` and calls `setNodes` needs a latch
for the same reason.

## `CardNode`: what may live inside the card

`.card-node` sets `overflow: hidden` so media keeps the rounded corners. That
clips **anything inside it that needs to escape** — link handles, the
`NodeResizer`, the ⋯ dropdown. All of those are siblings of `.card-node`, not
children. This has been rediscovered three times; if a grab target or menu is
mysteriously invisible or unclickable, check this first.

Related: **the whole card surface stays drag surface.** Only small explicit
controls get their own handlers. Marking a whole tile interactive is what made
image cards, board cards, and YouTube cards undraggable in turn.

Open-menu state lives in the store (`menuOpenFor`) so `CanvasPage` can raise
that node above its neighbours — a menu inside a column otherwise renders
under the column's own chrome.

## No native dialogs, ever

`window.confirm`, `window.prompt`, and `alert` are suppressed in the user's
browsing context: they return `false`/`null` immediately, show nothing, and log
nothing. Every destructive action sitting behind one was silently a no-op —
delete, rename, remove-from-canvas — and the console was clean, which is what
made it hard to spot.

Use `confirmDialog` / `promptDialog` from `frontend/src/store/dialogStore.ts`
(rendered by `DialogHost` in `App.tsx`). **A report of "the button does nothing
and there is nothing in the console" should point here first.**

## A bot that cannot capture something has to say so

`_to_incoming` returns `None` to mean "nothing here", and the poll loop then
`continue`s without replying. A photo hit that path, so sending one produced
no answer at all — which from the outside is indistinguishable from the bot
being down. Same shape as the suppressed-dialog trap above: an action that
silently does nothing.

Worse was a photo *with* a caption. The text branch read `text or caption`,
so a captioned photo fell through to it, was filed as a text card, and the
sender was told it had worked. The picture was gone.

**Attachments are therefore decided before the text branch, and anything the
bot cannot turn into a card comes back as `unsupported` rather than as
`None`.** A caption is not a substitute for the thing it was attached to. If
you add a message type, add it above the text fall-through, or it will be
quietly filed as a note.

Two Telegram specifics that are easy to get wrong:

- A photo arrives as an **array of sizes**, thumbnail first and original
  last. Take the last, or you capture a 90px postage stamp.
- The same picture sent **as a file** is a `document` with its own mime, not
  a `photo`. That route keeps the original bytes; the `photo` route is
  re-encoded to JPEG by Telegram, which flattens transparency.

## Derived state is never stored

The app leans on this deliberately, and denormalising any of it will drift:

- **Inbox** = cards with zero placements. Not a flag. `inbox_canvas_id` only
  routes an unplaced card into a contextual board tray; creating any placement
  clears it.
- **Zone membership** = a root placement whose centre falls inside the zone.
  It is never stored on the card or placement. If zones overlap, the smallest
  containing zone owns the mobile projection so a card is not listed twice.
  Column members follow their column into the projection and retain its
  explicit `sort`; portal cards are deliberately omitted.
- **Nesting** = a canvas is nested iff some board card points at it. No parent
  pointer, no tree. `backend/app/boards.py` resolves name, count, and cover on
  read into `CardOut.board`.
- **Card visibility** = you own it, or it is placed on a canvas you can see.
  One EXISTS subquery, evaluated per read.
- **Link visibility** = whoever can see both endpoints, regardless of who
  created the link. Hard-deleting either endpoint deletes the link; removing
  a card from a canvas keeps both the card and its links alive.

**All permission logic lives in `backend/app/access.py`.** Nothing else should
hand-roll an ownership check.

## A public lens is a snapshot, never a permission shortcut

`public_lenses.snapshot` is the complete anonymous document. The public route
must never resolve a card, placement, link, or file from the live workspace:
doing so would make an innocent later edit public without review, and deleting
or moving a source card would silently mutate an already shared page.

Publication therefore copies the selected placement geometry and owned card
content, includes a selected column's immediate members, keeps only links whose
two endpoints are both included and whose creator is the publisher, strips
inline references that leave the boundary, and copies attachments into a
revision-specific public directory. Updating creates a new frozen revision;
revoking makes both the JSON and every asset return 404. Keep public routes
outside the account gate, but keep every create/update/list/revoke route owner
authenticated.

## `.card-menu button` out-specifies a bare swatch class

The colour swatches are buttons inside `.card-menu`, and `.card-menu button`
sets `background: transparent` at one class *and* one type — which beats a
plain `.paint-none` or `.paint-wheel` at one class. The eight hue swatches
never noticed, because they carry their colour as an inline style; the two
that take theirs from the stylesheet did, and `.paint-none` sat transparent
unremarked for as long as it existed.

Same shape as the xyflow rule below it: a rule that has to beat a descendant
selector must out-specify it, so these are written `.paint-swatch.paint-none`
and `.paint-swatch.paint-wheel`.

## Smaller ones

- **The product's shape language is square.** Cards established that identity;
  panels, buttons, fields, dialogs, navigation and badges follow it. Radius
  tokens are zero and `theme.css` resets legacy literal radii. Circles are
  reserved for point geometry—connection handles, picker cursors and tiny
  status dots—not decorative containers or pills.
- **Checkbox toggling rewrites the source line by the line number remark
  reports** (`frontend/src/lib/tasks.ts`) — never by index into rendered
  output, which desynchronises the moment a list is nested or interrupted.
- **Portal layout must stay a pure function of the anchor card's geometry**
  (`revealGraph.ts`). An earlier collision-avoidance loop made portal pills
  jitter and drift during drags.
- **A card's colour is a named hue or a hex, and the `#` is what tells them
  apart** (`frontend/src/components/cardPaint.ts`). The eight named hues are
  solved sets — a fill, a border a step deeper, and the one of two inks that
  stays readable on it — and every one of those is a token. A custom hex has
  the border and the ink *derived* from it at paint time in `lib/colour.ts`
  instead. Anything reading a paint out of a payload goes through
  `paintOf`/`paintStyle`, which validate: a hex that is not one comes back
  null rather than reaching CSS. There is no per-theme remapping any more —
  a painted card is the same colour in both themes on purpose.
- **All colour, radius, shadow, and motion values live in `theme.css`.** Adding
  a theme means a `.theme-*` block, a `THEMES` entry, and its background colour
  in the `index.html` boot script — never a literal elsewhere.
- **Column membership is `placements.parent_id` + `sort`**, so it is per-canvas:
  the same card can sit in a stack on one board and loose on another. Members'
  stored x/y are deliberately left untouched so leaving a column restores where
  they were.
- **Hubs are `placements.is_hub`** — canvas state, not a browser preference, so
  a shared board looks the same to everyone.

## nginx has an upload limit of its own

The container's nginx defaults to `client_max_body_size 1m`, which is smaller
than anything the app actually accepts — `MAX_IMAGE_BYTES` is 25MB and
`MAX_AUDIO_BYTES` is 200MB. So a phone photo or a voice memo was refused at
the proxy with a bare 413 before the backend ever saw it, and the backend is
the only part that knows which per-kind limit was exceeded and can say so.

Only the *deployed* stack, which is what made it easy to miss: the Vite dev
server proxies `/api` with no such limit, so uploads that fail in Docker work
perfectly in development.

`frontend/nginx.conf` now sets it to the largest of the app's own limits. If
one of those in `app/media.py` ever goes up, this has to go up with it.

## Postgres image

Compose uses `pgvector/pgvector:pg16`; milestone 7's `vector` column will fail
to migrate on a plain `postgres:16`. The images are data-compatible, but they
carry different glibc versions, so switching an existing volume needs
`REINDEX DATABASE` followed by `ALTER DATABASE ... REFRESH COLLATION VERSION`.
Watch for the collation warning on any future image change.

## Branching on node type excluded columns again (four times now)

`onSelectionChange` filtered with `n.type === "card"`, so selecting a column
never reached the store. No selection meant no reveal, which meant a link to
a column was created, saved and returned 201 — and then never drawn. It read
as "columns don't take links".

The test is whether a node is backed by a placement, not what it renders as.
Ghosts and tombstones are the things to exclude, and they are the ones with no
placement behind them.

## A card in a column is not where its placement says it is

Membership lives on the placement, but the *position* on that placement is
deliberately left alone while the card is in a column, so that pulling it out
restores where it used to sit. The card is drawn at its column's position plus
its slot offset instead.

So `node.position` is a stale coordinate for any node with `data.parentId`,
and `data.w/h` is a stale size for any node whose height is measured — column
members, folded hub children, previewed cards. Both have to be resolved
through the column layout before they are compared with anything.

Getting this wrong is not subtle in its consequences and is very subtle to
spot: a card whose stored position happened to be at the bottom of the board
kept a hit box there, so dragging an unrelated card in that empty space linked
it to a card sitting in a column at the top. It read as "linking fires when
nothing is nearby". `worldPosition` and `effectiveSize` in `CanvasPage.tsx`
exist for exactly this; use them for every rectangle you compare, not just the
one being dragged.

Related: never transition a node's `height`. The element reports its starting
height for as long as the transition is pending, so the card is drawn at one
size while the layout and hit-testing use another. Animate `transform` only.

## xyflow's stylesheet loads after ours

`.react-flow__handle { width: 6px }` and friends sit in xyflow's own CSS,
which is imported after the component styles. At equal specificity the later
rule wins, so a bare `.card-handle { width: 14px }` was silently ignored for
the whole life of the project — the anchors rendered at 6px and nobody could
see why the number in the file did nothing.

Any rule that fights an xyflow default has to out-specify it, not just come
later: `.react-flow__handle.card-handle`, not `.card-handle`. The same applies
to `.react-flow__node`, `.react-flow__edge` and the rest.

## `--bg-card` and `--bg-panel` are the same colour in Paper

In the light theme both are `#fffdf9`; in the dark theme `--bg-hover`
(`#2f2d39`) and `--bg-card` (`#302d3c`) are a shade apart. So **no surface
token separates from a card in both themes**, and a control that sits on a
card and takes its background from one of them is invisible in one theme or
the other. That is what made the ⋯ button hard to find: a transparent chip
with muted text on a surface the same colour as itself.

Anything that has to stand *off* a card mixes toward `--text` instead
(`color-mix(in srgb, var(--bg-panel) 70%, var(--text))`), which darkens on a
light theme and lightens on a dark one, and also separates from a painted
card — which is a bold colour that no surface token resembles.

Related: `.card-node` has `border: 1px solid transparent`. The card's edge is
its **box-shadow**, not its border; the border only becomes visible when the
card is painted or selected. Removing a card's frame means removing the
shadow, and setting `border-color` alone does nothing.

## A nearest-neighbour scan always returns something

Semantic search orders every embedded card by distance and takes the top few.
Nothing about that says any of them are *relevant* — the nearest neighbour of
a random string is still a nearest neighbour — so before
`MAX_SEMANTIC_DISTANCE` was added in `routers/search.py`, gibberish matched,
lit a card up on the canvas, and was counted in the summary.

It is loudest on an instance where only a card or two has ever been embedded,
because that card is then the nearest neighbour of *everything*. That is how
it was found: one column, on one board, matching every search anyone typed —
it was the only row in `cards` with an embedding.

It came back a second time in the suggestion panel, which ranked without a
floor and so offered five cards against a video related to none of them. Same
missing check, different call site — `MAX_SEMANTIC_DISTANCE` now gates both.
If a third thing ever ranks by distance, it needs the floor too.

Two things to know before changing that constant:

- **It is model-dependent and cannot not be.** Models with a high similarity
  baseline (nomic-embed-text, the bge family) put unrelated text around
  0.3-0.5 cosine distance; wide-range models put it past 0.7. A value tuned
  for one family is wrong for the other.
- **A relative rule does not rescue it.** Cutting at some margin below the
  corpus mean, or at the biggest gap in the ranking, sounds model-independent
  and degenerates exactly where the bug bites: with one embedded card there
  is no spread and no gap, so everything passes. The floor has to be
  absolute.

- **One number covers both uses only because the model is symmetric.**
  bge-m3 encodes a query and a document into the same space, so
  query-to-card and card-to-card distances mean the same thing. A model that
  wants `search_query:` / `search_document:` prefixes — nomic-embed-text,
  the E5 family — does not, and adopting one means splitting the constant in
  two as well as teaching `embed_text` which side it is embedding.

Erring strict is the safer direction. Full-text hits never pass through the
floor, so a cut that is slightly too tight costs some fuzzy matches while
every exact one still lands.

**Calibrating it.** Do not guess: measure against a real library. The
distances that matter are the ones between pairs a person agrees are related,
against the spread of the corpus as a whole.

```sql
-- what "related" actually looks like here
select round((a.embedding <=> b.embedding)::numeric, 3), a.title, b.title
from cards a join cards b on a.id < b.id
where a.embedding is not null and b.embedding is not null
order by 1 limit 10;
```

On bge-m3 that put agreed-related pairs at 0.22-0.29 against a corpus median
of 0.606, leaving a clear gap between roughly 0.30 and 0.47 for the floor to
sit in. Re-run it after any model change.

## Edges and nodes are siblings competing on one z-index

xyflow puts three layers inside `.react-flow__viewport` — edges, the edge
label renderer, then nodes — all at `z-index: auto`, and then writes a
z-index onto **each edge svg and each node div individually**. So an edge and
a card compete directly in the viewport's stacking context, and cards win a
tie only because the edges layer comes first in the DOM.

The tie does not always hold. `getElevatedEdgeZIndex` raises an edge to its
endpoint's own z whenever that endpoint has a `parentId` — which is every card
in a column — so links touching a stacked card drew straight over unrelated
cards. It read as "link lines are on top sometimes", with no pattern to it.

`.react-flow .react-flow__edges { z-index: -1 }` in `canvasPage.css` settles
it: a z-index makes the layer a stacking context, so every per-edge z-index is
resolved *inside* it and the whole layer stays under the nodes whatever xyflow
computes. Negative is scoped to the viewport, which is a stacking context of
its own via the pan/zoom transform, so the lines still paint above the dot
grid — `.react-flow__background` sits outside the renderer entirely.

Two things follow for anyone testing this: edge svgs are `pointer-events:
none` in xyflow's own CSS, so `elementFromPoint` never returns one and cannot
be used to check paint order without overriding that first; and a link badge
lives in the *label* layer, not the edges layer, so it is unaffected by this
and stays the click target.

## A column's own controls cannot live on its edge

Members are xyflow child nodes, and a child always paints above its parent —
there is no z-index on the parent that changes that. So anything the column
draws on its own edge is covered by whatever card is stacked there. The menu
dropdown hit this first and moved to a portal; the link anchors hit it next
and had to move outside the node box entirely (`column-handle` in
`columnNode.css`). The bottom anchor was completely unreachable until then,
which read as "linking columns together is flaky".

If a column ever needs another control, it goes outside the box or into a
portal. Not on the edge.

## A card's edges belong to the link anchors

The table card's lettered and numbered tabs are drawn outside the card, and the
first version placed them 8px off the grid — which put the column bar right on
the card's top edge, where the top link anchor sits. The anchor won every hit
test, so clicking the middle column's tab did nothing at all while the same
click dispatched from script worked perfectly.

This is the third control to run into the card's own edges, after the column
menu and the column's controls. Anything hung off a card has to clear the
anchors' overhang, not merely sit next to the content.

## The pane has to be displayed to measure anything time-based

Verifying in this environment measures a page that is not compositing frames,
which means CSS animations and transitions never advance and the document
never takes focus. Three things follow, and each one has already been mistaken
for a bug:

- A card is frozen at the first frame of `card-pop`, so `.card-node` reads
  `scale(0.9)` and every measurement inside it is 10% short. Layout comparisons
  have to disable the animation first.
- `opacity` driven by a transition stays at its starting value however long you
  wait. Assert on a non-transitioned property, or disable the transition.
- `element.focus()` sets `document.activeElement` but fires no focus event, so
  anything keyed on `onFocus` never runs. Dispatch `focusin` directly.
