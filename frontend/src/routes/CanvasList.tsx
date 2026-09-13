import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { CanvasAppearance, CanvasSummary, Invite } from "../api/types";
import { useAuth } from "../auth";
import Logo from "../components/Logo";
import ShareDialog from "../components/ShareDialog";
import { tintGradient } from "../lib/tint";
import { exportCanvasArchive, importCanvasArchive } from "../lib/canvasArchive";
import {
  initialCanvasSize,
} from "../lib/canvasBounds";
import {
  applyCanvasSurfaceAppearance,
  normaliseCanvasAppearance,
  readCanvasAppearance,
  readCanvasListAppearance,
  rememberCanvasAppearance,
  rememberCanvasListAppearance,
} from "../lib/canvasAppearance";
import { confirmDialog, promptDialog } from "../store/dialogStore";
import { cycleTheme } from "../theme";
import "./canvasList.css";

const APPEARANCES: Array<{
  id: CanvasAppearance;
  name: string;
  note: string;
}> = [
  { id: "studio", name: "Studio", note: "Quiet, editorial, focused" },
  { id: "pantry", name: "Pantry", note: "Warm, bright, playful" },
  { id: "night_garden", name: "Night Garden", note: "Deep, vivid, literary" },
];

function appearanceOf(canvas: CanvasSummary): CanvasAppearance {
  return normaliseCanvasAppearance(
    canvas.appearance ?? readCanvasAppearance(canvas.id)
  );
}

