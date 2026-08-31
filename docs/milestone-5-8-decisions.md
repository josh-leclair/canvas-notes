# Milestones 5 through 8: Decisions

Same contract as the earlier decision docs: the design doc wins on intent,
this wins on detail. Records the calls that M5–M8 force, including the design
doc's remaining open questions.

## Milestone 5: Capture

- **Two auth paths, one user model.** `Authorization: Bearer <token>` works
  anywhere the session cookie does. Tokens are `cnv_` + 32 random bytes,
  base64url, sha256 at rest, shown once, revocable, with `last_used_at`
  touched at most hourly (same amortization as sliding sessions).
- **One capture endpoint** (`POST /api/capture`) takes `{text?, url?, title?}`
  and decides the card type server-side. The URL-detection rule that lived in
  the frontend moves to `app/urls.py` so the web app, the API, and every bot
  produce identical cards. Captures are always unplaced: a share sheet cannot
  know x and y.
- **Bots are adapters over one handler.** `app/bots/base.py` owns the entire
  policy — resolve platform identity to a user, drop unpaired senders
  silently, consume pairing codes, capture the message. A platform adapter
  only converts its own message shape into that call. Telegram (long polling)
  is implemented; **Discord is a registered-but-disabled stub** whose adapter
  raises if started, so adding it later is one file and no plumbing.
- **Pairing** is the bot's whole auth model: the web app issues a 8-character
  code, the user sends it to the bot once, `bot_identities` gets a row.
  Codes are single use, expire in 15 minutes, and are consumed atomically.
- **Bots run in the worker process**, not the API. They are outbound
  connections, so they work behind NAT with no port forwarding — for a NAS
  user that may be the only capture path that works at all.
- Audio messages from bots are accepted and flow into the existing
  transcription queue.

## Milestone 6: Sharing

- **Roles.** `canvas_members(canvas_id, user_id, role)` with `viewer` or
  `editor`. The owner is implicit and not a member row.
- **What each role can do.** Viewer: read the canvas and the cards on it.
  Editor: additionally create cards on it, move/resize/add/remove placements,
  and edit the *content* of cards placed on it — that is what "editor" has to
  mean on a shared board, and last-write-wins is already the stated model.
  Only a card's **owner** may delete the card itself; only a canvas's
  **owner** may rename, delete, or change sharing.
- **Card visibility** is derived, never stored: you can see a card if you own
  it or it is placed on a canvas you can see. This is one EXISTS subquery,
  centralized in `app/access.py`, and it replaces every `owner_id == me`
  filter on card reads.
- **Link visibility follows the design doc exactly**: a link is visible to
  whoever can see *both* endpoints, regardless of who created it. This is a
  real change from M3, which filtered links by `creator_id`. Only the creator
  may edit or delete a link.
- **Viewers may create links** from cards they can see. A link is the
  creator's own data, not a mutation of the canvas, so it does not need
  editor rights. (Design doc open question, answered.)
- **Deleting a card with inbound links from other users proceeds.** Their
  links get tombstones from the snapshots — that is what snapshots are for.
  Nobody's delete is blocked by a stranger's reference. (Open question,
  answered.)
- **Unsharing is revocation**: the removed member immediately loses the cards
  and any links whose endpoints they can no longer see. Links they created
  survive and render as tombstones on their side.
- Sharing stays non-realtime. Reconcile on refresh.

## Milestone 7: Embeddings, search, suggestions

- **Postgres must have pgvector.** Compose switches to
  `pgvector/pgvector:pg16` (data-compatible with `postgres:16`). The
  `embedding` column is `vector(EMBEDDING_DIM)`, default 768, fixed per
  instance at migration time.
- **Embedding is a job kind**, enqueued on card create and on any edit that
  changes embeddable text: title, body, unfurl description, transcript. If no
  embedding endpoint is configured the job short-circuits and the column stays
  null — the feature hides rather than erroring.
- **Search has two independent halves.** Full-text (Postgres `tsvector` over
  title, body, transcript, unfurl description) works on every instance and is
  the floor. Semantic search is offered only when embeddings exist. The
  endpoint reports which modes are available so the UI can hide what is not.
- **Search filters the canvas in place**, reusing the reveal's dimming
  machinery, and lists off-canvas hits beside it. (Design doc open question,
  answered — it was the cheaper and more spatial answer.)
- **Suggestions stay out of the graph**, as decided in the M3/M4 doc: a panel
  on the selected card, with accept creating a real link. Already-linked and
  self are excluded.
- **Inbox triage** suggests a canvas per unplaced card from where its nearest
  neighbours live, and is hidden when embeddings are unavailable.

## Milestone 8: Polish

- **Undo covers placement geometry only** — moves, resizes, and placement
  removal, the things free placement makes easy to do by accident. It is a
  client-side stack of inverse operations, capped at 50, cleared on canvas
  change. Content edits, deletions, and link changes are *not* undoable; they
  all have confirmations or are trivially redone by hand. (Design doc open
  question, answered narrowly on purpose: a full undo stack over a shared
  last-write-wins document is a much larger project.)
- **A cheat sheet overlay** (`?`) lists every gesture, because the app has
  several invisible ones: double-click to edit, shift-drag to rubber band,
  handle-drag to link, edge-click to edit a link, space-drag to pan.
