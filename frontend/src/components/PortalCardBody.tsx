import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { Card, PortalOut } from "../api/types";
import { useOpenCard } from "../hooks/useOpenCard";
import { useCanvasStore } from "../store/canvasStore";
import Icon from "./Icon";
import PortalEditor, { portalConfigOf } from "./PortalEditor";
import "./portalCard.css";

export const PORTAL_REFRESH_EVENT = "canvas-notes:portal-refresh";

export default function PortalCardBody({
  card,
  readOnly,
}: {
  card: Card;
  readOnly: boolean;
}) {
  const [result, setResult] = useState<PortalOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(false);
  const openCard = useOpenCard();
  const updateCard = useCanvasStore((state) => state.updateCard);
  const currentCanvasId = useCanvasStore((state) => state.canvasId);
  const config = portalConfigOf(card.payload);

  const load = useCallback(async () => {
    try {
      const next = await api.get<PortalOut>(`/api/cards/${card.id}/portal`);
      setResult(next);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [card.id]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 30_000);
    const onRefresh = (event: Event) => {
      const target = (event as CustomEvent<{ portalId?: string }>).detail?.portalId;
      if (!target || target === card.id) void load();
    };
    const onFocus = () => void load();
    window.addEventListener(PORTAL_REFRESH_EVENT, onRefresh);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(PORTAL_REFRESH_EVENT, onRefresh);
      window.removeEventListener("focus", onFocus);
    };
  }, [load, card.id]);

  const qualifiers = [
    config.card_type !== "any" ? config.card_type : null,
    config.query ? `“${config.query}”` : null,
    config.open_tasks ? "open tasks" : null,
  ].filter(Boolean);

  return (
    <div className="portal-card nowheel">
      <header>
        <span className="portal-card-icon"><Icon name="portal" /></span>
        <span className="portal-card-heading">
          <strong>{card.title || "Portal"}</strong>
          <small>
            {result?.source_name ?? (config.scope === "workspace" ? "All cards" : "Canvas")}
            {qualifiers.length > 0 && ` · ${qualifiers.join(" · ")}`}
          </small>
        </span>
        <button
          type="button"
          className={`portal-icon-button nodrag ${loading ? "is-spinning" : ""}`}
          title="Refresh portal"
          onClick={(event) => {
            event.stopPropagation();
            setLoading(true);
            void load();
          }}
        >
          ↻
        </button>
        {!readOnly && (
          <button
            type="button"
            className="portal-icon-button nodrag"
            title="Edit portal"
            onClick={(event) => {
              event.stopPropagation();
              setEditing(true);
            }}
          >
            <Icon name="edit" size={14} />
          </button>
        )}
      </header>

      <div className="portal-items nodrag">
        {result?.items.map((item) => (
          <button
            key={item.card.id}
            type="button"
            draggable
            className={`portal-item nodrag type-${item.card.type}`}
            title="Open this card. Drag it out to place the same card here."
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData("application/x-canvas-card", item.card.id);
              event.dataTransfer.setData(
                "application/x-canvas-card-data",
                JSON.stringify(item.card)
              );
              event.dataTransfer.setData("text/plain", item.card.title ?? item.card.body ?? "Card");
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void openCard(item.card.id);
            }}
          >
            <span className="portal-item-dot" />
            <span>
              <strong>{item.card.title || item.card.body?.slice(0, 72) || "Untitled"}</strong>
              <small>
                {item.card.type}
                {item.placements[0] ? ` · ${item.placements[0].canvas_name}` : " · inbox"}
              </small>
            </span>
            <Icon name="chevronRight" size={13} />
          </button>
        ))}
        {!loading && !error && result?.items.length === 0 && (
          <div className="portal-empty">Nothing matches yet.</div>
        )}
        {loading && !result && <div className="portal-empty">Looking through your cards…</div>}
        {error && <div className="portal-empty is-error">Could not refresh this portal.</div>}
      </div>

      {result && (
        <footer>
          {result.total} {result.total === 1 ? "card" : "cards"}
          {result.total > result.items.length && ` · newest ${result.items.length} shown`}
          {config.scope === "canvas" && !readOnly && <span>Drop a card here to add it</span>}
        </footer>
      )}

      {editing && (
        <PortalEditor
          initial={config}
          initialTitle={card.title}
          currentCanvasId={currentCanvasId ?? undefined}
          onClose={() => setEditing(false)}
          onSave={async (title, next) => {
            const payload = { ...card.payload, ...next };
            if (next.scope === "workspace") delete payload.canvas_id;
            await updateCard(card.id, { title, payload });
            setEditing(false);
            setLoading(true);
            window.dispatchEvent(
              new CustomEvent(PORTAL_REFRESH_EVENT, { detail: { portalId: card.id } })
            );
          }}
        />
      )}
    </div>
  );
}
