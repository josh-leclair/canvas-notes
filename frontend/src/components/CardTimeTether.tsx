import { useEffect, useState } from "react";
import type { Card } from "../api/types";
import { dueLabel, etaLabel, timingTone } from "../lib/cardTiming";
import type { TimingRollup } from "../store/canvasStore";
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
  const [now, setNow] = useState(Date.now());
  const ownEta = etaLabel(card.eta_minutes);
  const ownDue = dueLabel(card.due_at, new Date(now));
  const overdueChildren = rollup
    ? rollup.dueDates.filter((dueAt) => new Date(dueAt).getTime() < now).length
    : 0;
  const tone = timingTone(card.due_at ?? rollup?.nextDueAt ?? null, now);

  useEffect(() => {
    if (!card.due_at && !rollup?.nextDueAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [card.due_at, rollup?.nextDueAt]);

  return (
    <div className={`card-time-tether is-${tone}`}>
      {(ownDue || ownEta) && (
        <button
          type="button"
          className="card-eta-summary nodrag"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (!readOnly) onEdit();
          }}
          title={
            readOnly
              ? [card.due_at ? `Due ${new Date(card.due_at).toLocaleString()}` : null, ownEta ? `ETA ${ownEta}` : null]
                  .filter(Boolean)
                  .join(" · ")
              : "Edit due date or ETA"
          }
        >
          <Icon name="clock" />
          <span className="card-schedule-copy">
            {ownDue && <strong>{ownDue}</strong>}
            {ownDue && ownEta && <span>·</span>}
            {ownEta && <span>ETA {ownEta}</span>}
          </span>
        </button>
      )}
      {rollup && rollup.timedChildCount > 0 && (
        <div
          className="child-time-rollup"
          title={`Estimated effort across ${rollup.timedChildCount} direct children`}
        >
          <Icon name="clock" />
          <strong>{rollup.timedChildCount}/{rollup.childCount} children</strong>
          {rollup.etaMinutes > 0 && <span>· ETA {etaLabel(rollup.etaMinutes)}</span>}
          {overdueChildren > 0 ? (
            <b>· {overdueChildren} overdue</b>
          ) : rollup.nextDueAt ? (
            <span>· next {dueLabel(rollup.nextDueAt, new Date(now))?.toLowerCase()}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
