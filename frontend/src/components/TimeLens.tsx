import { useEffect, useMemo, useState } from "react";
import type { Card } from "../api/types";
import {
  dueLabel,
  elapsedSeconds,
  etaLabel,
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
  const timers = useMemo(() => cards.filter((card) => card.type === "timer"), [cards]);
  const scheduled = useMemo(
    () => cards.filter((card) => card.type !== "timer" && Boolean(card.due_at || card.eta_minutes)),
    [cards]
  );
  const running = timers.some((card) => card.timer_started_at);
  const hasDueDates = scheduled.some((card) => card.due_at);

  useEffect(() => {
    if (!running && !hasDueDates) return;
    const interval = window.setInterval(() => setNow(Date.now()), running ? 1_000 : 30_000);
    return () => window.clearInterval(interval);
  }, [hasDueDates, running]);

  const estimatedMinutes = scheduled.reduce(
    (total, card) => total + (card.eta_minutes ?? 0),
    0
  );

  return (
    <aside className="time-lens" aria-label="Canvas time overview">
      <header>
        <span className="time-lens-mark"><Icon name="clock" size={17} /></span>
        <span><strong>Time</strong><small>Due dates, estimates, and focus timers</small></span>
        <button type="button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </header>
      <div className="time-lens-summary">
        <span><b>{scheduled.length}</b> scheduled</span>
        <span><b>{timers.length}</b> timers</span>
        <span><b>{etaLabel(estimatedMinutes) ?? "0m"}</b> planned</span>
      </div>
      <div className="time-lens-sections">
        {timers.length > 0 && (
          <section className="time-lens-section is-estimate">
            <h3>Timer cards<span>{timers.length}</span></h3>
            {timers.map((card) => {
              const duration = (card.eta_minutes ?? 25) * 60;
              const elapsed = elapsedSeconds(card, now);
              const remaining = duration - elapsed;
              return (
                <button type="button" key={card.id} onClick={() => onPick(card.id)}>
                  <span className="time-lens-card-state" aria-hidden="true" />
                  <span>
                    <strong>{card.title || "Focus Timer"}</strong>
                    <small>
                      {remaining < 0
                        ? `${formatDuration(-remaining, Boolean(card.timer_started_at))} overtime`
                        : `${formatDuration(remaining, Boolean(card.timer_started_at))} remaining`}
                    </small>
                  </span>
                  {card.timer_started_at && <span className="time-lens-live">live</span>}
                </button>
              );
            })}
          </section>
        )}
        {SECTIONS.map((section) => {
          const items = scheduled
            .filter((card) => timeLensBucket(card, new Date(now)) === section.id)
            .sort((left, right) => {
              if (section.id === "estimate") {
                return (left.eta_minutes ?? 0) - (right.eta_minutes ?? 0);
              }
              return (
                new Date(left.due_at ?? 0).getTime() -
                new Date(right.due_at ?? 0).getTime()
              );
            });
          if (!items.length) return null;
          return (
            <section key={section.id} className={`time-lens-section is-${section.id}`}>
              <h3>{section.label}<span>{items.length}</span></h3>
              {items.map((card) => {
                const due = dueLabel(card.due_at, new Date(now));
                const eta = etaLabel(card.eta_minutes);
                return (
                  <button type="button" key={card.id} onClick={() => onPick(card.id)}>
                    <span className="time-lens-card-state" aria-hidden="true" />
                    <span>
                      <strong>{card.title || card.body?.slice(0, 56) || "Untitled"}</strong>
                      <small>
                        {due}
                        {due && eta && " · "}
                        {eta && `ETA ${eta}`}
                      </small>
                    </span>
                  </button>
                );
              })}
            </section>
          );
        })}
        {!timers.length && !scheduled.length && (
          <div className="time-lens-empty">
            <Icon name="clock" size={24} />
            <strong>No time information yet.</strong>
            <span>Add a due date or ETA to a card, or create a Timer card.</span>
          </div>
        )}
      </div>
    </aside>
  );
}
