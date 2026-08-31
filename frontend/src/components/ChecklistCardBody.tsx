import { useEffect, useMemo, useRef, useState } from "react";
import type { Card } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import Icon from "./Icon";
import "./structuredCard.css";

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export function itemsOf(card: Card): ChecklistItem[] {
  const raw = (card.payload as { items?: unknown }).items;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) =>
    typeof entry === "string"
      ? { text: entry, done: false }
      : {
          text: String((entry as ChecklistItem)?.text ?? ""),
          done: Boolean((entry as ChecklistItem)?.done),
        }
  );
}

interface ChecklistCardBodyProps {
  card: Card;
  readOnly?: boolean;
  /** Changes when a newly created list, or its Edit menu action, should put
   * the caret into the first useful task. */
  focusRequest?: number;
}

/** A purpose-built to-do surface. The card never changes into the generic
 * title/body editor: its optional name and tasks are edited where shown. */
export default function ChecklistCardBody({
  card,
  readOnly = false,
  focusRequest = 0,
}: ChecklistCardBodyProps) {
  const updateCard = useCanvasStore((s) => s.updateCard);
  const showToast = useCanvasStore((s) => s.showToast);
  const [items, setItems] = useState<ChecklistItem[]>(() => itemsOf(card));
  const [title, setTitle] = useState(card.title ?? "");
  const [focused, setFocused] = useState<number | null>(null);
  const [pendingSaves, setPendingSaves] = useState(0);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const titleFocused = useRef(false);
  const lastCommitted = useRef(JSON.stringify(itemsOf(card)));
  const latest = useRef(items);
  latest.current = items;

  const complete = useMemo(() => items.filter((item) => item.done).length, [items]);
  const total = items.length;
  const percent = total === 0 ? 0 : (complete / total) * 100;

  useEffect(() => {
    if (focused === null && pendingSaves === 0) {
      const saved = itemsOf(card);
      lastCommitted.current = JSON.stringify(saved);
      setItems(saved);
    }
    if (!titleFocused.current) setTitle(card.title ?? "");
  }, [card, focused, pendingSaves]);

  useEffect(() => {
    if (focused !== null) inputs.current[focused]?.focus();
  }, [focused, items.length]);

  useEffect(() => {
    if (!focusRequest || readOnly) return;
    if (items.length === 0) {
      addAfter();
      return;
    }
    const firstEmpty = items.findIndex((item) => item.text.trim() === "");
    setFocused(firstEmpty >= 0 ? firstEmpty : Math.max(0, items.length - 1));
  }, [focusRequest, readOnly]);

  function commit(next: ChecklistItem[]) {
    const snapshot = JSON.stringify(next);
    if (snapshot === lastCommitted.current) return;
    lastCommitted.current = snapshot;
    setPendingSaves((count) => count + 1);
    void updateCard(card.id, { payload: { ...card.payload, items: next } })
      .catch(() => {
        const saved = itemsOf(card);
        lastCommitted.current = JSON.stringify(saved);
        setItems(saved);
        showToast("Could not save the to-do list");
      })
      .finally(() => setPendingSaves((count) => Math.max(0, count - 1)));
  }

  function commitTitle() {
    const next = title.trim();
    const saved = next === "" ? null : next;
    if (saved !== card.title) {
      void updateCard(card.id, { title: saved }).catch(() => {
        setTitle(card.title ?? "");
        showToast("Could not rename the to-do list");
      });
    }
  }

  function change(index: number, text: string) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, text } : item)));
  }

  function toggle(index: number) {
    if (readOnly) return;
    const next = items.map((item, i) =>
      i === index ? { ...item, done: !item.done } : item
    );
    setItems(next);
    commit(next);
  }

  function addAfter(index = items.length - 1) {
    if (readOnly) return;
    const next = [...items];
    const at = Math.max(0, index + 1);
    next.splice(at, 0, { text: "", done: false });
    setItems(next);
    setFocused(at);
    commit(next);
  }

  function removeAt(index: number) {
    if (readOnly) return;
    const next = items.filter((_, i) => i !== index);
    setItems(next);
    setFocused(next.length ? Math.min(index, next.length - 1) : null);
    commit(next);
  }

  return (
    <div className="todo-card">
      <div className="todo-header">
        <span className="todo-mark" aria-hidden="true">
          <Icon name="checklist" size={15} />
        </span>
        {readOnly ? (
          <span className={`todo-title${title ? "" : " is-empty"}`}>
            {title || "To-do list"}
          </span>
        ) : (
          <input
            className="todo-title-input nodrag"
            value={title}
            placeholder="To-do list"
            aria-label="List name"
            onChange={(event) => setTitle(event.target.value)}
            onFocus={() => {
              titleFocused.current = true;
            }}
            onBlur={() => {
              titleFocused.current = false;
              commitTitle();
            }}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        )}
        {total > 0 && (
          <span className={`todo-count${complete === total ? " is-done" : ""}`}>
            {complete}/{total}
          </span>
        )}
        {!readOnly && (
          <button
            type="button"
            className="todo-add nodrag"
            aria-label="Add task"
            title="Add task"
            onClick={(event) => {
              event.stopPropagation();
              addAfter();
            }}
          >
            <span aria-hidden="true">+</span>
          </button>
        )}
      </div>

      {total > 0 && (
        <div
          className="todo-progress"
          role="progressbar"
          aria-label="Tasks complete"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={complete}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}

      <div className="todo-items">
        {items.map((item, index) => (
          <div className={`todo-row${item.done ? " is-done" : ""}`} key={index}>
            <button
              type="button"
              className="todo-checkbox nodrag"
              aria-label={item.done ? "Mark task incomplete" : "Mark task complete"}
              aria-pressed={item.done}
              disabled={readOnly}
              onClick={(event) => {
                event.stopPropagation();
                toggle(index);
              }}
            >
              {item.done && <Icon name="check" size={12} />}
            </button>
            {readOnly ? (
              <span className={`todo-text${item.text ? "" : " is-empty"}`}>
                {item.text || "Untitled task"}
              </span>
            ) : (
              <input
                ref={(element) => {
                  inputs.current[index] = element;
                }}
                className="todo-text-input nodrag"
                value={item.text}
                placeholder="What needs doing?"
                aria-label={`Task ${index + 1}`}
                onChange={(event) => change(index, event.target.value)}
                onFocus={() => setFocused(index)}
                onBlur={() => {
                  setFocused(null);
                  commit(latest.current);
                }}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (item.text.trim() !== "") addAfter(index);
                  } else if (event.key === "Backspace" && item.text === "") {
                    event.preventDefault();
                    removeAt(index);
                  } else if (event.key === "ArrowDown" && index < items.length - 1) {
                    event.preventDefault();
                    setFocused(index + 1);
                  } else if (event.key === "ArrowUp" && index > 0) {
                    event.preventDefault();
                    setFocused(index - 1);
                  } else if (event.key === "Escape") {
                    event.stopPropagation();
                    event.currentTarget.blur();
                  }
                }}
              />
            )}
            {!readOnly && (
              <button
                type="button"
                className="todo-remove nodrag"
                aria-label={`Remove task ${index + 1}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  removeAt(index);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {readOnly && total === 0 && <div className="todo-empty">No tasks yet</div>}
    </div>
  );
}
