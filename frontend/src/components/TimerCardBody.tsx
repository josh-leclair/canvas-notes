import { useEffect, useState } from "react";
import type { Card } from "../api/types";
import { elapsedSeconds } from "../lib/cardTiming";
import { useCanvasStore } from "../store/canvasStore";
import Icon from "./Icon";
import "./timerCard.css";

const INTERVALS = [15, 25, 45, 60];

function timerClock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const remainder = safe % 60;
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(hours ? 2 : 1, "0")}:${String(remainder).padStart(2, "0")}`;
}

export default function TimerCardBody({
  card,
  readOnly,
}: {
  card: Card;
  readOnly: boolean;
}) {
  const updateCard = useCanvasStore((state) => state.updateCard);
  const controlTimer = useCanvasStore((state) => state.controlCardTimer);
  const showToast = useCanvasStore((state) => state.showToast);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const running = Boolean(card.timer_started_at);
  const durationMinutes = card.eta_minutes ?? 25;
  const durationSeconds = durationMinutes * 60;
  const elapsed = elapsedSeconds(card, now);
  const remaining = durationSeconds - elapsed;
  const complete = remaining <= 0;
  const progress = durationSeconds ? Math.min(1, elapsed / durationSeconds) : 0;

  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [running]);

  async function run(action: "start" | "pause" | "reset") {
    if (readOnly || busy) return;
    setBusy(true);
    try {
      if (action === "start" && !card.eta_minutes) {
        await updateCard(card.id, { eta_minutes: durationMinutes });
      }
      if (action === "start" && complete) {
        await controlTimer(card.id, "reset");
      }
      await controlTimer(card.id, action);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not update the timer");
    } finally {
      setBusy(false);
    }
  }

  async function setInterval(minutes: number, reset = true) {
    if (readOnly || busy) return;
    setBusy(true);
    try {
      await updateCard(card.id, { eta_minutes: minutes });
      if (reset) await controlTimer(card.id, "reset");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not change the interval");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`timer-card ${running ? "is-running" : ""} ${complete ? "is-complete" : ""}`}>
      <header className="timer-card-head">
        <span className="timer-card-title">
          <i aria-hidden="true" />
          {card.title || "Focus Timer"}
        </span>
        <span className="timer-card-state">
          {complete ? "Overtime" : running ? "Flow" : "Ready"}
        </span>
      </header>

      <div className="timer-card-dial" aria-label={`${Math.round(progress * 100)} percent elapsed`}>
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle className="timer-card-track" cx="60" cy="60" r="52" pathLength="100" />
          <circle
            className="timer-card-progress"
            cx="60"
            cy="60"
            r="52"
            pathLength="100"
            strokeDasharray="100"
            strokeDashoffset={100 - progress * 100}
          />
        </svg>
        <span>
          <strong>{complete ? `+${timerClock(-remaining)}` : timerClock(remaining)}</strong>
          <small>{complete ? "overtime" : `${Math.round(progress * 100)}% elapsed`}</small>
        </span>
      </div>

      <div className="timer-card-controls nodrag">
        <button
          type="button"
          className="timer-card-primary"
          disabled={readOnly || busy}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void run(running ? "pause" : "start");
          }}
        >
          <Icon name={running ? "pause" : "play"} />
          {running ? "Pause" : complete ? "Restart" : "Start"}
        </button>
        <button
          type="button"
          disabled={readOnly || busy || elapsed === 0}
          aria-label="Reset timer"
          title="Reset timer"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void run("reset");
          }}
        >
          <Icon name="reset" />
        </button>
        <button
          type="button"
          disabled={readOnly || busy}
          title="Add five minutes"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void setInterval(durationMinutes + 5, false);
          }}
        >
          +5m
        </button>
      </div>

      <div className="timer-card-interval nodrag">
        <span>Interval</span>
        <div>
          {INTERVALS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={durationMinutes === minutes ? "is-active" : ""}
              disabled={readOnly || busy}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void setInterval(minutes);
              }}
            >
              {minutes}m
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
