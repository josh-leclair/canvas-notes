# Beyond milestone 8: Decisions

The eight milestones were the plan. This records the work that followed, all
of it driven by hands-on use rather than the spec — the design doc still wins
on intent, this wins on detail. Traps and rules that fall out of these choices
live in [invariants.md](invariants.md).

## Cross-canvas links: portals

The original rendering placed a small stand-in node for each off-canvas
endpoint, positioned by a collision-avoidance pass. In practice they scattered
around the anchor card, and one of them jittered whenever anything moved.

- **A link to a card on another canvas renders as a *portal pill* pinned beside
  its anchor** — outgoing to the right, incoming to the left, stable sort
  within each side. Clicking it travels to that canvas and focuses the card.
- **Layout is a pure function of the anchor's geometry.** No collision pass,
  no iteration: two cards' portals may overlap, and that is a better failure
  than pills that drift while you drag.
- **Deleted endpoints render as echoes** (`TombstoneNode`) rather than
  disappearing, visible only to the link's creator, matching the snapshot rule
  from M3.

## Hubs

- **A hub is a property of the placement (`placements.is_hub`), not a browser
  preference.** A shared board therefore looks the same to everyone and folding
  survives changing machine. Editors set it; viewers see the result.
- Per placement, so a card can be a hub on one canvas and an ordinary card on
  another — the same reasoning as columns below.
- Collapsed children are drawn at a fixed collapsed height but **keep their
  stored height**, so unfolding restores the layout exactly.

## Nested boards

Borrowed from Milanote, which solves "this canvas is about that card" better
than a sidebar tree does.

- **A board card is a card type whose payload holds a `canvas_id`.** Nesting is
  therefore *derived*: a canvas is nested iff some board card points at it.
- **No parent pointer and no tree.** The immediate payoff is that putting the
  same nested canvas on several boards is not a special feature — it is just
  two board cards pointing at one canvas, and it works because nothing claims
  to own the relationship.
- **Name, card count, and cover are resolved on read** into `CardOut.board`,
  never denormalised, so a renamed canvas is instantly right everywhere.
- Deleting a board card does not delete its canvas; it is a pointer.

## Columns

Milanote's stacks: items flowing vertically inside a titled container.

- **A column is a card type**, so it gets placements, sharing, undo, and
  deletion for free rather than being a fifth kind of object.
- **Membership is `placements.parent_id` + `sort`** — on the *placement*, not
  the card, so membership is per-canvas. The same card can sit in a stack on
  one board and loose on another, which follows directly from placements being
  a join table.
- **Constraints are enforced server-side** (`_validate_parent`): same canvas,
  the parent must be a column, no self-parenting, no columns inside columns.
  One level is enough to be useful and avoids every layout question that
  arbitrary nesting raises.
- **Members stay real xyflow nodes** with `parentId`/`extent: "parent"` rather
  than being drawn by the column, so they keep their menus, handles, links, and
  resize behaviour. `frontend/src/store/columnLayout.ts` owns the geometry as
  pure functions.
- **A member's stored x/y is left untouched** while it is in a column, so
  dragging it out restores where it was before it joined.

## Capturing a file is its own endpoint

- **`/api/capture/file` rather than teaching `/api/capture` to take both.**
  FastAPI cannot cleanly accept a Pydantic JSON body and an `UploadFile` on
  one route: the existing `text`/`url`/`title` would have to become
  `Form(...)` fields, which breaks every shortcut and every script already
  posting JSON. A second path leaves all of that untouched.

- **It routes on mime and always produces something.** An image becomes an
  image card, audio becomes an audio card with transcription queued, and
  anything else becomes a file card rather than a 415. A share sheet offers
  whatever the other app happens to be holding, and a PDF you cannot capture
  is a worse answer than one you can capture but not preview.

- **Built from the same helpers the bots use**, so a card captured from a
  phone is the same shape as one dragged onto the canvas — crop, the
  lightbox and the cut-out rendering all work on it without knowing where it
  came from.

- **Streamed, not buffered.** `store_upload` enforces the ceiling as it
  writes, so an oversized file is never fully received. The bots cannot use
  it — they are handed bytes that were already downloaded — which is why the
  limit there belongs to the adapter instead. `app/media.py` now holds the
  allowed types, the ceilings and the storage for all three callers.

## A dragged card leans into the move

- **The lean is a transform on `.card-node`, never on the node wrapper.** The
  wrapper's transform is the card's position on the canvas; touching it makes
  the card lag the pointer. Same rule the lift already followed.

