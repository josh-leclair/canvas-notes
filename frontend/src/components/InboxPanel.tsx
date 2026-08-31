import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { CanvasSuggestion, Card, GeneratedBy } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import { confirmDialog } from "../store/dialogStore";
import {
  INBOX_TOUCH_DROP_EVENT,
  type InboxTouchDropDetail,
} from "../lib/inboxTouchDrag";
import Icon from "./Icon";
import "./inboxPanel.css";

function generatedBy(card: Card): GeneratedBy | null {
  return (card.payload as { generated_by?: GeneratedBy }).generated_by ?? null;
}

type Row =
  | { kind: "card"; card: Card }
  | { kind: "batch"; batchId: string; cards: Card[] };

/** Cards from one split arrive together, so they sit together in the list and
 * can be thrown away together. Everything else stays a loose item. */
function group(inbox: Card[]): Row[] {
  const rows: Row[] = [];
  for (const card of inbox) {
    const stamp = generatedBy(card);
    if (!stamp) {
      rows.push({ kind: "card", card });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last && last.kind === "batch" && last.batchId === stamp.batch_id) {
      last.cards.push(card);
    } else {
      rows.push({ kind: "batch", batchId: stamp.batch_id, cards: [card] });
    }
  }
  // A batch is written in one transaction, so its cards share a created_at
  // and arrive in no particular order. The hero leads its own group.
  for (const row of rows) {
    if (row.kind === "batch") {
      row.cards.sort(
        (a, b) => Number(generatedBy(b)?.hero ?? false) - Number(generatedBy(a)?.hero ?? false)
      );
    }
  }
  return rows;
}

