import { useEffect, useState } from "react";
import type { Card } from "../api/types";
import {
  dueLabel,
  elapsedSeconds,
  etaLabel,
  formatDuration,
  timingTone,
} from "../lib/cardTiming";
import { useCanvasStore, type TimingRollup } from "../store/canvasStore";
import Icon from "./Icon";

export default function CardTimeTether({
  card,
  rollup,
  readOnly,
  onEdit,
}: {
  card: Card;
  rollup?: TimingRollup | null;
  readOnly: boolean;
  onEdit: () => void;
}) {
  const controlTimer = useCanvasStore((state) => state.controlCardTimer);
  const showToast = useCanvasStore((state) => state.showToast);
  const [now, setNow] = useState(Date.now());
  const running = Boolean(card.timer_started_at);
  const rollupRunning = Boolean(rollup?.runningStartedAt.length);

  useEffect(() => {
    const live = running || rollupRunning;
    if (!live && !card.due_at && !rollup?.nextDueAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), live ? 1_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [running, rollupRunning, card.due_at, rollup?.nextDueAt]);

  const elapsed = elapsedSeconds(card, now);
  const estimateSeconds = (card.eta_minutes ?? 0) * 60;
  const progress = estimateSeconds ? Math.min(1, elapsed / estimateSeconds) : 0;
  const remaining = estimateSeconds - elapsed;
  const due = dueLabel(card.due_at, new Date(now));
  const eta = etaLabel(card.eta_minutes);
  const hasOwnTiming = Boolean(due || eta || elapsed || running);
  const rollupElapsed = rollup
    ? rollup.elapsedSeconds + rollup.runningStartedAt.reduce(
        (total, started) => total + Math.max(0, Math.floor((now - new Date(started).getTime()) / 1_000)),
        0
      )
    : 0;
  const rollupRemaining = rollup ? rollup.etaMinutes * 60 - rollupElapsed : 0;
  const rollupOverdue = rollup
    ? rollup.dueDates.filter((dueAt) => new Date(dueAt).getTime() < now).length
    : 0;
  const tone = card.due_at
    ? timingTone(card.due_at, now)
    : rollupOverdue
      ? "overdue"
      : timingTone(rollup?.nextDueAt ?? null, now);

  async function toggleTimer(event: React.MouseEvent) {
    event.stopPropagation();
    try {
      await controlTimer(card.id, running ? "pause" : "start");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not update the timer");
    }
  }

  return (
    <div className={`card-time-tether is-${tone} ${running ? "is-running" : ""}`}>
      {hasOwnTiming && (
        <div className="card-time-own">
          <button
            type="button"
            className="card-time-summary nodrag"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              if (!readOnly) onEdit();
            }}
            title={card.due_at ? `Due ${new Date(card.due_at).toLocaleString()}` : "Edit timing"}
          >
            <span className="time-progress" aria-hidden="true">
              <span className="time-progress-fill" style={{ width: `${progress * 100}%` }} />
              {estimateSeconds > 0 && (
                <i className="time-progress-marker" style={{ left: `${progress * 100}%` }} />
              )}
            </span>
            <span className="time-summary-copy">
              {due && <b>{due}</b>}
              {due && (eta || elapsed) && <span>·</span>}
              {estimateSeconds > 0 && elapsed > 0 ? (
                <span className={remaining < 0 ? "is-over" : ""}>
                  {remaining >= 0
                    ? `${formatDuration(remaining, running)} left`
                    : `${formatDuration(-remaining, running)} over`}
                </span>
              ) : eta ? (
                <span>ETA {eta}</span>
              ) : elapsed > 0 ? (
                <span>{formatDuration(elapsed, running)} logged</span>
              ) : null}
            </span>
          </button>
          {!readOnly && (card.eta_minutes || running) && (
            <button
              type="button"
              className="card-time-toggle nodrag"
              title={running ? "Pause focus timer" : "Start focus timer"}
              aria-label={running ? "Pause focus timer" : "Start focus timer"}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={toggleTimer}
            >
              <Icon name={running ? "pause" : "play"} size={12} />
            </button>
          )}
        </div>
      )}
      {rollup && rollup.timedChildCount > 0 && (
        <div
          className="child-time-rollup"
          title={`Timing across ${rollup.timedChildCount} direct children`}
        >
          <Icon name="clock" size={12} />
          <span>{rollup.timedChildCount}/{rollup.childCount} children</span>
          {rollup.etaMinutes > 0 && (
            <span className={rollupRemaining < 0 ? "is-over" : ""}>
              · {rollupRemaining === 0 ? "0m" : formatDuration(Math.abs(rollupRemaining))}{" "}
              {rollupRemaining < 0 ? "over" : "left"}
            </span>
          )}
          {rollupOverdue > 0 && <b>· {rollupOverdue} overdue</b>}
          {rollup.nextDueAt && rollupOverdue === 0 && (
            <span>· next {dueLabel(rollup.nextDueAt, new Date(now))?.toLowerCase()}</span>
          )}
        </div>
      )}
    </div>
  );
}
