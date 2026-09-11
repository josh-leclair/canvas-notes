import { useEffect, useMemo, useState } from "react";
import type { Card } from "../api/types";
import {
  dueLabel,
  elapsedSeconds,
  formatDuration,
  timeLensBucket,
  type TimeLensBucket,
} from "../lib/cardTiming";
import Icon from "./Icon";
import "./timeLens.css";

const SECTIONS: { id: TimeLensBucket; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "week", label: "Next 7 days" },
  { id: "later", label: "Later" },
  { id: "estimate", label: "Estimated, not dated" },
];

export default function TimeLens({
  cards,
  onPick,
  onClose,
}: {
  cards: Card[];
  onPick: (cardId: string) => void;
  onClose: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const hasRunning = cards.some((card) => card.timer_started_at);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), hasRunning ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  const timed = useMemo(
    () => cards.filter((card) => timeLensBucket(card, new Date(now)) !== null),
    [cards, now]
  );
  const active = timed.filter((card) => card.timer_started_at).length;
  const remaining = timed.reduce(
    (total, card) =>
      total + Math.max(0, (card.eta_minutes ?? 0) * 60 - elapsedSeconds(card, now)),
    0
  );

  return (
    <aside className="time-lens" aria-label="Canvas Time Lens">
      <header>
        <span className="time-lens-mark"><Icon name="clock" size={17} /></span>
        <span><strong>Time Lens</strong><small>This canvas, ordered by urgency</small></span>
        <button type="button" onClick={onClose} aria-label="Close Time Lens"><Icon name="close" /></button>
      </header>
      <div className="time-lens-summary">
        <span><b>{timed.length}</b> timed</span>
        <span><b>{active}</b> active</span>
        <span><b>{remaining ? formatDuration(remaining) : "0m"}</b> remaining</span>
      </div>
      <div className="time-lens-sections">
        {SECTIONS.map((section) => {
          const items = timed
            .filter((card) => timeLensBucket(card, new Date(now)) === section.id)
            .sort((left, right) => {
              const leftDue = left.due_at ? new Date(left.due_at).getTime() : Infinity;
              const rightDue = right.due_at ? new Date(right.due_at).getTime() : Infinity;
              return leftDue - rightDue;
            });
          if (!items.length) return null;
          return (
            <section key={section.id} className={`time-lens-section is-${section.id}`}>
              <h3>{section.label}<span>{items.length}</span></h3>
              {items.map((card) => {
                const elapsed = elapsedSeconds(card, now);
                const estimate = (card.eta_minutes ?? 0) * 60;
                const cardRemaining = estimate - elapsed;
                return (
                  <button type="button" key={card.id} onClick={() => onPick(card.id)}>
                    <span className="time-lens-card-state" aria-hidden="true" />
                    <span>
                      <strong>{card.title || card.body?.slice(0, 56) || "Untitled"}</strong>
                      <small>
                        {card.due_at && dueLabel(card.due_at, new Date(now))}
                        {card.due_at && estimate > 0 && " · "}
                        {estimate > 0 && `${formatDuration(
                          Math.abs(cardRemaining),
                          Boolean(card.timer_started_at)
                        )} ${cardRemaining < 0 ? "over" : "left"}`}
                        {!card.due_at && estimate === 0 && `${formatDuration(elapsed)} logged`}
                      </small>
                    </span>
                    {card.timer_started_at && <span className="time-lens-live">live</span>}
                  </button>
                );
              })}
            </section>
          );
        })}
        {!timed.length && (
          <div className="time-lens-empty">
            <Icon name="clock" size={24} />
            <strong>No cards are tethered yet.</strong>
            <span>Right-click a card to add a due date or ETA.</span>
          </div>
        )}
      </div>
    </aside>
  );
}
