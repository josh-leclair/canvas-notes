# Canvas Notes — working notes for agents

## Orientation

- `README.md` — how to run, test, and configure it.
- `backend/app/access.py` — the shared permission boundary.
- `backend/app/models/tables.py` — persisted application state.
- `frontend/src/store/canvasStore.ts` — canvas state and interactions.
- `frontend/src/theme.css` — shared appearance and motion tokens.

## Rules with teeth

- **Branch on what a node *is*, not on how it renders.** `if (node.type !==
  "card")` has silently excluded columns three separate times. Ask whether it
  has a placement instead.
- **Never `window.confirm` / `prompt` / `alert`.** Suppressed in the target
  browser: no dialog, no console output, action silently does nothing. Use
  `frontend/src/store/dialogStore.ts`.
- **Never persist xyflow dimension changes** — infinite measure loop, blank
  page.
- **Link handles, `NodeResizer`, and menus go *outside* `.card-node`**, which
  sets `overflow: hidden` and clips them.
- **All permission logic lives in `backend/app/access.py`.** Nothing else
  hand-rolls an ownership check.
- **All colour/radius/shadow/motion values live in `frontend/src/theme.css`.**
  Three themes read those tokens; a literal value elsewhere breaks one of them.
- **Derived state stays derived** — inbox, nesting, visibility. Don't
  denormalise.

## Verifying changes

The backend suite currently has 300 tests. Database-independent tests run
everywhere; integration tests skip when no real Postgres is reachable, so a
local pass with skips is not a complete pass. See the README for the container
and environment variable.

Canvas interactions are not covered by any test, and are where every
user-reported bug has been. Verify them by hand against a running instance —
drag, drop into a column, resize, reload, and confirm the change *survived the
reload*, since several bugs were invisible until then.
