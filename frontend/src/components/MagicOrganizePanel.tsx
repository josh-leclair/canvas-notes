import { useEffect, useRef, useState } from "react";
import type { OrganizeGroup, OrganizeMode } from "../lib/magicOrganize";
import { modeSupportsZones } from "../lib/magicOrganize";
import Icon from "./Icon";
import "./magicOrganizePanel.css";

const MODES: Array<{
  id: OrganizeMode;
  name: string;
  description: string;
}> = [
  { id: "cluster", name: "Cluster", description: "Use headings, links, topics, and nearby placement." },
  { id: "project", name: "Project", description: "Sort active work, next steps, references, and done." },
  { id: "timeline", name: "Timeline", description: "Arrange dated work from overdue to upcoming." },
  { id: "moodboard", name: "Mood board", description: "Build image-forward sections with loose rhythm." },
  { id: "compact", name: "Compact", description: "Clean up spacing while keeping reading order." },
];

function ModeDiagram({ mode }: { mode: OrganizeMode }) {
  return (
    <span className={`magic-mode-diagram is-${mode}`} aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  );
}

export default function MagicOrganizePanel({
  mode,
  count,
  fixedCount,
  selectedScope,
  groups,
  addZones,
  onMode,
  onAddZones,
  onCancel,
  onApply,
}: {
  mode: OrganizeMode;
  count: number;
  fixedCount: number;
  selectedScope: boolean;
  groups: OrganizeGroup[];
  addZones: boolean;
  onMode: (mode: OrganizeMode) => void;
  onAddZones: (add: boolean) => void;
  onCancel: () => void;
  onApply: () => Promise<void>;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !applying) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applying, onCancel]);

  return (
    <div className="magic-organize-layer">
      <div
        className="magic-organize-scrim"
        onPointerDown={() => {
          if (!applying) onCancel();
        }}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        className="magic-organize-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="magic-organize-title"
        tabIndex={-1}
      >
        <header>
          <span className="magic-organize-mark"><Icon name="sparkles" size={19} /></span>
          <span>
            <strong id="magic-organize-title">Magic organize</strong>
            <small>
              Previewing {count} {selectedScope ? "selected" : "free-standing"} card{count === 1 ? "" : "s"}
              {fixedCount > 0 ? ` · leaving ${fixedCount} fixed` : ""}
            </small>
          </span>
          <button
            type="button"
            className="magic-organize-close"
            onClick={onCancel}
            disabled={applying}
            aria-label="Cancel organization"
          >
            <Icon name="close" />
          </button>
        </header>

        <p className="magic-organize-intro">
          Try a shape. The preview is temporary. Names come from headings or repeated card words.
        </p>

        <div className="magic-organize-modes">
          {MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={mode === option.id ? "is-active" : ""}
              aria-pressed={mode === option.id}
              disabled={applying}
              onClick={() => onMode(option.id)}
            >
              <ModeDiagram mode={option.id} />
              <span>
                <strong>{option.name}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          ))}
        </div>

        {groups.length > 0 && (
          <section className="magic-organize-explanations" aria-label="Why cards were grouped">
            <strong>Why this layout</strong>
            <ul>
              {groups.map((group, index) => (
                <li key={`${group.name}:${index}`}>
                  <span>{group.name}</span>
                  <small>{group.reason}</small>
                </li>
              ))}
            </ul>
          </section>
        )}

        {modeSupportsZones(mode) && groups.length > 0 && (
          <label className="magic-organize-zone-toggle">
            <input
              type="checkbox"
              checked={addZones}
              disabled={applying}
              onChange={(event) => onAddZones(event.target.checked)}
            />
            <span>
              <strong>Create named zones</strong>
              <small>{groups.map((group) => group.name).join(" · ")}</small>
            </span>
          </label>
        )}

        <footer>
          <button type="button" onClick={onCancel} disabled={applying}>Cancel</button>
          <button
            type="button"
            className="primary magic-organize-apply"
            disabled={applying}
            onClick={async () => {
              setApplying(true);
              try {
                await onApply();
              } finally {
                setApplying(false);
              }
            }}
          >
            <Icon name="sparkles" /> {applying ? "Applying…" : "Apply layout"}
          </button>
        </footer>
      </aside>
    </div>
  );
}