export default function CanvasList() {
  const { user, setUser, bootstrap } = useAuth();
  const navigate = useNavigate();
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [name, setName] = useState("");
  const [listAppearance, setListAppearance] = useState<CanvasAppearance>(() =>
    readCanvasListAppearance()
  );
  const [appearance, setAppearance] = useState<CanvasAppearance>(() =>
    readCanvasListAppearance()
  );
  const [invites, setInvites] = useState<Invite[]>([]);
  const [showInvites, setShowInvites] = useState(false);
  const [sharing, setSharing] = useState<CanvasSummary | null>(null);
  const [error, setError] = useState("");
  const [showNested, setShowNested] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState("");
  const archiveInputRef = useRef<HTMLInputElement>(null);

  // Boards that live inside another board are reachable from it, so they stay
  // out of the top level unless asked for — otherwise the list becomes every
  // board that exists rather than the handful you think of as projects.
  const topLevel = canvases.filter((c) => !c.is_nested);
  const nested = canvases.filter((c) => c.is_nested);

  async function refreshCanvases() {
    setCanvases(await api.get<CanvasSummary[]>("/api/canvases"));
  }

  useEffect(() => {
    void refreshCanvases();
  }, []);

  useLayoutEffect(() => {
    applyCanvasSurfaceAppearance(listAppearance, "list");
    rememberCanvasListAppearance(listAppearance);
  }, [listAppearance]);

  function chooseListAppearance(next: CanvasAppearance) {
    setListAppearance(next);
    // A newly-created canvas begins in the mood currently framing the list,
    // unless the person deliberately picks another one in the create panel.
    setAppearance(next);
    applyCanvasSurfaceAppearance(next, "list");
  }

  async function createCanvas(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const size = initialCanvasSize();
    const canvas = await api.post<CanvasSummary>("/api/canvases", {
      name: name.trim(),
      appearance,
      width: size.width,
      height: size.height,
    });
    rememberCanvasAppearance(canvas.id, appearance);
    navigate(`/c/${canvas.id}`);
  }

  async function deleteCanvas(canvas: CanvasSummary) {
    const ok = await confirmDialog({
      title: `Delete “${canvas.name}”?`,
      body: "Its cards move back to your inbox. Nothing is lost.",
      confirmLabel: "Delete canvas",
      danger: true,
    });
    if (!ok) return;
    await api.delete(`/api/canvases/${canvas.id}`);
    setCanvases((cs) => cs.filter((c) => c.id !== canvas.id));
  }

  async function setCover(canvas: CanvasSummary, file: File) {
    const form = new FormData();
    form.append("file", file);
    const resp = await fetch(`/api/canvases/${canvas.id}/cover`, {
      method: "PUT",
      body: form,
      credentials: "same-origin",
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => null);
      setError(data?.error?.message ?? "Could not set that cover");
      return;
    }
    setError("");
    // Bump updated_at so the browser fetches the new image rather than a
    // cached one at the same URL.
    setCanvases((cs) =>
      cs.map((c) =>
        c.id === canvas.id
          ? { ...c, has_cover: true, updated_at: new Date().toISOString() }
          : c
      )
    );
  }

  async function clearCover(canvas: CanvasSummary) {
    await api.delete(`/api/canvases/${canvas.id}/cover`);
    setCanvases((cs) =>
      cs.map((c) => (c.id === canvas.id ? { ...c, has_cover: false } : c))
    );
  }

  async function leaveCanvas(canvas: CanvasSummary) {
    const ok = await confirmDialog({
      title: `Leave “${canvas.name}”?`,
      body: "You'll lose access to its cards until someone shares it again.",
      confirmLabel: "Leave",
      danger: true,
    });
    if (!ok) return;
    await api.post(`/api/canvases/${canvas.id}/leave`);
    setCanvases((cs) => cs.filter((c) => c.id !== canvas.id));
  }

  async function renameCanvas(canvas: CanvasSummary) {
    const next = await promptDialog({
      title: "Rename canvas",
      label: "Name",
      initial: canvas.name,
      confirmLabel: "Rename",
    });
    if (!next || next === canvas.name) return;
    const updated = await api.patch<CanvasSummary>(`/api/canvases/${canvas.id}`, {
      name: next,
    });
    setCanvases((cs) => cs.map((c) => (c.id === canvas.id ? { ...c, ...updated } : c)));
  }

  async function openInvites() {
    setShowInvites((v) => !v);
    if (!showInvites) setInvites(await api.get<Invite[]>("/api/invites"));
  }

  async function createInvite() {
    const invite = await api.post<Invite>("/api/invites", { expires_in_days: 7 });
    setInvites((list) => [invite, ...list]);
  }

  async function logout() {
    await api.post("/api/auth/logout");
    setUser(null);
  }

  function archiveError(cause: unknown): string {
    return cause instanceof Error ? cause.message : "The archive operation failed";
  }

  async function exportAllCanvases() {
    setArchiveBusy(true);
    setArchiveNotice("Preparing workspace archive…");
    setError("");
    try {
      await exportCanvasArchive(canvases.map((canvas) => canvas.id));
      setArchiveNotice("Workspace archive downloaded.");
    } catch (cause) {
      setArchiveNotice("");
      setError(archiveError(cause));
    } finally {
      setArchiveBusy(false);
    }
  }

  async function exportOneCanvas(canvas: CanvasSummary) {
    setArchiveBusy(true);
    setArchiveNotice(`Preparing “${canvas.name}”…`);
    setError("");
    try {
      await exportCanvasArchive(canvases.map((item) => item.id), canvas.id);
      setArchiveNotice(`“${canvas.name}” archive downloaded.`);
    } catch (cause) {
      setArchiveNotice("");
      setError(archiveError(cause));
    } finally {
      setArchiveBusy(false);
    }
  }

  async function importArchive(file: File) {
    setArchiveBusy(true);
    setArchiveNotice("Importing archive…");
    setError("");
    try {
      const result = await importCanvasArchive(file);
      if (result.scope === "canvas" && result.root_canvas_id) {
        navigate(`/c/${result.root_canvas_id}`);
        return;
      }
      await refreshCanvases();
      const canvasLabel = result.canvases.length === 1 ? "canvas" : "canvases";
      const cardLabel = result.card_count === 1 ? "card" : "cards";
      setArchiveNotice(
        `Imported ${result.canvases.length} ${canvasLabel} and ${result.card_count} ${cardLabel}.`
      );
    } catch (cause) {
      setArchiveNotice("");
      setError(archiveError(cause));
    } finally {
      setArchiveBusy(false);
    }
  }

  return (
    <div className={`list-page canvas-appearance-${listAppearance}`}>
      <header className="list-header">
        <h1>
          <Logo size={26} />
          <span className="brand-word">{bootstrap?.instance_name ?? "Canvas"}</span>
        </h1>
        <Link to="/settings">
          <button className="ghost">Settings</button>
        </Link>
        <details className="list-appearance-picker">
          <summary title="Change the canvas list appearance">
            <span className={`list-appearance-dot appearance-${listAppearance}`} />
            {APPEARANCES.find((option) => option.id === listAppearance)?.name}
          </summary>
          <div className="list-appearance-menu">
            {APPEARANCES.map((option) => (
              <button
                key={option.id}
                type="button"
                className={listAppearance === option.id ? "is-active" : ""}
                onClick={(event) => {
                  chooseListAppearance(option.id);
                  event.currentTarget.closest("details")?.removeAttribute("open");
                }}
              >
                <span className={`list-appearance-dot appearance-${option.id}`} />
                <span>
                  <strong>{option.name}</strong>
                  <small>{option.note}</small>
                </span>
              </button>
            ))}
          </div>
        </details>
        <details className="list-transfer-picker">
          <summary title="Import or export Canvas Notes archives">Transfer</summary>
          <div className="list-transfer-menu">
            <button
              type="button"
              disabled={archiveBusy}
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                void exportAllCanvases();
              }}
            >
              <strong>Export all canvases</strong>
              <small>Includes cards, layouts, links, covers, and attachments.</small>
            </button>
            <button
              type="button"
              disabled={archiveBusy}
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                archiveInputRef.current?.click();
              }}
            >
              <strong>Import an archive</strong>
              <small>Adds new copies without replacing existing canvases.</small>
            </button>
            <input
              ref={archiveInputRef}
              className="list-archive-input"
              type="file"
              accept=".zip,.canvas-notes.zip,application/zip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importArchive(file);
                event.target.value = "";
              }}
            />
          </div>
        </details>
        <button
          className="ghost"
          onClick={() => cycleTheme()}
          title="Switch Studio between Paper and Ink"
          aria-label="Switch Studio between Paper and Ink"
        >
          ◐
        </button>
        {user?.is_admin && (
          <button className="ghost" onClick={openInvites}>
            Invites
          </button>
        )}
        <button className="ghost" onClick={logout}>
          Sign out
        </button>
      </header>
      <p className="list-sub">
        {canvases.length === 0
          ? "Boards for thinking in space."
          : `${canvases.length} board${canvases.length === 1 ? "" : "s"}, ${canvases.reduce(
              (n, c) => n + c.card_count,
              0
            )} cards.`}
      </p>

      {showInvites && (
        <section className="invites-panel">
          <div className="invites-head">
            <strong>Invites</strong>
            <button onClick={createInvite}>New invite (7 days)</button>
          </div>
          {invites.length === 0 && (
            <p className="tile-meta" style={{ margin: 0 }}>
              No invites yet. Registration is closed until you make one.
            </p>
          )}
          {invites.map((inv) => (
            <div key={inv.id} className="invite-row">
              <code>{inv.code}</code>
              <span className="tile-meta" style={{ flex: 1 }}>
                {inv.used_at
                  ? "used"
                  : `expires ${new Date(inv.expires_at).toLocaleDateString()}`}
              </span>
              {!inv.used_at && (
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(
                      `${location.origin}/register?code=${inv.code}`
                    )
                  }
                >
                  Copy link
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      <form onSubmit={createCanvas} className="create-panel">
        <div className="create-bar">
          <input
            placeholder="Name a new canvas…"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="primary" type="submit">
            Create
          </button>
        </div>
        <fieldset className="appearance-choices">
          <legend>Choose its mood</legend>
          {APPEARANCES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`appearance-choice appearance-${option.id} ${
                appearance === option.id ? "is-selected" : ""
              }`}
              onClick={() => setAppearance(option.id)}
              aria-pressed={appearance === option.id}
            >
              <span className="appearance-swatches" aria-hidden="true">
                <i /><i /><i /><i />
              </span>
              <span>
                <strong>{option.name}</strong>
                <small>{option.note}</small>
              </span>
            </button>
          ))}
        </fieldset>
      </form>

      {error && <p className="auth-error">{error}</p>}
      {archiveNotice && <p className="list-notice">{archiveNotice}</p>}

      <div className="canvas-grid">
        {canvases.length === 0 && (
          <div className="list-empty">
            <strong>Nothing here yet</strong>
            Name a board above and you'll land straight on it. Double-click
            anywhere on it to write your first card.
          </div>
        )}

        {topLevel.map((canvas, i) => (
          <article
            key={canvas.id}
            className={`canvas-tile appearance-${appearanceOf(canvas)}`}
            style={{ animationDelay: `${Math.min(i, 8) * 32}ms` }}
          >
            <Link
              to={`/c/${canvas.id}`}
              className={`tile-lid ${canvas.has_cover ? "has-cover" : ""}`}
              style={
                canvas.has_cover
                  ? {
                      backgroundImage: `url(/api/canvases/${canvas.id}/cover?v=${canvas.updated_at})`,
                    }
                  : {
                      background:
                        appearanceOf(canvas) === "studio"
                          ? tintGradient(canvas.id)
                          : "var(--appearance-cover)",
                    }
              }
              aria-label={`Open ${canvas.name}`}
            >
              {!canvas.has_cover && (
                <span className="tile-chips">
                  <span className="tile-chip a" />
                  <span className="tile-chip b" />
                  <span className="tile-chip c" />
                </span>
              )}
            </Link>

            {canvas.role === "owner" && (
              <span className="tile-cover-tools">
                <label className="tile-cover-btn" title="Set a cover image">
                  {canvas.has_cover ? "Change cover" : "Add cover"}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) setCover(canvas, file);
                      e.target.value = "";
                    }}
                  />
                </label>
                {canvas.has_cover && (
                  <button
                    className="tile-cover-btn"
                    title="Remove cover"
                    onClick={() => clearCover(canvas)}
                  >
                    ✕
                  </button>
                )}
              </span>
            )}

            <div className="tile-body">
              <Link to={`/c/${canvas.id}`} className="tile-name">
                {canvas.name}
              </Link>
              <span className="tile-meta">
                {canvas.card_count} {canvas.card_count === 1 ? "card" : "cards"}
                {canvas.role !== "owner" && (
                  <span className="role-badge">
                    {canvas.role === "editor" ? "can edit" : "view only"}
                  </span>
                )}
              </span>
            </div>

            <div className="tile-actions">
              {canvas.role === "owner" ? (
                <>
                  <button onClick={() => setSharing(canvas)}>Share</button>
                  <button onClick={() => renameCanvas(canvas)}>Rename</button>
                  <button
                    disabled={archiveBusy}
                    onClick={() => void exportOneCanvas(canvas)}
                  >
                    Export
                  </button>
                  <button className="warn" onClick={() => deleteCanvas(canvas)}>
                    Delete
                  </button>
                </>
              ) : (
                <button className="warn" onClick={() => leaveCanvas(canvas)}>
                  Leave
                </button>
              )}
            </div>
          </article>
        ))}
      </div>

      {nested.length > 0 && (
        <>
          <button
            className="nested-toggle"
            onClick={() => setShowNested((v) => !v)}
          >
            {showNested ? "▾" : "▸"} {nested.length} board
            {nested.length === 1 ? "" : "s"} inside others
          </button>
          {showNested && (
            <div className="canvas-grid nested-grid">
              {nested.map((canvas) => (
                <article
                  key={canvas.id}
                  className={`canvas-tile is-nested appearance-${appearanceOf(canvas)}`}
                >
                  <Link
                    to={`/c/${canvas.id}`}
                    className={`tile-lid ${canvas.has_cover ? "has-cover" : ""}`}
                    style={
                      canvas.has_cover
                        ? {
                            backgroundImage: `url(/api/canvases/${canvas.id}/cover?v=${canvas.updated_at})`,
                          }
                        : {
                            background:
                              appearanceOf(canvas) === "studio"
                                ? tintGradient(canvas.id)
                                : "var(--appearance-cover)",
                          }
                    }
                    aria-label={`Open ${canvas.name}`}
                  />
                  <div className="tile-body">
                    <Link to={`/c/${canvas.id}`} className="tile-name">
                      {canvas.name}
                    </Link>
                    <span className="tile-meta">
                      {canvas.card_count}{" "}
                      {canvas.card_count === 1 ? "card" : "cards"}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}

      {sharing && (
        <ShareDialog
          canvasId={sharing.id}
          canvasName={sharing.name}
          onClose={() => setSharing(null)}
        />
      )}
    </div>
  );
}
