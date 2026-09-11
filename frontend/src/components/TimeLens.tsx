import { useEffect, useMemo, useState } from "react";
import type { Card } from "../api/types";
import { elapsedSeconds, etaLabel, formatDuration } from "../lib/cardTiming";
import Icon from "./Icon";
import "./timeLens.css";

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
  const estimates = useMemo(
    () => cards.filter((card) => card.type !== "timer" && Boolean(card.eta_minutes)),
    [cards]
  );
  const running = timers.some((card) => card.timer_started_at);

  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [running]);

  const estimatedMinutes = estimates.reduce(
    (total, card) => total + (card.eta_minutes ?? 0),
    0
  );

  return (
    <aside className="time-lens" aria-label="Canvas time overview">
      <header>
        <span className="time-lens-mark"><Icon name="clock" size={17} /></span>
        <span><strong>Time</strong><small>Estimates and focus timers</small></span>
        <button type="button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </header>
      <div className="time-lens-summary">
        <span><b>{estimates.length}</b> estimated</span>
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
        {estimates.length > 0 && (
          <section className="time-lens-section is-estimate">
            <h3>Card estimates<span>{estimates.length}</span></h3>
            {[...estimates]
              .sort((left, right) => (left.eta_minutes ?? 0) - (right.eta_minutes ?? 0))
              .map((card) => (
                <button type="button" key={card.id} onClick={() => onPick(card.id)}>
                  <span className="time-lens-card-state" aria-hidden="true" />
                  <span>
                    <strong>{card.title || card.body?.slice(0, 56) || "Untitled"}</strong>
                    <small>ETA {etaLabel(card.eta_minutes)}</small>
                  </span>
                </button>
              ))}
          </section>
        )}
        {!timers.length && !estimates.length && (
          <div className="time-lens-empty">
            <Icon name="clock" size={24} />
            <strong>No time information yet.</strong>
            <span>Add an estimate to a card or create a Timer card.</span>
          </div>
        )}
      </div>
    </aside>
  );
}
