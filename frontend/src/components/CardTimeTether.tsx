import type { Card } from "../api/types";
import { etaLabel } from "../lib/cardTiming";
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
  const ownEta = etaLabel(card.eta_minutes);

  return (
    <div className="card-time-tether">
      {ownEta && (
        <button
          type="button"
          className="card-eta-summary nodrag"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (!readOnly) onEdit();
          }}
          title={readOnly ? `Estimated effort: ${ownEta}` : "Edit estimated effort"}
        >
          <Icon name="clock" />
          <strong>ETA {ownEta}</strong>
        </button>
      )}
      {rollup && rollup.timedChildCount > 0 && (
        <div
          className="child-time-rollup"
          title={`Estimated effort across ${rollup.timedChildCount} direct children`}
        >
          <Icon name="clock" />
          <strong>{rollup.timedChildCount}/{rollup.childCount} children</strong>
          <span>· ETA {etaLabel(rollup.etaMinutes)}</span>
        </div>
      )}
    </div>
  );
}