- **Horizontal velocity rotates, vertical velocity stretches.** A rotation
  cannot express up or down, and skewing text to fake it looks broken —
  so vertical motion elongates the card along the direction of travel and
  narrows it across, which is squash-and-stretch and is how a moving object
  reads as moving rather than as teleporting.

- **Written to the DOM, not to React state.** It changes every frame of a
  drag, and re-rendering the canvas at that rate to move a card five degrees
  would cost far more than the effect is worth. The elements are collected
  once on drag start.

- **Smoothed twice, on purpose.** The handler runs an exponential average over
  the pointer velocity, and the stylesheet's existing 90ms transition does the
  rest. Neither alone is enough: raw per-frame deltas twitch, and a drag that
  pauses reports zero for a frame and snaps flat. Two stages are what turn a
  velocity readout into something with weight.

- **Amplitude lives in `theme.css`** (`--sway-tilt`, `--sway-stretch`) and the
  handler only ever writes a number in -1..1. That also gives
  `prefers-reduced-motion` something to switch off: the lean is a live
  transform rather than a transition, so flattening durations does not reach
  it, but zeroing the amplitude does.

## A transparent image is an object, not a photograph

- **An image with real transparency loses its card.** No surface, no border,
  no shadow, no accent bar — the cut-out sits directly on the canvas. On a
  spatial board a logo in a frame with see-through patches reads as a
  rendering fault; the same logo floating on the board reads as a thing you
  put there.

- **Measured from the pixels, never from the mime type.** A screenshot saved
  as a PNG is an ordinary opaque picture and must keep its frame, and going
  by format would strip the frame off every one of them. A small copy is
  drawn to a canvas and its alpha channel counted, with a floor of 2% —
  an opaque photo with softened corners or a hairline of edge alpha is still
  a photo. JPEG never reaches the canvas at all, since it cannot carry alpha.

- **Answered in the browser, not at upload.** The file is same-origin so a
  canvas reads it back untainted, and the image has already been decoded to
  be shown. The alternative was decoding five image formats server-side,
  which meant a new dependency for a question the client had already
  answered. Cached by `src`, so a card never flickers back to framed on a
  revisit.

- **Painting the card is how you get the frame back.** The rule is
  `.is-cutout:not(.is-painted)`, so choosing a fill is respected rather than
  silently ignored — and it gives anyone who dislikes the effect a way out
  that already exists.

- **Selection becomes an outline rather than a border.** With nothing to draw
  a border on, an outline sits outside the box and reads as a marquee around
  the object instead of the frame coming back.

## Search results go somewhere

- **Every result is a button.** They were labels, which made the panel a
  read-only report on a canvas you then had to find things on yourself. A
  card on this canvas selects and centres; one elsewhere follows the same
  `?card=` trail a portal pill uses, so arriving from a search behaves
  exactly like arriving from a link. A card on no canvas at all opens the
  inbox, because that is where it is.

- **Search closes on the way through.** Its dimming is the reveal's machinery
  and takes precedence over it, so landing on a card with the overlay still
  up would show you the card and none of what it connects to.

- **Cards on this canvas are listed too**, not only lit up. The summary
  counts them, and a count with no rows under it reads as results that failed
  to arrive — which is exactly how it was reported.

- **A link result carries its endpoints' placements.** The note that matched
  lives on the link rather than on either card, so neither end necessarily
  appears in the card hits where placements would otherwise have been
  resolved; without them a link result is a dead end. Following one lands on
  the source card — the end the arrow leaves — and opens the panel there.

- **`focusLinkId` survives exactly one reveal.** The link panel reads its link
  out of the current reveal, and selecting a card loads a reveal, which
  clears the selected link: re-rooting the reveal somewhere else should not
  leave an unrelated panel open. Following a link result is the one exception,
  so it is a separate field that the next reveal load consumes and clears
  unconditionally — it cannot linger and reopen a stale panel later.

- **Embedding coverage is counted against what is embeddable, not against
  every card.** An image with no title has no text to turn into a vector, so
  it is not a gap waiting to be filled; counting it would hold the figure
  below the total for ever and read as a rebuild that never finishes. Its own
  endpoint (`/search/coverage`) rather than a field on `/search/status`,
  which the search overlay hits every time it opens — walking the caller's
  cards is a strange cost to put on opening a search box.

## Links: direction, layer, and arrival

