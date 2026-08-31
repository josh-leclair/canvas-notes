import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Card } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import "./linkPicker.css";

/** Search picker for "link to": the only sane path when the target is five
 * screens away or on another canvas. */
export default function LinkPicker() {
  const sourceCardId = useCanvasStore((s) => s.linkPickerFor);
  const setLinkPickerFor = useCanvasStore((s) => s.setLinkPickerFor);
  const createLink = useCanvasStore((s) => s.createLink);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Card[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number>();

  useEffect(() => {
    if (sourceCardId) {
      setQuery("");
      setResults([]);
      inputRef.current?.focus();
    }
  }, [sourceCardId]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      const hits = await api.get<Card[]>(
        `/api/cards/search?q=${encodeURIComponent(query.trim())}`
      );
      setResults(hits.filter((c) => c.id !== sourceCardId));
    }, 200);
    return () => window.clearTimeout(timer.current);
  }, [query, sourceCardId]);

  if (!sourceCardId) return null;

  async function pick(target: Card) {
    await createLink(sourceCardId!, target.id);
    setLinkPickerFor(null);
  }

  return (
    <div className="link-picker-overlay" onClick={() => setLinkPickerFor(null)}>
      <div className="link-picker" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="Link to… search your cards"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setLinkPickerFor(null);
            if (e.key === "Enter" && results.length > 0) pick(results[0]);
          }}
        />
        <div className="link-picker-results">
          {results.map((card) => (
            <button key={card.id} onClick={() => pick(card)}>
              <span className="picker-title">{card.title ?? "Untitled"}</span>
              {card.body && <span className="picker-body">{card.body.slice(0, 80)}</span>}
            </button>
          ))}
          {query.trim() && results.length === 0 && (
            <p className="picker-empty">No matching cards.</p>
          )}
        </div>
      </div>
    </div>
  );
}
