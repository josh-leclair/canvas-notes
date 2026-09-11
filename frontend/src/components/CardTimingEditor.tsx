import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasAppearance, Card } from "../api/types";
import Icon from "./Icon";
import "./cardTiming.css";

type EtaUnit = "minutes" | "hours" | "days";

const ETA_MULTIPLIER: Record<EtaUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1_440,
};

function initialEta(minutes: number | null): { value: string; unit: EtaUnit } {
  if (!minutes) return { value: "", unit: "minutes" };
  if (minutes % 1_440 === 0) return { value: String(minutes / 1_440), unit: "days" };
  if (minutes % 60 === 0) return { value: String(minutes / 60), unit: "hours" };
  return { value: String(minutes), unit: "minutes" };
}

export default function CardTimingEditor({
  card,
  appearance,
  onSave,
  onClose,
}: {
  card: Card;
  appearance: CanvasAppearance;
  onSave: (patch: { eta_minutes: number | null }) => Promise<void>;
  onClose: () => void;
}) {
  const etaSeed = useMemo(() => initialEta(card.eta_minutes), [card.eta_minutes]);
  const [eta, setEta] = useState(etaSeed.value);
  const [unit, setUnit] = useState<EtaUnit>(etaSeed.unit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const numericEta = eta.trim() === "" ? null : Number(eta);
    if (numericEta !== null && (!Number.isFinite(numericEta) || numericEta <= 0)) {
      setError("Estimate must be a positive number.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        eta_minutes:
          numericEta === null
            ? null
            : Math.max(1, Math.round(numericEta * ETA_MULTIPLIER[unit])),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the estimate.");
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className={`timing-editor-backdrop canvas-appearance-${appearance}`}
      onPointerDown={onClose}
    >
      <form
        className="timing-editor timing-editor-simple"
        onSubmit={submit}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <span className="timing-editor-mark" aria-hidden="true">
            <Icon name="clock" size={22} />
          </span>
          <span>
            <strong>Estimate</strong>
            <small>{card.title || "Untitled card"}</small>
          </span>
          <button type="button" className="timing-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <label>
          <span>Expected effort</span>
          <span className="timing-eta-row">
            <input
              type="number"
              min="0.1"
              step="any"
              inputMode="decimal"
              placeholder="No estimate"
              value={eta}
              onChange={(event) => setEta(event.target.value)}
              autoFocus
            />
            <select value={unit} onChange={(event) => setUnit(event.target.value as EtaUnit)}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </span>
        </label>
        <p className="timing-hint">
          This is an estimate only. Use a Timer card when you want to track elapsed time.
        </p>
        {error && <p className="timing-error">{error}</p>}

        <footer>
          {card.eta_minutes && (
            <button type="button" className="timing-clear" onClick={() => setEta("")}>
              Clear estimate
            </button>
          )}
          <span />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save estimate"}
          </button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
