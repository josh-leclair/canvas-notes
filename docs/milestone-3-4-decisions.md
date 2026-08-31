# Milestones 3 and 4: Decisions

Companion to the design doc, in the spirit of the M1/M2 spec: the design doc
wins on intent, this file wins on detail. It records the resolutions to the
open questions that block the `links` table and the card types, plus two
sequencing corrections.

> **Terminology, since superseded.** What this document calls a *ghost* is now
> a **portal**: same idea, but pinned beside its anchor card and clickable to
> travel there, rather than positioned loosely around the root. The rendering
> decision was revisited after hands-on use — see
> [beyond-milestones-decisions.md](beyond-milestones-decisions.md). The schema
> and traversal decisions below are unchanged and still current.

## Sequencing corrections

1. **Ghosts and tombstones are M3, not M6.** Cross-canvas links are legal the
   moment links exist, and card deletion has existed since M1, so the reveal
   meets both off-canvas endpoints and dead endpoints immediately. They were
   grouped with sharing in the build order, but they are link features, not
   sharing features.
2. **Viewport culling is on now** (`onlyRenderVisibleElements`), not at the
   step-9 performance pass. It is one prop.

## Link schema decisions

- **Endpoints survive card deletion.** `source_card_id` and `target_card_id`
  are nullable with `on delete set null`. A link whose endpoint is null renders
  as a tombstone from its snapshot. This is implied by the design doc
  ("survives the loss of its endpoints") but not spelled out in its schema.
- **`link_type` is a text column validated in the app** against the controlled
  set: `supports`, `contradicts`, `source_for`, `follows_from`, `related`.
  Not a Postgres enum. This answers "fixed list or user extensible" with
  "fixed for now, extensible without a migration if that changes."
- **Suggested links stay out of the graph.** No `status` column. When M7
  builds suggestions they live in a side panel; if that decision reverses,
  it is one nullable-column migration.
- **Duplicate links between the same pair are allowed.** They are directed and
  can carry different types; no unique constraint.
- **Snapshots** capture `{title, url, excerpt}` at link time (url only for
  link-type cards, excerpt is the first 200 chars of body or unfurl
  description). Never displayed while the endpoint is alive.

## Reveal decisions

- **Computed server-side**, one request per selection:
  `GET /api/cards/{id}/reveal?canvas_id=`. The response is the bounded 2-hop
  set: links tagged with hop and travel direction, endpoint cards, their
  placement on the current canvas if any, and home-canvas names for ghosts.
  One selection = one query round trip; the payload is small by construction
  (the design doc's own argument for why the reveal is a good retrieval unit).
- **Direction lock** is enforced in the traversal, not the renderer: hop 1
  expands both ways from the root; hop 2 expands children only to their
  children and parents only to their parents. A card reached both ways at
  hop 1 expands both ways.
- **Ghosts of ghosts: yes.** Hop-2 traversal does not care where a card is
  placed; any revealed card without a placement on the current canvas renders
  as a ghost. Ghost/tombstone positions are computed client-side around the
  root and never persisted.

## Card type decisions (M4)

- **The job queue is a Postgres table** claimed with
  `for update skip locked`. No Redis. Workers declare which job kinds they
  support and never claim the rest, so a queue can hold transcription jobs
  while only an unfurl-capable worker is running.
- **The API process runs an inline worker thread** (handles `unfurl`, and
  `transcribe` when faster-whisper happens to be importable). The compose
  `worker` service installs faster-whisper and handles both. Self-hosters who
  skip the worker still get unfurls; transcription jobs wait, matching the
  design doc's degrade-don't-break rule.
- **Unfurl is SSRF-guarded**: http/https only, DNS-resolved address checked
  against private/loopback/link-local/multicast ranges, redirects followed
  manually (max 5) with every hop re-checked, 5s timeout, 2MB read cap. The
  fetched page is parsed for OpenGraph/title/description only.
- **YouTube cards** store `payload.video_id`; the thumbnail is the static
  `i.ytimg.com` image and becomes an iframe only on click. Title/description
  come from the same unfurl job hitting the watch page.
- **Audio files** live on disk under `FILES_DIR`, one `files` row per blob,
  served through the API with owner auth. Transcripts land in
  `payload.transcript` plus `payload.transcript_status`
  (`queued | done | unavailable | error`).
- **Card bodies vs payloads:** `body` stays user-authored prose on every type;
  machine-derived content (unfurl results, transcripts) lives in `payload` so
  it can be regenerated without clobbering the user's words. Same principle as
  "every output is a suggestion."
