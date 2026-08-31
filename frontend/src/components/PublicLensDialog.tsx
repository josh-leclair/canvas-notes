import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import type {
  CanvasAppearance,
  Link,
  PublicLensSummary,
  PublicLensViewMode,
} from "../api/types";
import type { CardNode } from "../store/canvasStore";
import { confirmDialog } from "../store/dialogStore";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import "./publicLensDialog.css";

interface Props {
  canvasId: string;
  canvasName: string;
  nodes: CardNode[];
  links: Link[];
  selection: string[];
  appearance: CanvasAppearance;
  textSize: number;
  onClose: () => void;
  onNotice: (message: string) => void;
}

function publicUrl(slug: string) {
  return `${window.location.origin}/p/${slug}`;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Plain-HTTP LAN installs often block the modern clipboard API. The
      // selection fallback below still works in those browsing contexts.
    }
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  return copied;
}

function iconFor(type: CardNode["data"]["card"]["type"]): IconName {
  if (type === "text" || type === "link" || type === "youtube") return "note";
  if (type === "image") return "image";
  return type;
}

export default function PublicLensDialog(props: Props) {
  const {
    canvasId, canvasName, nodes, links, selection, appearance, textSize,
    onClose, onNotice,
  } = props;
  const [lenses, setLenses] = useState<PublicLensSummary[]>([]);
  const [editing, setEditing] = useState<PublicLensSummary | null>(null);
  const [title, setTitle] = useState(`${canvasName} lens`);
  const [description, setDescription] = useState("");
  const [viewMode, setViewMode] = useState<PublicLensViewMode>("canvas");
  const [sequence, setSequence] = useState<string[]>(() => [...selection]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const publishIds = viewMode === "presentation" ? sequence : selection;
  const reviewed = useMemo(() => {
    const ids = new Set(publishIds);
    for (const node of nodes) {
      if (node.data.parentId && ids.has(node.data.parentId)) ids.add(node.id);
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const ordered = publishIds.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
    const orderedIds = new Set(ordered.map((node) => node.id));
    return [
      ...ordered,
      ...nodes.filter((node) => ids.has(node.id) && !orderedIds.has(node.id)),
    ];
  }, [nodes, publishIds]);
  const cardIds = useMemo(() => new Set(reviewed.map((node) => node.data.card.id)), [reviewed]);
  const includedLinks = links.filter(
    (link) =>
      !!link.source_card_id &&
      !!link.target_card_id &&
      cardIds.has(link.source_card_id) &&
      cardIds.has(link.target_card_id)
  );

  async function refresh() {
    setLenses(await api.get<PublicLensSummary[]>(`/api/public-lenses?canvas_id=${canvasId}`));
  }

  useEffect(() => {
    void refresh().catch(() => setError("Could not load existing public lenses."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId]);

  function choose(lens: PublicLensSummary | null) {
    setEditing(lens);
    setTitle(lens?.title ?? `${canvasName} lens`);
    setDescription(lens?.description ?? "");
    setViewMode(lens?.view_mode ?? "canvas");
    setSequence([...selection]);
    setError("");
  }

  async function publish(event: FormEvent) {
    event.preventDefault();
    if (!publishIds.length) {
      setError("Select at least one card before publishing.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = {
        canvas_id: canvasId,
        placement_ids: publishIds,
        title: title.trim(),
        description: description.trim() || null,
        view_mode: viewMode,
        appearance,
        text_size: textSize,
      };
      const lens = editing
        ? await api.put<PublicLensSummary>(`/api/public-lenses/${editing.id}`, body)
        : await api.post<PublicLensSummary>("/api/public-lenses", body);
      const copied = await copyText(publicUrl(lens.slug));
      if (copied) {
        onNotice(`${editing ? "Updated" : "Published"} public lens — link copied`);
        onClose();
      } else {
        setEditing(lens);
        setError("Published successfully, but this browser blocked copying. Use Open below to reach the public page.");
        await refresh();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not publish this lens.");
    } finally {
      setBusy(false);
    }
  }

  function moveSlide(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= sequence.length) return;
    setSequence((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function copy(lens: PublicLensSummary) {
    const copied = await copyText(publicUrl(lens.slug));
    onNotice(copied ? "Public link copied" : "This browser blocked clipboard access");
  }

  async function revoke(lens: PublicLensSummary) {
    const ok = await confirmDialog({
      title: `Revoke “${lens.title}”?`,
      body: "Its public URL will stop working immediately. You can publish it again later from a fresh selection.",
      confirmLabel: "Revoke link",
      danger: true,
    });
    if (!ok) return;
    await api.delete(`/api/public-lenses/${lens.id}`);
    if (editing?.id === lens.id) choose(null);
    await refresh();
  }

  async function remove(lens: PublicLensSummary) {
    const ok = await confirmDialog({
      title: `Remove “${lens.title}” permanently?`,
      body: lens.revoked_at
        ? "This removes the listing and every copied media revision. Your original cards will not be deleted."
        : "This stops public sharing immediately, then removes the listing and every copied media revision. Your original cards will not be deleted.",
      confirmLabel: "Remove public lens",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/public-lenses/${lens.id}/permanent`);
      if (editing?.id === lens.id) choose(null);
      setLenses((current) => current.filter((item) => item.id !== lens.id));
      onNotice("Public lens permanently removed");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove this public lens.");
    }
  }

  return (
    <div className="lens-dialog-overlay" onPointerDown={onClose}>
      <section className="lens-dialog" onPointerDown={(event) => event.stopPropagation()}>
        <header className="lens-dialog-header">
          <div>
            <strong>{editing ? "Update public lens" : "Publish a public lens"}</strong>
            <p>A frozen, read-only view. Later canvas edits stay private until you update it.</p>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>

        <form onSubmit={publish} className="lens-dialog-form">
          <label>
            Public title
            <input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            Description <span>optional</span>
            <textarea value={description} maxLength={1000} rows={2} onChange={(event) => setDescription(event.target.value)} />
          </label>

          <fieldset className="lens-mode-choices">
            <legend>View</legend>
            <button
              type="button"
              className={viewMode === "canvas" ? "is-selected" : ""}
              onClick={() => setViewMode("canvas")}
              aria-pressed={viewMode === "canvas"}
            >
              <strong>Canvas</strong>
              <small>Explore the original spatial arrangement</small>
            </button>
            <button
              type="button"
              className={viewMode === "presentation" ? "is-selected" : ""}
              onClick={() => setViewMode("presentation")}
              aria-pressed={viewMode === "presentation"}
            >
              <strong>Guided pages</strong>
              <small>Scroll through cards in a chosen order</small>
            </button>
          </fieldset>

          <div className="lens-review">
            <div className="lens-review-heading">
              <strong>Exposure review</strong>
              <span>{reviewed.length} card{reviewed.length === 1 ? "" : "s"} · up to {includedLinks.length} internal link{includedLinks.length === 1 ? "" : "s"}</span>
            </div>
            {reviewed.length ? (
              <ul>
                {reviewed.map((node) => {
                  const slideIndex = sequence.indexOf(node.id);
                  return (
                  <li key={node.id}>
                    <Icon name={iconFor(node.data.card.type)} />
                    <span>{node.data.card.title || node.data.card.body?.slice(0, 70) || `Untitled ${node.data.card.type}`}</span>
                    <small>{node.data.card.type}</small>
                    {viewMode === "presentation" && slideIndex >= 0 && (
                      <span className="lens-slide-order">
                        <button type="button" onClick={() => moveSlide(slideIndex, -1)} disabled={slideIndex === 0} aria-label={`Move slide ${slideIndex + 1} earlier`}>↑</button>
                        <button type="button" onClick={() => moveSlide(slideIndex, 1)} disabled={slideIndex === sequence.length - 1} aria-label={`Move slide ${slideIndex + 1} later`}>↓</button>
                      </span>
                    )}
                  </li>
                  );
                })}
              </ul>
            ) : (
              <p className="lens-review-empty">Nothing selected. You can still manage existing links below.</p>
            )}
            <p className="lens-boundary-note">References and links leaving this selection are removed. Collaborator-created links are excluded. Media is copied into this frozen revision.</p>
          </div>
          {error && <p className="lens-dialog-error">{error}</p>}
          <div className="lens-dialog-actions">
            {editing && <button type="button" onClick={() => choose(null)}>New lens</button>}
            <button className="primary" disabled={busy || !publishIds.length}>
              {busy ? "Publishing…" : editing ? `Update revision ${editing.revision + 1}` : "Publish and copy link"}
            </button>
          </div>
        </form>

        {!!lenses.length && (
          <div className="lens-existing">
            <strong>Published from this canvas</strong>
            {lenses.map((lens) => (
              <div className="lens-existing-row" key={lens.id}>
                <button className="lens-existing-name" onClick={() => choose(lens)}>
                  <span>{lens.title}</span>
                  <small>{lens.card_count} cards · {lens.view_mode === "presentation" ? "guided pages" : "canvas"} · revision {lens.revision}{lens.revoked_at ? " · revoked" : ""}</small>
                </button>
                {!lens.revoked_at && <button onClick={() => void copy(lens)}>Copy</button>}
                {!lens.revoked_at && <a href={`/p/${lens.slug}`} target="_blank" rel="noreferrer">Open</a>}
                {!lens.revoked_at && <button onClick={() => void revoke(lens)}>Revoke</button>}
                <button className="lens-remove" onClick={() => void remove(lens)}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
