import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Card } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import "./structuredCard.css";

const MAX_COLUMNS = 12;
const MAX_ROWS = 60;
const MIN_COLUMN_PX = 48;

export function rowsOf(card: Card): string[][] {
  const raw = (card.payload as { rows?: unknown }).rows;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? "")));
}

/** Column widths are fractions of the card, never pixels: the card can be
 *  resized, and a table whose columns were pinned in pixels would either
 *  overflow it or leave a gap down the side. */
function widthsOf(card: Card, columns: number): number[] {
  const raw = (card.payload as { widths?: unknown }).widths;
  const given = Array.isArray(raw)
    ? raw.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (given.length !== columns || columns === 0)
    return Array.from({ length: columns }, () => 1 / (columns || 1));
  const total = given.reduce((sum, w) => sum + w, 0);
  return given.map((w) => w / total);
}

/** A, B, ... Z, AA, AB. */
function columnName(index: number): string {
  let name = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1)
    name = String.fromCharCode(65 + (n % 26)) + name;
  return name;
}

/** A grid, edited as a grid.
 *
 * Unselected, the card is nothing but the table — no gutters, no buttons, no
 * hover affordances. Everything used to change its shape lives on lettered and
 * numbered tabs that appear outside the card when it is selected, the way a
 * spreadsheet puts its headers outside the sheet.
 *
 * That chrome is portalled into the xyflow node wrapper rather than drawn in
 * the card body, for two reasons: the card clips its own overflow, so tabs
 * drawn inside it would be cut off; and the wrapper already lives in canvas
 * space, so panning and zooming carry the tabs along for free.
 *
 * Growth is mostly a side effect of typing: Tab off the last cell or press
 * Enter on the last row and the row you need is already there.
 */
