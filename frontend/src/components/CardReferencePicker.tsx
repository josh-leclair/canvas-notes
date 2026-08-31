import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import type { Card } from "../api/types";
import Icon from "./Icon";
import "./cardReference.css";

export default function CardReferencePicker({
  sourceCardId,
  nearby,
  onPick,
  onClose,
}: {
  sourceCardId: string;
  nearby: Card[];
  onPick: (card: Card) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<Card[]>([]);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setRemote([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .get<Card[]>(`/api/cards/search?q=${encodeURIComponent(q)}&limit=20`)
        .then((cards) => {
          if (!cancelled) setRemote(cards);
        })
        .catch(() => {
          if (!cancelled) setRemote([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const results = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    const source = q ? [...remote, ...nearby] : nearby;
    const seen = new Set<string>();
    return source
      .filter((card) => {
        if (card.id === sourceCardId || seen.has(card.id)) return false;
        seen.add(card.id);
        if (!q) return true;
        return `${card.title ?? ""} ${card.body ?? ""}`.toLocaleLowerCase().includes(q);
      })
      .slice(0, 20);
  }, [nearby, query, remote, sourceCardId]);

  return createPortal(
    <div className="card-reference-backdrop" onPointerDown={onClose}>
      <div
        className="card-reference-dialog"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong>Reference a card</strong>
          <button type="button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <input
          ref={input}
          value={query}
          placeholder="Search cards…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onClose();
            }
            if (event.key === "Enter" && results[0]) {
              event.preventDefault();
              onPick(results[0]);
            }
          }}
        />
        <div className="card-reference-results">
          {results.map((card) => (
            <button key={card.id} type="button" onClick={() => onPick(card)}>
              <strong>{card.title ?? "Untitled"}</strong>
              {card.body && <span>{card.body.replace(/\s+/g, " ").slice(0, 100)}</span>}
            </button>
          ))}
          {!loading && results.length === 0 && (
            <p>{query.trim() ? "No matching cards" : "No other cards on this canvas"}</p>
          )}
          {loading && results.length === 0 && <p>Searching…</p>}
        </div>
      </div>
    </div>,
    document.body
  );
}