- **A link line passes behind every card.** A line drawn over a card covers
  the thing the line is about. See `invariants.md` for why this needed a
  stacking context rather than a z-index.

- **Turning a link around is its own endpoint** (`POST /links/{id}/flip`),
  not two more fields on the PATCH. Accepting `source_card_id` and
  `target_card_id` from a client would make PATCH a way to re-point a link at
  any card the user can see, and every visibility rule the link carries would
  have to be re-checked there. A flip re-points nothing — the same two cards
  stay attached — so nothing about who can see the link can change. The
  snapshots swap along with the ids, or a tombstone ends up captioned with
  the wrong card's title.

- **The arrow between the two titles is the control.** Direction is the thing
  that arrow already draws, so turning it around is the obvious way to ask
  for the link to be turned around; it rotates on hover to say so before the
  click. Direction is not cosmetic here — the reveal's traversal is
  direction-locked and a hub folds the cards it points *at* — so this is a
  real edit, not a display preference.

- **A revealed link draws itself on, source to target.** Selecting a card asks
  what it is connected to, and the answer travels out to the cards that
  answer it. Hop 2 waits for hop 1 to land, so the reveal spreads one step at
  a time rather than arriving whole.

  Always source to target, never outward from the card you selected. An
  incoming link drawn backwards would land its arrowhead where the line
  *starts*, which is the one thing about direction the reveal must not
  muddle. Outgoing links therefore radiate and incoming ones converge, which
  turns out to read better than either alone.

  The arrowhead is held back until the line reaches it. It is a marker rather
  than part of the stroke, so a dash animation leaves it sitting on the
  destination card waiting for a line that has not arrived. It is released on
  the animation's own `animationend`, which keeps every duration in
  `theme.css` instead of restating one in the component.

## What un-dims during a drag

- **The light means "this is what the drop acts on", not "this is nearby".**
  The first version un-dimmed any card whose rectangle came within 420px of
  the dragged one. On a sparse board that read as helpful; on a busy one it lit
  most of the screen and told you nothing about the outcome, because distance
  and consequence are unrelated here. Proximity is now gone from this path
  entirely — a card un-dims when a drop would link it, and a column un-dims
  when a drop would go into it, both of which are already computed for the
  drop itself.

- **The target brings its own neighbours up with it, one hop.** Joining a card
  means joining what that card is already part of, so seeing that
  neighbourhood before letting go is the same question the reveal exists to
  answer. One hop and no further: a link walks the whole connected component
  in two or three, which would un-dim the board and put the proximity problem
  back with extra steps. Direction is ignored — a neighbour is a neighbour
  whichever way the arrow points, unlike the reveal's own traversal, which is
  direction-locked to stop hubs lighting up their entire neighbourhood.

- **The adjacency is keyed by card id, not placement id.** `nodes` is rebuilt
  on every frame of a drag; the link graph is not. Keying it by card keeps it
  out of the drag's work and resolves to placements only when something is
  actually being lit.

## Rich text cards

- **Card bodies are GFM markdown**, rendered by `CardMarkdown` (remark-gfm):
  tables, task lists, strikethrough, all of it plain text at rest and therefore
  still searchable, embeddable, and capturable by bots.
- **Checkboxes are live on the rendered card** — clicking one rewrites the
  source line and saves. Rewriting is keyed on the **line number remark
  reports**, never an index into rendered output, which desynchronises as soon
  as a list is nested or interrupted.
- A small toolbar covers the things worth not memorising (checklist, bullets,
  table); everything else is just markdown.

## Card colour

- **Colour is a named paint** in `payload.color` — eight of them, plus a
  default — and the named paints stay the recommended answer. Each is a solved
  set: a fill, a border a step deeper, an ink that clears 4.6:1 on it, all
  fixed across both themes. They are also the only ones that can later become
  a search filter, which a hex cannot.

- **A custom hex sits alongside them, in the same key.** The original call was
  named-only, on the grounds that a user-picked hex looks wrong the moment the
  theme changes. That reasoning expired when the palette stopped remapping per
  theme — a paint is now one fixed colour everywhere, so a hex is no more
  theme-dependent than a named hue is. What a hex still cannot bring with it is
  a solved border and ink, so those are derived from it (`lib/colour.ts`):
  the border is the colour a quarter of the way to black, matching the step the
  hand-solved palette already uses, and the ink is whichever of the two fill
  inks has more contrast against it. That keeps a custom card readable. Whether
  the colour itself is a good one on both surfaces is deliberately left to the
  person who picked it — the wheel is the second option in the row, not the
  first.