export default function TableCardBody({
  card,
  selected = false,
}: {
  card: Card;
  selected?: boolean;
}) {
  const updateCard = useCanvasStore((s) => s.updateCard);
  const readOnly = useCanvasStore((s) => s.role) === "viewer";
  const [rows, setRows] = useState<string[][]>(() => rowsOf(card));
  const [widths, setWidths] = useState<number[]>(() =>
    widthsOf(card, rowsOf(card)[0]?.length ?? 0)
  );
  const [editing, setEditing] = useState(false);
  const [active, setActive] = useState<{
    axis: "column" | "row";
    index: number;
  } | null>(null);

  const cells = useRef<Map<string, HTMLInputElement>>(new Map());
  const root = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLTableElement>(null);

  /* Saved on blur, read from refs: the handler closes over the values from its
   * own render, which are a keystroke behind by the time focus leaves. */
  const latest = useRef(rows);
  latest.current = rows;
  const latestWidths = useRef(widths);
  latestWidths.current = widths;

  useEffect(() => {
    if (editing) return;
    const next = rowsOf(card);
    setRows(next);
    setWidths(widthsOf(card, next[0]?.length ?? 0));
  }, [card, editing]);

  /* Typing in a cell counts as much as selecting the card. xyflow skips its
   * own selection when the pointer lands on a `nodrag` target, and the grid
   * covers nearly the whole card, so waiting on `selected` alone would hide
   * the tabs at exactly the moment they are wanted. */
  const showChrome = selected || editing;

  // Putting the tabs away leaves nothing armed behind them.
  useEffect(() => {
    if (!showChrome) setActive(null);
  }, [showChrome]);

  const columns = rows[0]?.length ?? 0;

  /* --- where to hang the tabs -------------------------------------------- */

  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost((root.current?.closest(".react-flow__node") as HTMLElement) ?? null);
  }, []);

  /* Along its own axis each bar lines up with the table, not the card: a title
   * above the grid would otherwise push every row number out of step. Across
   * that axis the bar is pushed off the card's edge instead, because the link
   * anchors live on those edges and win the hit test — the same collision the
   * column controls ran into. That cross-axis offset is written as an explicit
   * 0 and not left out: omitting it means `auto`, which drops the bar at its
   * static position — the far end of the node, on top of the last row.
   * Measured in layout pixels up the offset chain, so canvas zoom does not
   * enter into it. */
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  useLayoutEffect(() => {
    const table = grid.current;
    if (!table || !host) return;
    const measure = () => {
      let x = 0;
      let y = 0;
      let el: HTMLElement | null = table;
      while (el && el !== host) {
        x += el.offsetLeft;
        y += el.offsetTop;
        el = el.offsetParent as HTMLElement | null;
      }
      setBox({
        left: x,
        top: y,
        width: table.offsetWidth,
        height: table.offsetHeight,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    observer.observe(host);
    return () => observer.disconnect();
  }, [host, rows.length, columns]);

  /* --- edits -------------------------------------------------------------- */

  function commit(nextRows: string[][], nextWidths = latestWidths.current) {
    updateCard(card.id, {
      payload: { ...card.payload, rows: nextRows, widths: nextWidths },
    });
  }

  /* Where the caret should land once the new row or column has been drawn.
   * A requestAnimationFrame was not enough: a cell registers its ref on
   * commit, and the frame sometimes arrived first, so Tab off the last cell
   * grew the table and then left you typing in the old one. */
  const wanted = useRef<{ row: number; col: number } | null>(null);
  useEffect(() => {
    const target = wanted.current;
    if (!target) return;
    wanted.current = null;
    cells.current.get(`${target.row}:${target.col}`)?.focus();
  }, [rows]);

  function apply(
    nextRows: string[][],
    nextWidths: number[],
    focus?: { row: number; col: number }
  ) {
    if (focus) wanted.current = focus;
    setRows(nextRows);
    setWidths(nextWidths);
    latestWidths.current = nextWidths;
    commit(nextRows, nextWidths);
  }

  function addRow(at = rows.length) {
    if (rows.length >= MAX_ROWS) return;
    const next = [...rows];
    next.splice(at, 0, Array.from({ length: columns }, () => ""));
    apply(next, widths, { row: at, col: 0 });
  }

  function addColumn() {
    if (columns >= MAX_COLUMNS) return;
    // The new column takes an even share and the others give it up in
    // proportion, so a column you had widened stays the widest.
    const share = 1 / (columns + 1);
    apply(
      rows.map((row) => [...row, ""]),
      [...widths.map((w) => w * (1 - share)), share],
      { row: 0, col: columns }
    );
  }

  function removeRow(index: number) {
    if (rows.length <= 1) return;
    setActive(null);
    apply(
      rows.filter((_, i) => i !== index),
      widths
    );
  }

  function removeColumn(index: number) {
    if (columns <= 1) return;
    setActive(null);
    const kept = widths.filter((_, i) => i !== index);
    const total = kept.reduce((sum, w) => sum + w, 0) || 1;
    apply(
      rows.map((row) => row.filter((_, i) => i !== index)),
      kept.map((w) => w / total)
    );
  }

  /** Drag the seam between two lettered tabs: one column gives up exactly what
   *  the other takes, so the table always spans the card. */
  function startResize(seam: number, event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    // Capture keeps the seam from losing the pointer to whatever it slides
    // over, but it is an optimisation, not the mechanism: the drag is tracked
    // on the window so it keeps working if the browser refuses the capture.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* no capture, no matter */
    }

    const table = grid.current;
    const span = table?.offsetWidth ?? 0;
    /* The canvas is zoomed, so pointer movement arrives in screen pixels while
     * the widths are fractions of a layout-pixel table. The scale is read off
     * the element rather than the flow store — this card also renders in the
     * inbox, where there is no store to read. */
    const scale = table ? table.getBoundingClientRect().width / (span || 1) : 1;
    const startX = event.clientX;
    const start = [...widths];
    const floor = MIN_COLUMN_PX / (span || 1);

    const move = (e: PointerEvent) => {
      let delta = (e.clientX - startX) / (scale || 1) / (span || 1);
      delta = Math.max(delta, floor - start[seam]);
      delta = Math.min(delta, start[seam + 1] - floor);
      const next = [...start];
      next[seam] = start[seam] + delta;
      next[seam + 1] = start[seam + 1] - delta;
      setWidths(next);
      latestWidths.current = next;
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      commit(latest.current, latestWidths.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  }

  /** Tab walks the grid and runs off the end into a new row. */
  function step(row: number, col: number, back: boolean) {
    let r = row;
    let c = col + (back ? -1 : 1);
    if (c >= columns) {
      c = 0;
      r += 1;
    } else if (c < 0) {
      c = columns - 1;
      r -= 1;
    }
    if (r < 0) return;
    if (r >= rows.length) {
      addRow();
      return;
    }
    cells.current.get(`${r}:${c}`)?.focus();
  }

  /* --- the tabs ----------------------------------------------------------- */

  function armed(axis: "column" | "row", index: number) {
    return active?.axis === axis && active.index === index;
  }

  /** One click picks the column or row out; the tab then becomes the delete
   *  control, so nothing is ever removed by a stray single click. */
  function tabProps(axis: "column" | "row", index: number) {
    const label = axis === "column" ? columnName(index) : String(index + 1);
    const only = axis === "column" ? columns <= 1 : rows.length <= 1;
    const drop = () =>
      axis === "column" ? removeColumn(index) : removeRow(index);
    return {
      className: `table-tab${armed(axis, index) ? " is-armed" : ""}`,
      title: armed(axis, index)
        ? `Remove ${axis} ${label}`
        : `${axis === "column" ? "Column" : "Row"} ${label}`,
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
      },
      onClick: () => {
        if (armed(axis, index)) drop();
        else if (!only) setActive({ axis, index });
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          if (armed(axis, index)) drop();
        } else if (e.key === "Escape") setActive(null);
      },
      children: armed(axis, index) ? "×" : label,
    };
  }

  const chrome = (
    <div className={`table-chrome nodrag${showChrome ? " is-shown" : ""}`}>
      <div
        className="table-bar is-columns"
        style={{
          left: box.left,
          top: 0,
          width: box.width,
          gridTemplateColumns: widths.map((w) => `${w * 100}%`).join(" "),
        }}
      >
        {widths.map((_, c) => (
          <span className="table-slot" key={c}>
            <button type="button" {...tabProps("column", c)} />
            {c < widths.length - 1 && (
              <span
                className="table-seam"
                title="Drag to resize"
                onPointerDown={(e) => startResize(c, e)}
              />
            )}
          </span>
        ))}
        <button
          type="button"
          className="table-tab is-add"
          title="Add a column"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={addColumn}
          disabled={columns >= MAX_COLUMNS}
        >
          +
        </button>
      </div>

      <div
        className="table-bar is-rows"
        style={{
          left: 0,
          top: box.top,
          height: box.height,
          gridTemplateRows: `repeat(${rows.length}, 1fr)`,
        }}
      >
        {rows.map((_, r) => (
          <span className="table-slot" key={r}>
            <button type="button" {...tabProps("row", r)} />
          </span>
        ))}
        <button
          type="button"
          className="table-tab is-add"
          title="Add a row"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => addRow()}
          disabled={rows.length >= MAX_ROWS}
        >
          +
        </button>
      </div>
    </div>
  );

  return (
    <div className="table-card" ref={root}>
      <table
        className="table-grid"
        ref={grid}
        onPointerDown={() => setActive(null)}
      >
        <colgroup>
          {widths.map((w, c) => (
            <col key={c} style={{ width: `${w * 100}%` }} />
          ))}
        </colgroup>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className={r === 0 ? "is-header" : ""}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  className={
                    armed("column", c) || armed("row", r) ? "is-armed" : ""
                  }
                >
                  <input
                    ref={(el) => {
                      if (el) cells.current.set(`${r}:${c}`, el);
                      else cells.current.delete(`${r}:${c}`);
                    }}
                    className="table-cell nodrag"
                    value={cell}
                    readOnly={readOnly}
                    placeholder={r === 0 ? "Heading" : ""}
                    onChange={(e) =>
                      setRows((current) =>
                        current.map((line, ri) =>
                          ri === r
                            ? line.map((v, ci) => (ci === c ? e.target.value : v))
                            : line
                        )
                      )
                    }
                    onFocus={() => setEditing(true)}
                    onBlur={() => {
                      setEditing(false);
                      commit(latest.current);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Tab") {
                        e.preventDefault();
                        step(r, c, e.shiftKey);
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        if (r === rows.length - 1) addRow();
                        else cells.current.get(`${r + 1}:${c}`)?.focus();
                      } else if (e.key === "ArrowUp" && r > 0) {
                        e.preventDefault();
                        cells.current.get(`${r - 1}:${c}`)?.focus();
                      } else if (e.key === "ArrowDown" && r < rows.length - 1) {
                        e.preventDefault();
                        cells.current.get(`${r + 1}:${c}`)?.focus();
                      } else if (e.key === "Escape") {
                        e.stopPropagation();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {host && !readOnly && createPortal(chrome, host)}
    </div>
  );
}
