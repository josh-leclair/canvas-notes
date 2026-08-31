import { memo, useEffect, useRef, useState } from "react";
import { type NodeProps } from "@xyflow/react";
import { useCanvasStore, type CardNode as CardNodeType } from "../store/canvasStore";
import { confirmDialog } from "../store/dialogStore";
import ColourPicker from "./ColourPicker";
import {
  axesFor,
  huesForAppearance,
  paintOf,
  paintStyle,
  withPaint,
  type Axis,
  type PaintValue,
} from "./cardPaint";
import Icon from "./Icon";
import SideHandles from "./SideHandles";
import FloatingCardMenu from "./FloatingCardMenu";
import "./columnNode.css";

/** A titled stack. Cards dropped into it flow down it in order.
 *
 * The column owns its members' geometry while they are in it, but they stay
 * real nodes — linkable, selectable, revealable — rather than becoming
 * decoration inside a parent. */
function ColumnNodeImpl({ id, data, selected }: NodeProps<CardNodeType>) {
  const { card } = data;
  const updateCard = useCanvasStore((s) => s.updateCard);
  const removePlacements = useCanvasStore((s) => s.removePlacements);
  const deleteCard = useCanvasStore((s) => s.deleteCard);
  const showToast = useCanvasStore((s) => s.showToast);
  const role = useCanvasStore((s) => s.role);
  const canvasAppearance = useCanvasStore((s) => s.canvasAppearance);
  const readOnly = role === "viewer";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const menuOpenFor = useCanvasStore((s) => s.menuOpenFor);
  const setMenuOpenFor = useCanvasStore((s) => s.setMenuOpenFor);
  const menuOpen = menuOpenFor === id;
  const closeMenu = () => setMenuOpenFor(null);

  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // A column is a container, so its colour goes on bolder than a card's: the
  // header band carries it rather than a thin spine.
  const paint = paintOf(card);
  const accent = paintStyle(paint) as React.CSSProperties;

  async function setPaint(axis: Axis, next: PaintValue | null) {
    closeMenu();
    const payload = withPaint(card.payload, axis, next);
    try {
      await updateCard(card.id, { payload });
    } catch {
      showToast("Could not change the colour");
    }
  }

  const count = data.memberCount ?? 0;

  async function save() {
    setEditing(false);
    const title = draft.trim() || null;
    if (title !== card.title) await updateCard(card.id, { title });
  }

  return (
    <>
      <SideHandles connectable={!readOnly} className="card-handle column-handle" />
      <div
        className={`column-node ${selected ? "is-selected" : ""} ${
          paint.fill ? "is-painted" : ""
        }`}
        style={accent}
      >
        <div
          className="column-header"
          onDoubleClick={(e) => {
            if (readOnly) return;
            e.stopPropagation();
            setDraft(card.title ?? "");
            setEditing(true);
          }}
        >
          {editing ? (
            <input
              ref={inputRef}
              className="nodrag"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span className="column-title">{card.title ?? "Untitled"}</span>
          )}

          {!readOnly && !editing && (
            <div className="column-menu-anchor">
              <button
                ref={menuButtonRef}
                className="column-menu-button nodrag"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpenFor(menuOpen ? null : id);
                }}
              >
                <Icon name="more" />
              </button>
              <FloatingCardMenu
                anchorRef={menuButtonRef}
                open={menuOpen}
                onClose={closeMenu}
                appearance={canvasAppearance}
              >
                  <button
                    onClick={() => {
                      closeMenu();
                      setDraft(card.title ?? "");
                      setEditing(true);
                    }}
                  >
                    Rename
                  </button>
                  <div className="card-menu-sep" />
                  <ColourPicker
                    axes={axesFor(card)}
                    paint={paint}
                    hues={huesForAppearance(canvasAppearance)}
                    onPick={setPaint}
                  />
                  <div className="card-menu-sep" />
                  <button
                    onClick={async () => {
                      closeMenu();
                      const ok = await confirmDialog({
                        title: "Remove this column?",
                        body:
                          count > 0
                            ? `The ${count} card${count === 1 ? "" : "s"} inside stay on this canvas — they simply stop being stacked.`
                            : "The empty column is removed from this canvas.",
                        confirmLabel: "Remove column",
                      });
                      if (ok) await removePlacements([id]);
                    }}
                  >
                    Remove from canvas
                  </button>
                  <button
                    className="menu-danger"
                    onClick={async () => {
                      closeMenu();
                      const ok = await confirmDialog({
                        title: `Delete “${card.title ?? "this column"}”?`,
                        body: "The cards inside are kept. Only the column is deleted, and that cannot be undone.",
                        confirmLabel: "Delete column",
                        danger: true,
                      });
                      if (ok) await deleteCard(card.id);
                    }}
                  >
                    Delete column…
                  </button>
              </FloatingCardMenu>
            </div>
          )}
        </div>

        {/* Where the card you are dragging will land. The column already
            knew the slot — it just never showed it. */}
        {data.dropY != null && (
          <div className="column-drop-line" style={{ top: data.dropY }} />
        )}

        {count === 0 && (
          <div className="column-empty">Drop cards here to stack them</div>
        )}
      </div>
    </>
  );
}

export default memo(ColumnNodeImpl);