- **The wheel commits on release, not on every frame.** A commit is a `PATCH`
  on the card, and a drag across the saturation square passes through a few
  hundred colours. The panel previews live; the card catches up on pointer-up.
  The card menu had to stop closing on `pointerleave` while a button is held
  for this — a drag that starts on the square routinely ends outside the menu.
- Applied as a tint plus an edge, not a fill, so text contrast holds in every
  theme.

## Look and feel

- **Three themes**: Paper (light), Ink (dark), Dusk (slate/pastel), registered
  as a list in `theme.ts`, picked in Settings, cycled from the toolbar.
- **Every colour, radius, shadow, and motion value is a token in `theme.css`.**
  Adding a theme is a `.theme-*` block, a `THEMES` entry, and a background
  colour in the `index.html` boot script — the last of those prevents a flash
  of the wrong theme before React mounts.
- **Canvases have cover images**, taken from a card on them, so the canvas list
  reads as a shelf of boards rather than a list of names.

## Dialogs

Native `confirm`/`prompt`/`alert` are gone from the app entirely — they are
suppressed in the target browsing context and turned every destructive action
into a silent no-op. All of it now goes through `dialogStore` + `DialogHost`.
See [invariants.md](invariants.md); this one is worth not rediscovering.

## Splitting a card into inbox cards

The first generation feature, and the shape the rest should follow.

**The model is a capture source, not an editor.** Output lands unplaced in the
author's inbox, exactly like a share-sheet or bot capture, and `capture_card`
is the same code path. That inherits the review queue, the triage hints, and
the drag-to-place gesture, and it means the "every output is a suggestion"
rule is satisfied structurally: nothing existing is mutated, so there is
nothing to store apart from user data. The `suggestions` table that titles and
drafted link reasons will need is not needed here — the inbox *is* the staging
area.

**The output is a flat list of `{title, body}`.** No links, no positions, no
references between entries. This is the whole reason the feature is shaped
this way. It is the one JSON shape a small local model returns reliably
without constrained decoding, and partial failure is survivable: nine good
cards and one malformed one costs you the malformed one. A generated *cluster*
— nodes and edges together — is the shape small models get wrong, and the
failure is silent, so it stays unbuilt.

**The input is always text that already exists on a card.** The model
rearranges; it does not invent. Every output is checkable against a source
still sitting there. Open-ended generation would put notes nobody took into
the same inbox as notes somebody did, which is the design doc's rejection of
whole-canvas chat pointed at the write side.

Decisions worth not rediscovering:

- **Viewing a card is enough to split it.** The source is never modified and
  the new cards belong to whoever asked, so this is the same right that
  already lets a viewer link to a card. Writing a progress marker onto the
  source would have needed edit rights and would have shown a spinner on
  someone else's screen; the batch endpoint reports progress instead.
- **Generated cards that nobody has placed stay out of link suggestions.**
  Otherwise a model's own unreviewed output becomes the input that shapes the
  next suggestion. They are still embedded, because inbox triage asks *this*
  card where it belongs. Placing one is the endorsement that lets it back in.
- **Discarding a batch spares anything already placed.** Putting a card on a
  canvas is how you keep it, so a late discard can never take back something
  committed to.
- **An empty result is a finished job, not a retry.** The same prompt against
  the same model produces the same nothing three times.
- **A split may include a hero card, and still makes no links.** The hero is
  the one card that says what the whole note is about; it arrives as a heading
  card and does not count against the card limit. Linking every other card to
  it would have been safe to generate — the topology is fixed, so the model
  never emits an edge — but a link in this app is a claim a person made, and
  arranging is the half of the job the split deliberately leaves alone. The
  hero is held apart from the cards list in the response rather than being its
  first entry, so a hero that failed to parse cannot silently become an
  ordinary note.
- **Order within a batch is not meaningful.** Every card in a split is written
  in one transaction, so they share a `created_at` and the inbox's ordering
  falls through to a random uuid. Anything that needs an order — the hero
  leading its group — sorts explicitly in the panel.
- **`response_format` is sent, then dropped on a 400.** Servers that support
  JSON mode get it; the ones that reject it still work, which is what keeps
  "point it anywhere" true. The parser stays forgiving either way.
