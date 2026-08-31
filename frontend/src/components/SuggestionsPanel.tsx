import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Suggestion } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import "./suggestionsPanel.css";

/** A quiet panel on the selected card. Accept or ignore.
 *
 * This attacks the real failure mode of a spatial app, which is cards you
 * forgot you had. Suggestions stay out of the graph until accepted. */
export default function SuggestionsPanel() {
  const selection = useCanvasStore((s) => s.selection);
  const nodes = useCanvasStore((s) => s.nodes);
  const createLink = useCanvasStore((s) => s.createLink);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const node = selection.length === 1 ? nodes.find((n) => n.id === selection[0]) : null;
  const cardId = node?.data.card.id ?? null;

  useEffect(() => {
    setDismissed(new Set());
    if (!cardId) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    api
      .get<Suggestion[]>(`/api/cards/${cardId}/suggestions`)
      .then((s) => {
        if (!cancelled) setSuggestions(s);
      })
      .catch(() => setSuggestions([]));
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  const visible = suggestions.filter((s) => !dismissed.has(s.card.id));
  if (!cardId || visible.length === 0) return null;

  return (
    <aside className="suggestions-panel">
      <div className="suggestions-title">Might be related</div>
      {visible.map((suggestion) => (
        <div key={suggestion.card.id} className="suggestion">
          <span className="suggestion-name">
            {suggestion.card.title ??
              suggestion.card.body?.slice(0, 50) ??
              "Untitled"}
          </span>
          <div className="suggestion-actions">
            <button onClick={() => createLink(cardId, suggestion.card.id)}>Link</button>
            <button
              onClick={() =>
                setDismissed((d) => new Set(d).add(suggestion.card.id))
              }
            >
              Ignore
            </button>
          </div>
        </div>
      ))}
    </aside>
  );
}
