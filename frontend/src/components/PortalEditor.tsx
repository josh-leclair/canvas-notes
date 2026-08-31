import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import type { CanvasSummary, CardType, PortalConfig } from "../api/types";
import Icon from "./Icon";
import "./portalCard.css";

const FILTER_TYPES: { value: CardType | "any"; label: string }[] = [
  { value: "any", label: "Any card type" },
  { value: "text", label: "Notes" },
  { value: "document", label: "Documents" },
  { value: "checklist", label: "To-dos" },
  { value: "table", label: "Tables" },
  { value: "link", label: "Links" },
  { value: "image", label: "Images" },
  { value: "audio", label: "Audio" },
  { value: "file", label: "Files" },
  { value: "board", label: "Boards" },
];

export const defaultPortalConfig = (canvasId?: string): PortalConfig => ({
  scope: canvasId ? "canvas" : "workspace",
  ...(canvasId ? { canvas_id: canvasId } : {}),
  query: "",
  card_type: "any",
  open_tasks: false,
  timeframe: "any",
  timezone_offset_minutes: new Date().getTimezoneOffset(),
  limit: 20,
});

export function portalConfigOf(payload: Record<string, unknown>): PortalConfig {
  const scope = payload.scope === "canvas" ? "canvas" : "workspace";
  const cardType = FILTER_TYPES.some((item) => item.value === payload.card_type)
    ? (payload.card_type as CardType | "any")
    : "any";
  return {
    scope,
    ...(scope === "canvas" && typeof payload.canvas_id === "string"
      ? { canvas_id: payload.canvas_id }
      : {}),
    query: typeof payload.query === "string" ? payload.query : "",
    card_type: cardType,
    open_tasks: payload.open_tasks === true,
    timeframe: payload.timeframe === "today" ? "today" : "any",
    timezone_offset_minutes:
      typeof payload.timezone_offset_minutes === "number"
        ? payload.timezone_offset_minutes
        : new Date().getTimezoneOffset(),
    limit: 20,
  };
}

export default function PortalEditor({
  initial,
  initialTitle,
  currentCanvasId,
  onSave,
  onClose,
}: {
  initial?: PortalConfig;
  initialTitle?: string | null;
  currentCanvasId?: string;
  onSave: (title: string, config: PortalConfig) => void | Promise<void>;
  onClose: () => void;
}) {
  const seed = initial ?? defaultPortalConfig(currentCanvasId);
  const [title, setTitle] = useState(initialTitle ?? "Portal");
  const [scope, setScope] = useState<PortalConfig["scope"]>(seed.scope);
  const [canvasId, setCanvasId] = useState(seed.canvas_id ?? currentCanvasId ?? "");
  const [query, setQuery] = useState(seed.query);
  const [cardType, setCardType] = useState<PortalConfig["card_type"]>(seed.card_type);
  const [openTasks, setOpenTasks] = useState(seed.open_tasks);
  const [timeframe, setTimeframe] = useState<PortalConfig["timeframe"]>(seed.timeframe);
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<CanvasSummary[]>("/api/canvases").then(setCanvases).catch(() => setCanvases([]));
  }, []);

  useEffect(() => {
    if (scope === "canvas" && !canvasId && canvases[0]) setCanvasId(canvases[0].id);
  }, [scope, canvasId, canvases]);

  const sourceName = useMemo(
    () => canvases.find((canvas) => canvas.id === canvasId)?.name ?? "a canvas",
    [canvases, canvasId]
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (scope === "canvas" && !canvasId) return;
    setSaving(true);
    try {
      await onSave(title.trim() || "Portal", {
        scope,
        ...(scope === "canvas" ? { canvas_id: canvasId } : {}),
        query: query.trim(),
        card_type: cardType,
        open_tasks: openTasks,
        timeframe,
        timezone_offset_minutes: new Date().getTimezoneOffset(),
        limit: 20,
      });
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="portal-editor-backdrop" onPointerDown={onClose}>
      <form
        className="portal-editor"
        onSubmit={submit}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="portal-editor-mark"><Icon name="portal" /></div>
          <div>
            <strong>{initial ? "Edit portal" : "New portal"}</strong>
            <span>A live view of canonical cards—never copies.</span>
          </div>
          <button type="button" className="portal-icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <label>
          <span>Name</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        </label>

        {!initial && (
          <fieldset>
            <legend>Start with</legend>
            <div className="portal-preset-choice">
              <button
                type="button"
                className={timeframe === "today" ? "is-active" : ""}
                onClick={() => {
                  setTitle("Today");
                  setScope(currentCanvasId ? "canvas" : "workspace");
                  if (currentCanvasId) setCanvasId(currentCanvasId);
                  setTimeframe("today");
                  setQuery("");
                  setCardType("any");
                  setOpenTasks(false);
                }}
              >
                <Icon name="note" />
                <span><strong>Today</strong><small>Cards changed today</small></span>
              </button>
              <button
                type="button"
                className={timeframe === "any" ? "is-active" : ""}
                onClick={() => setTimeframe("any")}
              >
                <Icon name="portal" />
                <span><strong>Custom</strong><small>Choose your own rules</small></span>
              </button>
            </div>
          </fieldset>
        )}

        <fieldset>
          <legend>Look in</legend>
          <div className="portal-scope-choice">
            <button
              type="button"
              className={scope === "workspace" ? "is-active" : ""}
              onClick={() => setScope("workspace")}
            >
              Whole workspace
            </button>
            <button
              type="button"
              className={scope === "canvas" ? "is-active" : ""}
              onClick={() => setScope("canvas")}
            >
              One canvas
            </button>
          </div>
          {scope === "canvas" && (
            <select value={canvasId} onChange={(event) => setCanvasId(event.target.value)}>
              {canvases.map((canvas) => (
                <option key={canvas.id} value={canvas.id}>{canvas.name}</option>
              ))}
            </select>
          )}
        </fieldset>

        <div className="portal-filter-grid">
          <label>
            <span>Contains</span>
            <input
              value={query}
              placeholder="Any words"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>
            <span>Type</span>
            <select
              value={cardType}
              onChange={(event) => setCardType(event.target.value as PortalConfig["card_type"])}
            >
              {FILTER_TYPES.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="portal-check">
          <input
            type="checkbox"
            checked={openTasks}
            onChange={(event) => setOpenTasks(event.target.checked)}
          />
          <span>Only cards containing an unfinished task</span>
        </label>
        <label className="portal-check">
          <input
            type="checkbox"
            checked={timeframe === "today"}
            onChange={(event) => setTimeframe(event.target.checked ? "today" : "any")}
          />
          <span>Only cards changed today</span>
        </label>

        <p className="portal-rule-preview">
          Showing {cardType === "any" ? "cards" : cardType} from {scope === "workspace" ? "everywhere" : sourceName}
          {query.trim() && <> containing “{query.trim()}”</>}
          {openTasks && <> with something left to do</>}.
          {timeframe === "today" && <> Changed today.</>}
        </p>

        <footer>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={saving || (scope === "canvas" && !canvasId)}>
            {saving ? "Saving…" : initial ? "Update portal" : "Create portal"}
          </button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