- **Sourcing and structuring are separate concerns, and the prompt must not
  collapse them.** The first version's anti-invention rules were broad enough
  ("no summaries of your own", "keep the note's own wording") that they also
  forbade organisational work, leaving a splitter that cut at paragraph
  boundaries in reading order. Restructuring aggressively and inventing
  nothing are compatible: the prompt now asks the model to group by meaning
  rather than position, to hold one axis of division, and to title a card for
  what it is about — while still permitting no fact that is not in the note.
  If that rule is ever loosened, loosen the structural half, never the
  factual one.
- **Strip a reasoning model's scratchpad before parsing.** `<think>` content
  arrives as ordinary text, and one stray bracket or a draft the model then
  discarded defeats the outermost-delimiter fallback. The failure is silent —
  no cards rather than wrong cards — which is the worst shape it could take.
  The suggested model in the settings placeholder is a non-thinking one for
  the same reason.

## Objects on a canvas, not panels in an app

A revision of an earlier call, so the old one is written down here rather than
quietly contradicted.

**The design doc said every card type carries a title and a body** (§"All
types share title, body, timestamps, and free resize"). The storage rule still
holds — every card *can* have them — but the interface rule does not. Only a
text card is *about* its title and body. On a photograph or a recording they
are a caption, and an absent caption now takes up no room and draws no chrome.

**Only text cards keep the type spine.** Everything else already announces
what it is: a photograph looks like a photograph, a player looks like a
player. A coloured bar down the side of a picture was decoration at best. The
spine survives on text cards because it is the only thing there carrying a
colour.

**Cards have no resting border.** The shadow separates a card from the canvas
and its own content separates it from its neighbours; the border returns on
hover and selection, where it means something.

**Surfaces lift, the canvas sinks.** In the dark themes the canvas went down
and the card surface came up, so a card reads as paper on a dark table rather
than a panel in a tool. Column headers carry a fraction of the colour they
used to: a label should not outweigh the things it labels.

**A text card in a column shows its title and one line.** Clicking it opens
the rest in place and the column reflows. Nothing is stored for this — the
clamp changes the content's height, and the measurement that already sizes
column members picks it up. A stack is a list of things; reading one of them
is a deliberate act.

## Still deliberately absent

- **The Discord gateway client.** Everything around it is built and tested;
  [build-the-discord-bot.md](build-the-discord-bot.md) is a complete brief.
- **Realtime collaboration**, a design-doc non-goal. Reconcile on refresh.
- **The rest of the generation list** — auto-titles for captures, audio
  cleanup, drafted link reasons, suggested link types. These all write onto
  an *existing* card or link, so unlike splitting they do need the
  suggestions table and an accept/dismiss step before anything lands.

## One palette, two themes

There were three themes, and each defined the paint colours itself — a deep
set for light, a bright one for dark, pastels for dusk — so the same red card
was three different reds depending on where you looked at it. Colour is part
of what a card *is*, not a property of the theme, so dusk is gone and the
palette is now defined once and resolves to the same value in both themes.

Only two things still flip with the theme: the surface of an *unpainted* card
and its default text. A painted card is pixel-identical in light and dark.

### Three roles, solved rather than picked

Each hue has three fixed values, chosen by search rather than by eye:

- `--hue-*` — the accent bar, the swatch, and coloured text. Holds at least
  3.4:1 against both card surfaces.
- `--fill-*` — a painted card's background: bold and saturated, all eight at
  the same lightness so the palette reads as one set.
- `--fill-ink-*` — the text for that fill, white or near-black depending on
  the hue, every pair clearing 4.6:1.
- `--fill-edge-*` — its border.

The honest limit: **AA (4.5:1) on both surfaces is arithmetically impossible
for a single fixed colour.** It would need a near-black card surface. The best
balanced point is about 3.6:1, so coloured text is for deliberate accents and
the default text stays the theme's own high-contrast ink, which is what nearly
every card uses.

## Colour is per card type, not one global choice

Not every card wants every option, so the axes a card offers depend on what
kind of thing it is:

| Card | Accent | Fill | Text |
| --- | --- | --- | --- |
| Note, heading, to-do | ✓ | ✓ | ✓ |
| Table | | | ✓ |
| Column | | ✓ | |
| Link, image, video, audio, file, board, document | ✓ | | |

A table is a grid of numbers: painting the card behind it only makes the grid
harder to read. Anything built around a piece of media gets the accent alone,
which groups things without competing with the thumbnail underneath it.

The accent also moved from a spine down the left-hand side to a bar across the
top, and it is no longer drawn on cards that have not asked for one — a note
stays bare until you give it a colour, while a link or an image wears its
type's colour by default.

## A table's colours are its parts, not its card

Painting the card behind a grid only makes the grid harder to read, so a table
has no fill. What it has instead are the three things a table is actually made
of: the accent bar, the header row, and the data.

The header row's colour is stored as `header_color`, not `header`. A table
already keeps a boolean under `header` saying whether it has a header row at
all, so the first version was silently rewritten to `true` by the server's
normaliser on every save. There is a test pinning both.

## What "the card colour" means depends on the card

A heading card is a slab of colour, and that slab is the *card* — so it
follows the fill, like every other painted card. It followed the accent for as
long as a card had only one colour to give; once the axes split, picking a
card colour on a heading did nothing and only the accent moved. Its title
colour was hardcoded `#fff` for the same reason.

Both are now the ordinary tokens with ordinary fallbacks, which is also what
lets a heading take a text colour of its own.

## Inputs do not inherit

Three separate times a chosen text colour failed to reach the words: table
cells, checklist items, and heading titles. The first two are `<input>`
elements, which take a browser default rather than the colour of the element
around them unless told `color: inherit`. Anywhere a card keeps its text in a
form control, the ink rule has to say so explicitly.

## A document is written, not marked up

The document editor was a `<textarea>` with a toolbar that pushed `**` and
`##` into the text. That made markdown something you *read while writing*
rather than a storage format, which is the opposite of the point.

It is a TipTap (ProseMirror) surface now. **What is stored has not changed:**
the body is still markdown, because `search_text` is generated over it, the
embeddings read it, the split reads it and export hands it to you. The syntax
simply stopped being visible.

The note editor keeps its old markdown toolbar. A note is a short thing typed
into a small card; a document is the one that asked for room.

### Colour and highlight have no markdown

Markdown has no syntax for either, so the editor writes them as inline HTML
inside an otherwise ordinary markdown file — valid markdown, and it round
trips. The cost is that card bodies now have to render raw HTML instead of
escaping it, which for a shared board means rendering markup written by
whoever last edited the card.

So it is sanitised on the way through, in `lib/richMarkdown.ts`: an allowance
of three tags (`mark`, `u`, `span`), and `style` scrubbed down to `color` and
`background-color` with values that have to look like colours. Verified
against a card carrying a `<script>`, an `onerror` handler, a `javascript:`
href, a full-viewport `position: fixed` overlay and a `background-image:
url(...)` — all stripped, the legitimate colour kept.

## A document card previews, it does not scroll

A preview that scrolls invites you to read a document through a letterbox. The
card shows what fits, dissolves the last couple of lines, and leaves the rest
to the editor — so the fade means "there is more" rather than "this is cut
off". Resize the card to read more; open it to read all of it.

The footer naming the card type is what makes it obvious the card can be
opened at all, rather than being a wall of text someone forgot to finish.

### Two modes from one piece of markup

Big enough to preview honestly, and it is a page. Too small, and it becomes a
file icon with its name under it. The card queries its own size, so resizing
switches modes with nothing measured in JavaScript.

One trap: `@container` takes a *single* condition. The comma-separated form
that works in `@media` makes the whole rule invalid, and it is dropped in
silence — the icon mode simply never arrived. It needs `or`.

## The reasoning on a link is content, not decoration

A link already carried a note — the *why* two cards belong together, which is
often the most concentrated thinking on a board because it gets written at the
moment you understood something. None of it was reachable. `search_text` is a
generated column on `cards`, and a generated column cannot read another table,
so the note was write-only: you could record why two things connect and then
never find it again.

Links now carry their own full-text index and search returns them beside the
cards, under their own heading. They are a separate result list rather than
folded into the card hits on purpose — a link is not a card, and filing the
note under both of its ends would say the same thing twice without saying what
it joins. Each hit leads with the note and shows the two cards and the type
underneath, because a note alone is meaningless: "because it assumes
retention" only means something once you can see what it joins.

There is no semantic pass over notes. They are short and written in your own
words, so the words are what you will search for.

## A file is an object, not a row

The file card was a small badge beside a strip of text with a download arrow
pinned to the corner — a row out of a list, dropped on a canvas. It is the
same kind of thing as a document icon: a glyph, a name, one number of context.
So it is drawn the same way, sheds its card chrome at the same size, and takes
its accent on the glyph. The extension is written across the glyph the way a
real file icon carries it, rather than queueing up as a fourth stacked line,
and the download only appears on hover — the card is a name and a picture, and
a permanent arrow competed with both.