export default function InboxPanel() {
  const inbox = useCanvasStore((s) => s.inbox);
  const open = useCanvasStore((s) => s.inboxOpen);
  const setOpen = useCanvasStore((s) => s.setInboxOpen);
  const canvasId = useCanvasStore((s) => s.canvasId);
  const canvasName = useCanvasStore((s) => s.canvasName);
  const discardBatch = useCanvasStore((s) => s.discardBatch);
  const [triage, setTriage] = useState<Record<string, CanvasSuggestion[]>>({});
  const [touchPreview, setTouchPreview] = useState<{
    card: Card;
    x: number;
    y: number;
  } | null>(null);
  const touchSession = useRef<{
    pointerId: number;
    card: Card;
    element: HTMLDivElement;
    startX: number;
    startY: number;
    x: number;
    y: number;
    active: boolean;
    timer: number;
  } | null>(null);

  function clearTouchSession() {
    const session = touchSession.current;
    if (session) window.clearTimeout(session.timer);
    touchSession.current = null;
    setTouchPreview(null);
  }

  function activateTouchSession(session: NonNullable<typeof touchSession.current>) {
    if (touchSession.current !== session || session.active) return;
    session.active = true;
    try {
      session.element.setPointerCapture(session.pointerId);
    } catch {
      clearTouchSession();
      return;
    }
    setTouchPreview({ card: session.card, x: session.x, y: session.y });
  }

  function startTouchDrag(event: React.PointerEvent<HTMLDivElement>, card: Card) {
    if ((event.pointerType !== "touch" && event.pointerType !== "pen") || event.button !== 0) return;
    clearTouchSession();
    const session = {
      pointerId: event.pointerId,
      card,
      element: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
      timer: 0,
    };
    session.timer = window.setTimeout(() => activateTouchSession(session), 180);
    touchSession.current = session;
  }

  function moveTouchDrag(event: React.PointerEvent<HTMLDivElement>) {
    const session = touchSession.current;
    if (!session || event.pointerId !== session.pointerId) return;
    session.x = event.clientX;
    session.y = event.clientY;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;

    if (!session.active) {
      // A deliberate pull toward the canvas starts immediately. A vertical
      // swipe remains ordinary inbox scrolling unless the finger was held.
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.15) {
        activateTouchSession(session);
      } else if (Math.abs(dy) > 10) {
        clearTouchSession();
        return;
      }
    }
    if (!session.active) return;
    event.preventDefault();
    event.stopPropagation();
    setTouchPreview({ card: session.card, x: event.clientX, y: event.clientY });
  }

  function finishTouchDrag(event: React.PointerEvent<HTMLDivElement>) {
    const session = touchSession.current;
    if (!session || event.pointerId !== session.pointerId) return;
    window.clearTimeout(session.timer);
    if (session.active) {
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent<InboxTouchDropDetail>(
        INBOX_TOUCH_DROP_EVENT,
        { detail: { cardId: session.card.id, clientX: event.clientX, clientY: event.clientY } }
      ));
    }
    clearTouchSession();
  }

  useEffect(() => () => {
    const session = touchSession.current;
    if (session) window.clearTimeout(session.timer);
    touchSession.current = null;
  }, []);

  // Where does a captured item belong? Ask its nearest neighbours. Silent
  // when embeddings are unavailable: the endpoint returns nothing.
  useEffect(() => {
    if (!open || inbox.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        inbox.slice(0, 10).map(async (card) => {
          try {
            const hints = await api.get<CanvasSuggestion[]>(
              `/api/cards/${card.id}/canvas-suggestions?limit=1`
            );
            return [card.id, hints] as const;
          } catch {
            return [card.id, []] as const;
          }
        })
      );
      if (!cancelled) setTriage(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, inbox]);

  async function discard(batchId: string, count: number) {
    const ok = await confirmDialog({
      title: `Discard ${count} generated card${count === 1 ? "" : "s"}?`,
      body: "Anything from this batch you have already placed on a canvas is kept.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (ok) await discardBatch(batchId);
  }

  const generalInbox = inbox.filter((card) => !card.inbox_canvas_id);
  const boardInbox = inbox.filter((card) => card.inbox_canvas_id === canvasId);
  const visibleInbox = [...generalInbox, ...boardInbox];

  async function clearAll() {
    const ok = await confirmDialog({
      title: `Delete all ${visibleInbox.length} visible inbox item${visibleInbox.length === 1 ? "" : "s"}?`,
      body: "These cards are gone for good. Anything already on a canvas is untouched.",
      confirmLabel: "Delete all",
      danger: true,
    });
    if (ok) {
      await Promise.all(visibleInbox.map((card) => api.delete(`/api/cards/${card.id}`)));
      await useCanvasStore.getState().loadInbox();
    }
  }

  const renderCard = (card: Card) => {
    const hint = triage[card.id]?.[0];
    return (
      <div
        key={card.id}
        className="inbox-card"
        draggable
        onPointerDown={(event) => startTouchDrag(event, card)}
        onPointerMove={moveTouchDrag}
        onPointerUp={finishTouchDrag}
        onPointerCancel={clearTouchSession}
        onContextMenu={(event) => {
          if (touchSession.current?.card.id === card.id) event.preventDefault();
        }}
        onDragStart={(e) => {
          if (touchSession.current) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.setData("application/x-canvas-card", card.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        {card.title && <div className="inbox-card-title">{card.title}</div>}
        <div className="inbox-card-body">{card.body ?? ""}</div>
        {hint && hint.canvas_id !== canvasId && (
          <div className="inbox-hint">maybe “{hint.canvas_name}”</div>
        )}
      </div>
    );
  };

  const renderRows = (cards: Card[]) => group(cards).map((row) =>
    row.kind === "card" ? renderCard(row.card) : (
      <div key={row.batchId} className="inbox-batch">
        <div className="inbox-batch-head">
          <span className="inbox-batch-label">split into {row.cards.length}</span>
          <button className="inbox-batch-discard" onClick={() => discard(row.batchId, row.cards.length)}>Discard all</button>
        </div>
        {row.cards.map(renderCard)}
      </div>
    )
  );

  return (
    <aside className={`inbox-panel ${open ? "is-open" : ""}`}>
      <button className="inbox-toggle" onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronLeft" : "chevronRight"} /> Inbox
        {visibleInbox.length > 0 && <span className="inbox-badge">{visibleInbox.length}</span>}
      </button>

      {open && (
        <div className="inbox-list">
          {visibleInbox.length > 0 && (
            <div className="inbox-head">
              <span className="inbox-head-count">
                {visibleInbox.length} item{visibleInbox.length === 1 ? "" : "s"}
              </span>
              <button className="inbox-clear" onClick={clearAll}>
                Clear all
              </button>
            </div>
          )}
          {visibleInbox.length === 0 && (
            <p className="inbox-empty">
              Nothing here. Captured items — from the API, the iOS Shortcut, or
              a paired chat bot — land in this inbox until you drag them onto a
              canvas.
            </p>
          )}
          <div className="inbox-section-label">General inbox <span>{generalInbox.length}</span></div>
          {renderRows(generalInbox)}
          <div className="inbox-section-label">{canvasName} inbox <span>{boardInbox.length}</span></div>
          {renderRows(boardInbox)}
        </div>
      )}
      {touchPreview && (
        <div
          className="inbox-touch-preview"
          style={{ left: touchPreview.x, top: touchPreview.y }}
          aria-hidden="true"
        >
          {touchPreview.card.title && (
            <div className="inbox-card-title">{touchPreview.card.title}</div>
          )}
          <div className="inbox-card-body">{touchPreview.card.body ?? ""}</div>
        </div>
      )}
    </aside>
  );
}
