import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Card } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import type { Editor } from "@tiptap/react";
import Icon from "./Icon";
import RichTextEditor from "./RichTextEditor";
import TextStyleMenu from "./TextStyleMenu";
import DocumentToolbar from "./DocumentToolbar";
import CardReferencePicker from "./CardReferencePicker";
import { useOpenCard } from "../hooks/useOpenCard";
import "./documentEditor.css";

interface LivingSource {
  card_id: string;
  title?: string | null;
  updated_at?: string;
}

interface LivingBlock {
  id: string;
  generated_markdown?: string;
  source_card_ids: string[];
  source_versions?: Record<string, string>;
}

interface LivingDocument {
  version?: number;
  sources: LivingSource[];
  blocks: LivingBlock[];
  last_refresh?: { refreshed_blocks?: number; preserved_blocks?: number };
}

function markdownBlocks(markdown: string) {
  return markdown.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
}

function preview(markdown: string) {
  return markdown
    .replace(/^#{1,6}\s+/, "")
    .replace(/[*_`>[\]()#-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
}

function sameMoment(a?: string, b?: string) {
  if (!a || !b) return true;
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

/** A full-height surface for writing something longer than a card.
 *
 * The card body is still markdown — a document is a text card that has said
 * it wants room, not a different kind of data — so everything that reads a
 * body keeps working: search, embeddings, the split, export. What went away
 * is typing it: the toolbar used to push `**` and `##` into the text, so the
 * syntax was something you read while writing rather than a storage format.
 *
 * It opens over the canvas rather than editing in place. A 280px node is the
 * wrong shape for prose, and putting a real editor inside one means fighting
 * the node for the pointer, the wheel and the keyboard, which this app has
 * lost enough times already.
 */
export default function DocumentEditor({
  card,
  onClose,
}: {
  card: Card;
  onClose: () => void;
}) {
  const updateCard = useCanvasStore((s) => s.updateCard);
  const refreshComposition = useCanvasStore((s) => s.refreshComposition);
  const focusCards = useCanvasStore((s) => s.focusCards);
  const showToast = useCanvasStore((s) => s.showToast);
  const nodes = useCanvasStore((s) => s.nodes);
  const generationAvailable = useCanvasStore((s) => s.generationAvailable);
  const [title, setTitle] = useState(card.title ?? "");
  const [body, setBody] = useState(card.body ?? "");
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [includeCitations, setIncludeCitations] = useState(false);
  const [exporting, setExporting] = useState<"markdown" | "docx" | "pdf" | null>(
    null
  );
  const [referenceRange, setReferenceRange] = useState<{
    from: number;
    to: number;
  } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const titleRef = useRef<HTMLInputElement>(null);
  const openCard = useOpenCard();
  const newDocument = useRef(!card.title?.trim() && !card.body?.trim()).current;

  useEffect(() => {
    if (newDocument) titleRef.current?.focus();
  }, [newDocument]);

  // Written back a moment after typing stops. Long documents are not worth a
  // request per keystroke, and closing flushes whatever is outstanding.
  useEffect(() => {
    if (title === (card.title ?? "") && body === (card.body ?? "")) return;
    setSaved("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      await updateCard(card.id, { title: title.trim() || null, body });
      setSaved("saved");
    }, 600);
    return () => window.clearTimeout(timer.current);
  }, [title, body, card.id, card.title, card.body, updateCard]);

  async function close() {
    window.clearTimeout(timer.current);
    if (title !== (card.title ?? "") || body !== (card.body ?? "")) {
      await updateCard(card.id, { title: title.trim() || null, body });
    }
    onClose();
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (exportOpen) {
          e.stopPropagation();
          setExportOpen(false);
          return;
        }
        if (
          (e.target as Element | null)?.closest?.(
            ".doc-link-dialog, .card-reference-dialog"
          )
        )
          return;
        e.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const living = card.payload.living_document as LivingDocument | undefined;
  const generated = card.payload.generated_by as
    | { source_card_ids?: string[] }
    | undefined;
  const legacyIds = generated?.source_card_ids ?? [];
  const legacyComposition = !living && legacyIds.length > 0;
  const sources: LivingSource[] =
    living?.sources?.length
      ? living.sources
      : legacyIds.map((card_id) => ({ card_id }));
  const sourceIds = sources.map((source) => source.card_id);
  const currentById = new Map(nodes.map((node) => [node.data.card.id, node.data.card]));
  const sourceById = new Map(sources.map((source) => [source.card_id, source]));
  const currentBlocks = markdownBlocks(body);
  const provenanceBlocks: LivingBlock[] =
    living?.blocks?.length
      ? living.blocks
      : sourceIds.length
        ? [{ id: "legacy", source_card_ids: sourceIds }]
        : [];
  const blockIsStale = (block: LivingBlock) =>
    block.source_card_ids.some((sourceId) => {
      const expected = block.source_versions?.[sourceId];
      const current = currentById.get(sourceId);
      return Boolean(expected && current && !sameMoment(expected, current.updated_at));
    });
  const staleBlocks = provenanceBlocks.filter(blockIsStale).length;

  async function revealSources(cardIds: string[]) {
    await close();
    focusCards(cardIds);
  }

  async function refreshFromSources() {
    if (refreshing) return;
    setRefreshing(true);
    window.clearTimeout(timer.current);
    try {
      if (title !== (card.title ?? "") || body !== (card.body ?? "")) {
        await updateCard(card.id, { title: title.trim() || null, body });
      }
      const updated = await refreshComposition(card.id);
      if (updated) {
        setTitle(updated.title ?? "");
        setBody(updated.body ?? "");
        setSaved("saved");
      }
    } finally {
      setRefreshing(false);
    }
  }

  function insertReference(target: Card) {
    if (!editor || !referenceRange) return;
    const label = target.title ?? "Untitled";
    const range = referenceRange;
    editor
      .chain()
      .focus()
      .command(({ tr, dispatch }) => {
        const mark = editor.schema.marks.link.create({ href: `card:${target.id}` });
        dispatch?.(tr.replaceRangeWith(range.from, range.to, editor.schema.text(label, [mark])));
        return true;
      })
      .run();
    setReferenceRange(null);
    void useCanvasStore.getState().touchCard(target.id);
  }

  async function openReferencedCard(cardId: string) {
    await close();
    await openCard(cardId);
  }

  async function exportAs(format: "markdown" | "docx" | "pdf") {
    if (exporting) return;
    setExporting(format);
    window.clearTimeout(timer.current);
    try {
      if (title !== (card.title ?? "") || body !== (card.body ?? "")) {
        await updateCard(card.id, { title: title.trim() || null, body });
        setSaved("saved");
      }
      const params = new URLSearchParams({
        format,
        include_citations: String(includeCitations),
      });
      const response = await fetch(`/api/cards/${card.id}/export?${params}`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error?.message ?? "Could not export the document");
      }
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const extension = format === "markdown" ? "md" : format;
      const filename = encodedName
        ? decodeURIComponent(encodedName)
        : `${title.trim() || "Untitled document"}.${extension}`;
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setExportOpen(false);
      showToast(`Exported ${filename}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not export the document");
    } finally {
      setExporting(null);
    }
  }

  return createPortal(
    <div className="doc-backdrop" onPointerDown={close}>
      <div className="doc-sheet" onPointerDown={(e) => e.stopPropagation()}>
        <header className="doc-head">
          <input
            ref={titleRef}
            className="doc-title"
            value={title}
            placeholder="Untitled"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              editor?.commands.focus("start");
            }}
          />
          <div className="doc-actions">
            <span className="doc-status">
              {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved" : ""}
            </span>
            <div className="doc-export">
              <button
                type="button"
                aria-expanded={exportOpen}
                onClick={() => setExportOpen((open) => !open)}
              >
                <Icon name="download" /> Export
              </button>
              {exportOpen && (
                <div className="doc-export-menu">
                  <label>
                    <input
                      type="checkbox"
                      checked={includeCitations}
                      onChange={(event) => setIncludeCitations(event.target.checked)}
                    />
                    <span>
                      Include cited cards
                      <small>Append the text of directly cited cards.</small>
                    </span>
                  </label>
                  <div className="doc-export-formats">
                    {(["markdown", "docx", "pdf"] as const).map((format) => (
                      <button
                        key={format}
                        type="button"
                        disabled={exporting !== null}
                        onClick={() => void exportAs(format)}
                      >
                        {exporting === format
                          ? "Exporting…"
                          : format === "markdown"
                            ? "Markdown"
                            : format.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button onClick={close} title="Close (Esc)">
              <Icon name="close" />
            </button>
          </div>
        </header>

        <div className="doc-stage">
          <aside className="doc-rail">
            <TextStyleMenu editor={editor} />
            <DocumentToolbar
              editor={editor}
              onReference={() => {
                if (!editor) return;
                setReferenceRange({
                  from: editor.state.selection.from,
                  to: editor.state.selection.to,
                });
              }}
            />
          </aside>
          <RichTextEditor
            value={body}
            onChange={setBody}
            onReady={setEditor}
            onReferenceTrigger={setReferenceRange}
            onOpenReference={(cardId) => void openReferencedCard(cardId)}
            placeholder="Write, or paste something long in…"
            autoFocus={!newDocument}
          />
          {sources.length > 0 && (
            <aside className="doc-source-rail">
              <div className="doc-source-head">
                <div>
                  <strong>Sources</strong>
                  <span>
                    {sources.length} card{sources.length === 1 ? "" : "s"}
                  </span>
                </div>
                {generationAvailable && (
                  <button
                    type="button"
                    onClick={refreshFromSources}
                    disabled={refreshing}
                    title="Refresh untouched blocks from changed source cards"
                  >
                    {refreshing
                      ? "Refreshing…"
                      : legacyComposition
                        ? "Add provenance"
                        : staleBlocks
                          ? "Refresh changed"
                          : "Refresh"}
                  </button>
                )}
              </div>
              {staleBlocks > 0 && (
                <p className="doc-stale-summary">
                  {staleBlocks} block{staleBlocks === 1 ? " is" : "s are"} out of date.
                  Edited blocks will be preserved.
                </p>
              )}
              {legacyComposition && (
                <p className="doc-provenance-summary">
                  This draft predates block-level sources. Add provenance without
                  rewriting its existing text.
                </p>
              )}
              <div className="doc-source-blocks">
                {provenanceBlocks.map((block, index) => {
                  const stale = blockIsStale(block);
                  const text = currentBlocks[index] ?? block.generated_markdown ?? "Document";
                  return (
                    <div
                      key={block.id || index}
                      className={`doc-source-block ${stale ? "is-stale" : ""}`}
                    >
                      <div className="doc-source-excerpt">
                        {stale && <span className="doc-stale-dot" title="Source changed" />}
                        {preview(text) || `Block ${index + 1}`}
                      </div>
                      <div className="doc-source-chips">
                        {block.source_card_ids.map((sourceId) => {
                          const current = currentById.get(sourceId);
                          const snapshot = sourceById.get(sourceId);
                          const changed = Boolean(
                            block.source_versions?.[sourceId] &&
                              current &&
                              !sameMoment(
                                block.source_versions?.[sourceId],
                                current.updated_at
                              )
                          );
                          return (
                            <button
                              key={sourceId}
                              type="button"
                              className={changed ? "is-stale" : ""}
                              onClick={() => revealSources([sourceId])}
                              title="Close the document and reveal this source card"
                            >
                              {current?.title || snapshot?.title || "Missing source"}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                className="doc-reveal-all"
                onClick={() => revealSources(sourceIds)}
              >
                Reveal all source cards
              </button>
            </aside>
          )}
        </div>

        <footer className="doc-foot">
          {words} word{words === 1 ? "" : "s"}
        </footer>
        {referenceRange && (
          <CardReferencePicker
            sourceCardId={card.id}
            nearby={nodes.map((node) => node.data.card)}
            onPick={insertReference}
            onClose={() => {
              setReferenceRange(null);
              editor?.commands.focus();
            }}
          />
        )}
      </div>
    </div>,
    document.body
  );
}
