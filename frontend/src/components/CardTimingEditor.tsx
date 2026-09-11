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

function localInputValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

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
  onSave: (patch: { due_at: string | null; eta_minutes: number | null }) => Promise<void>;
  onClose: () => void;
}) {
  const etaSeed = useMemo(() => initialEta(card.eta_minutes), [card.eta_minutes]);
  const [due, setDue] = useState(() => localInputValue(card.due_at));
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

  function chooseDay(daysFromToday: number) {
    const now = new Date();
    const next = new Date();
    next.setDate(next.getDate() + daysFromToday);
    next.setHours(17, 0, 0, 0);
    if (daysFromToday === 0 && next <= now) {
      next.setTime(now.getTime() + 60 * 60_000);
      if (next.getDate() !== now.getDate()) {
        next.setTime(now.getTime());
        next.setHours(23, 59, 0, 0);
      }
    }
    const local = new Date(next.getTime() - next.getTimezoneOffset() * 60_000);
    setDue(local.toISOString().slice(0, 16));
  }

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
        due_at: due ? new Date(due).toISOString() : null,
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
            <strong>Schedule</strong>
            <small>{card.title || "Untitled card"}</small>
          </span>
          <button type="button" className="timing-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <label>
          <span>Due date</span>
          <input
            type="datetime-local"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            autoFocus
          />
        </label>
        <div className="timing-quick-days" aria-label="Quick due dates">
          <button type="button" onClick={() => chooseDay(0)}>Today</button>
          <button type="button" onClick={() => chooseDay(1)}>Tomorrow</button>
          <button type="button" onClick={() => chooseDay(7)}>Next week</button>
          {due && <button type="button" onClick={() => setDue("")}>Clear due date</button>}
        </div>

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
            />
            <select value={unit} onChange={(event) => setUnit(event.target.value as EtaUnit)}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </span>
        </label>
        <p className="timing-hint">
          The due date says when it should be finished. The ETA says how much work it may take.
        </p>
        {error && <p className="timing-error">{error}</p>}

        <footer>
          {(card.due_at || card.eta_minutes) && (
            <button
              type="button"
              className="timing-clear"
              onClick={() => {
                setDue("");
                setEta("");
              }}
            >
              Clear schedule
            </button>
          )}
          <span />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save schedule"}
          </button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
