import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { api } from "../api/client";
import type { Card } from "../api/types";
import {
  SMART_CAPTURE_PLACE_EVENT,
  captureDraftsFromFiles,
  captureDraftsFromText,
  captureTypeIcon,
  captureTypeLabel,
  duplicateForDraft,
  type CaptureDraft,
  type CaptureDraftType,
  type SmartCapturePlaceDetail,
} from "../lib/smartCapture";
import { URL_PATTERN } from "../lib/urls";
import { useCanvasStore } from "../store/canvasStore";
import Icon from "./Icon";

const TEXT_TYPES: CaptureDraftType[] = ["text", "document", "checklist", "link", "youtube"];
const FILE_TYPES: CaptureDraftType[] = ["image", "audio", "file"];

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function cleanListLine(value: string): string {
  return value.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ xX]\])\s+/, "").trim();
}

async function createCapturedCard(
  draft: CaptureDraft,
  inboxCanvasId: string | null
): Promise<Card> {
  let body: string | null = draft.body.trim() || null;
  let payload: Record<string, unknown> = {};

  if (draft.type === "link" || draft.type === "youtube") {
    const url = draft.body.trim();
    if (!URL_PATTERN.test(url)) throw new Error("Enter one complete http or https URL");
    payload = { url };
    body = null;
  } else if (draft.type === "checklist") {
    const items = draft.body
      .split("\n")
      .map(cleanListLine)
      .filter(Boolean)
      .map((text) => ({ text, done: false }));
    if (items.length === 0) throw new Error("Add at least one to-do item");
    payload = { items };
    body = null;
  }

  const created = await api.post<{ card: Card }>("/api/cards", {
    type: draft.type,
    title: draft.title.trim() || (draft.file?.name ?? null),
    body,
    payload,
    inbox_canvas_id: inboxCanvasId,
  });

  if (!draft.file) return created.card;
  const form = new FormData();
  form.append("file", draft.file);
  const upload = await fetch(`/api/cards/${created.card.id}/${draft.type}`, {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  if (!upload.ok) {
    await api.delete(`/api/cards/${created.card.id}`).catch(() => undefined);
    const data = await upload.json().catch(() => null);
    throw new Error(data?.error?.message ?? `Could not upload ${draft.file.name}`);
  }
  return await upload.json() as Card;
}

export default function SmartCapture({
  canvasId,
  canvasName,
  existingCards,
}: {
  canvasId: string;
  canvasName: string;
  existingCards: Card[];
}) {
  const loadInbox = useCanvasStore((state) => state.loadInbox);
  const setInboxOpen = useCanvasStore((state) => state.setInboxOpen);
  const showToast = useCanvasStore((state) => state.showToast);
  const [composerOpen, setComposerOpen] = useState(false);
  const [drafts, setDrafts] = useState<CaptureDraft[]>([]);
  const [text, setText] = useState("");
  const [destination, setDestination] = useState<"board" | "general">("board");
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (composerOpen && drafts.length === 0) textRef.current?.focus();
  }, [composerOpen, drafts.length]);

  const duplicateIds = useMemo(() => new Set(
    drafts
      .filter((draft) => duplicateForDraft(draft, existingCards))
      .map((draft) => draft.id)
  ), [drafts, existingCards]);

  function addDrafts(next: CaptureDraft[]) {
    if (next.length === 0) return;
    setComposerOpen(true);
    setDrafts((current) => [...current, ...next]);
    setErrors({});
  }

  function addText() {
    const next = captureDraftsFromText(text);
    if (next.length === 0) return;
    addDrafts(next);
    setText("");
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = captureDraftsFromFiles(event.clipboardData.files);
    const pasted = event.clipboardData.getData("text/uri-list") || event.clipboardData.getData("text/plain");
    if (files.length === 0 && !pasted.trim()) return;
    event.preventDefault();
    addDrafts(files.length > 0 ? files : captureDraftsFromText(pasted));
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    const files = captureDraftsFromFiles(event.dataTransfer.files);
    const dropped = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    addDrafts(files.length > 0 ? files : captureDraftsFromText(dropped));
  }

  function patchDraft(id: string, patch: Partial<CaptureDraft>) {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...patch } : draft));
    setErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function save(action: "inbox" | "place" | "organize") {
    if (saving || drafts.length === 0) return;
    setSaving(true);
    setErrors({});
    const created: Card[] = [];
    const failed: CaptureDraft[] = [];
    const nextErrors: Record<string, string> = {};
    const inboxCanvasId = destination === "board" ? canvasId : null;

    for (const draft of drafts) {
      try {
        created.push(await createCapturedCard(draft, inboxCanvasId));
      } catch (error) {
        failed.push(draft);
        nextErrors[draft.id] = error instanceof Error ? error.message : "Could not capture this item";
      }
    }

    await loadInbox().catch(() => undefined);
    setSaving(false);
    setErrors(nextErrors);
    setDrafts(failed);

    if (created.length > 0 && action !== "inbox") {
      window.dispatchEvent(new CustomEvent<SmartCapturePlaceDetail>(
        SMART_CAPTURE_PLACE_EVENT,
        { detail: { cardIds: created.map((card) => card.id), organize: action === "organize" } }
      ));
      setInboxOpen(false);
    }

    if (failed.length === 0) {
      setComposerOpen(false);
      setText("");
      showToast(
        action === "inbox"
          ? `Captured ${created.length} item${created.length === 1 ? "" : "s"} to ${destination === "board" ? `${canvasName} inbox` : "General inbox"}`
          : action === "organize"
            ? `Added ${created.length} item${created.length === 1 ? "" : "s"} — choose a layout`
            : `Placed ${created.length} captured item${created.length === 1 ? "" : "s"}`
      );
    } else if (created.length > 0) {
      showToast(`Captured ${created.length}; ${failed.length} need attention`);
    }
  }

  const duplicateCount = duplicateIds.size;

  return (
    <section
      className={`smart-capture ${composerOpen ? "is-open" : ""} ${dragging ? "is-dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      {!composerOpen ? (
        <button className="smart-capture-launch" type="button" onClick={() => setComposerOpen(true)}>
          <span className="smart-capture-mark"><Icon name="sparkles" /></span>
          <span>
            <strong>Capture anything</strong>
            <small>Paste or drop links, text, images, audio, and files</small>
          </span>
        </button>
      ) : (
        <>
          <div className="smart-capture-heading">
            <span>
              <strong>Smart capture</strong>
              <small>{drafts.length ? `${drafts.length} item${drafts.length === 1 ? "" : "s"} ready to review` : "Paste, type, or choose files"}</small>
            </span>
            <button
              type="button"
              aria-label="Close smart capture"
              disabled={saving}
              onClick={() => {
                setComposerOpen(false);
                setDrafts([]);
                setText("");
                setErrors({});
              }}
            ><Icon name="close" /></button>
          </div>

          <div className="smart-capture-input">
            <textarea
              ref={textRef}
              value={text}
              disabled={saving}
              placeholder="Write a note, paste a URL, or paste a bulleted list…"
              onChange={(event) => setText(event.target.value)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") addText();
              }}
            />
            <div>
              <button type="button" disabled={!text.trim() || saving} onClick={addText}>Add text</button>
              <button type="button" disabled={saving} onClick={() => fileRef.current?.click()}>
                <Icon name="file" /> Choose files
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                onChange={(event) => {
                  if (event.target.files) addDrafts(captureDraftsFromFiles(event.target.files));
                  event.target.value = "";
                }}
              />
            </div>
          </div>

          {dragging && <div className="smart-capture-drop-message">Drop to add to this batch</div>}

          {drafts.length > 0 && (
            <div className="smart-capture-review" aria-label="Capture review">
              {drafts.map((draft) => {
                const options = draft.file ? FILE_TYPES : TEXT_TYPES;
                const duplicate = duplicateForDraft(draft, existingCards);
                return (
                  <article className={`smart-capture-item ${duplicate ? "is-duplicate" : ""}`} key={draft.id}>
                    <div className="smart-capture-item-head">
                      <span className="smart-capture-type-icon"><Icon name={captureTypeIcon(draft.type)} /></span>
                      <select
                        value={draft.type}
                        disabled={saving}
                        aria-label="Detected card type"
                        onChange={(event) => patchDraft(draft.id, { type: event.target.value as CaptureDraftType })}
                      >
                        {options.map((type) => <option value={type} key={type}>{captureTypeLabel(type)}</option>)}
                      </select>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label={`Remove ${draft.title || captureTypeLabel(draft.type)} from batch`}
                        onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}
                      ><Icon name="close" /></button>
                    </div>
                    <input
                      value={draft.title}
                      disabled={saving}
                      aria-label="Card title"
                      placeholder={draft.file ? draft.file.name : "Title (optional)"}
                      onChange={(event) => patchDraft(draft.id, { title: event.target.value })}
                    />
                    {!draft.file && (
                      <textarea
                        value={draft.body}
                        disabled={saving}
                        aria-label="Card content"
                        placeholder={draft.type === "checklist" ? "One task per line" : draft.type === "link" || draft.type === "youtube" ? "https://…" : "Card content"}
                        onChange={(event) => patchDraft(draft.id, { body: event.target.value })}
                      />
                    )}
                    {draft.file && <small className="smart-capture-file-meta">{draft.file.type || "Unknown file type"} · {fileSize(draft.file.size)}</small>}
                    {duplicate && <small className="smart-capture-warning">Possible duplicate of “{duplicate.title ?? duplicate.body?.slice(0, 42) ?? "untitled card"}”</small>}
                    {errors[draft.id] && <small className="smart-capture-error">{errors[draft.id]}</small>}
                  </article>
                );
              })}
            </div>
          )}

          {drafts.length > 0 && (
            <>
              <div className="smart-capture-destination" role="group" aria-label="Inbox destination">
                <button type="button" className={destination === "board" ? "is-active" : ""} onClick={() => setDestination("board")} disabled={saving}>{canvasName}</button>
                <button type="button" className={destination === "general" ? "is-active" : ""} onClick={() => setDestination("general")} disabled={saving}>General</button>
              </div>
              {duplicateCount > 0 && <p className="smart-capture-duplicate-summary">{duplicateCount} possible duplicate{duplicateCount === 1 ? "" : "s"}; review before saving.</p>}
              <div className="smart-capture-actions">
                <button type="button" disabled={saving} onClick={() => void save("inbox")}>
                  {saving ? "Saving…" : "Save to inbox"}
                </button>
                <button type="button" disabled={saving} onClick={() => void save("place")}>Place here</button>
                {drafts.length >= 2 && (
                  <button className="primary" type="button" disabled={saving} onClick={() => void save("organize")}>
                    <Icon name="sparkles" /> Place & organize
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
