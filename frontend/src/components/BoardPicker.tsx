import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { CanvasSummary } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import { tintGradient } from "../lib/tint";
import "./boardPicker.css";

/** Put an existing card onto another board.
 *
 * This is how one card — a board tile included — comes to appear in several
 * places at once. The card is shared, not copied: edit it anywhere and it
 * changes everywhere, which is the whole point of placements being separate
 * from cards. */
export default function BoardPicker() {
  const request = useCanvasStore((s) => s.placeOnBoardFor);
  const close = useCanvasStore((s) => s.setPlaceOnBoardFor);
  const showToast = useCanvasStore((s) => s.showToast);
  const canvasId = useCanvasStore((s) => s.canvasId);

  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [already, setAlready] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    setQuery("");
    Promise.all([
      api.get<CanvasSummary[]>("/api/canvases"),
      api.get<{ canvas_id: string }[]>(`/api/cards/${request.cardId}/placements`),
    ]).then(([all, placements]) => {
      setCanvases(all);
      setAlready(new Set(placements.map((p) => p.canvas_id)));
    });
  }, [request]);

  if (!request) return null;

  const visible = canvases.filter(
    (c) =>
      c.role !== "viewer" &&
      c.id !== canvasId &&
      c.name.toLowerCase().includes(query.trim().toLowerCase())
  );

  async function place(canvas: CanvasSummary) {
    setBusy(canvas.id);
    try {
      await api.post(`/api/canvases/${canvas.id}/placements`, {
        card_id: request!.cardId,
        x: 80,
        y: 80,
      });
      setAlready((s) => new Set(s).add(canvas.id));
      showToast(`Also on “${canvas.name}”`);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not place it there");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="picker-overlay" onClick={() => close(null)}>
      <div className="board-picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <strong>Place “{request.title ?? "card"}” on another board</strong>
          <button className="ghost" onClick={() => close(null)}>
            ✕
          </button>
        </div>
        <p className="picker-note">
          The same card, in both places. Editing it anywhere changes it
          everywhere.
        </p>
        <input
          autoFocus
          placeholder="Find a board…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="picker-list">
          {visible.length === 0 && (
            <p className="picker-empty">No other boards you can edit.</p>
          )}
          {visible.map((canvas) => {
            const there = already.has(canvas.id);
            return (
              <button
                key={canvas.id}
                className="picker-row"
                disabled={there || busy === canvas.id}
                onClick={() => place(canvas)}
              >
                <span
                  className="picker-chip"
                  style={
                    canvas.has_cover
                      ? {
                          backgroundImage: `url(/api/canvases/${canvas.id}/cover)`,
                        }
                      : { background: tintGradient(canvas.id) }
                  }
                />
                <span className="picker-name">{canvas.name}</span>
                <span className="picker-state">
                  {there ? "already there" : busy === canvas.id ? "…" : "add"}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
