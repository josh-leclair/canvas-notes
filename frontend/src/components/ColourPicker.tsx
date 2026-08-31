import { useEffect, useRef, useState } from "react";
import {
  HUES,
  fillColours,
  isCustom,
  lineColour,
  type Axis,
  type Paint,
  type PaintValue,
  type TextTone,
  type Hue,
} from "./cardPaint";
import {
  hexToHsv,
  hsvToHex,
  normaliseHex,
  tokenColour,
  contrastRatio,
  type Hsv,
} from "../lib/colour";

const LABEL: Record<Axis, string> = {
  accent: "Accent",
  fill: "Card",
  header: "Header row",
  ink: "Text",
};

/** An axis that paints a surface, and so resolves three colours rather than
 *  one. `header` styles itself as a fill throughout. */
const IS_FILL: Record<Axis, boolean> = {
  accent: false,
  fill: true,
  header: true,
  ink: false,
};

/** The swatch shows what the choice will actually look like: a bar for the
 *  accent, the card's own background for the fill, a letter for the text. */
function swatchStyle(axis: Axis, value: PaintValue): React.CSSProperties {
  if (IS_FILL[axis]) {
    const { fill, edge } = fillColours(value);
    return { background: fill, borderColor: edge };
  }
  if (axis === "ink") return { color: lineColour(value) };
  return { background: lineColour(value) };
}

/** Where the wheel should open: on the colour the axis is already wearing.
 *
 *  A named hue is resolved back out of the stylesheet rather than duplicated
 *  here, so the palette stays in one file. */
function seedOf(axis: Axis, value: PaintValue | null): string {
  const prefix = IS_FILL[axis] ? "--fill-" : "--hue-";
  return (
    (value && isCustom(value) ? value : null) ??
    (value ? tokenColour(`${prefix}${value}`) : null) ??
    tokenColour(`${prefix}avocado`) ??
    "#c0c26b"
  );
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** A colour wheel for one axis: saturation against brightness, a hue strip,
 *  and the hex if you already know the one you want.
 *
 *  Committed on release rather than on every pixel of the drag — a commit is
 *  a write to the card, and one drag across the square passes through a few
 *  hundred colours. What moves live is the preview here; the card catches up
 *  the moment you let go.
 */
function CustomPaint({
  axis,
  value,
  onPick,
}: {
  axis: Axis;
  value: PaintValue | null;
  onPick: (value: string) => void;
}) {
  const [hsv, setHsvState] = useState<Hsv>(() => hexToHsv(seedOf(axis, value)));
  const [draft, setDraft] = useState(() => seedOf(axis, value));
  /* The pointer handlers commit on release, by which time a state update from
   * the same gesture has not necessarily landed. The ref is what they read. */
  const hsvRef = useRef(hsv);
  const svRef = useRef<HTMLDivElement>(null);
  /* Whether the square is being dragged is tracked here rather than read back
   * off `hasPointerCapture`. Capture is what keeps the drag alive once the
   * pointer leaves the square; if it is ever refused, the drag should degrade
   * to one that stops at the edge, not stop working. */
  const draggingRef = useRef(false);

  const hex = hsvToHex(hsv);
  const ink = IS_FILL[axis] ? fillColours(hex as PaintValue).ink : hex;

  function setHsv(next: Hsv) {
    hsvRef.current = next;
    setHsvState(next);
    setDraft(hsvToHex(next));
  }

  function commit() {
    onPick(hsvToHex(hsvRef.current));
  }

  function svAt(e: { clientX: number; clientY: number }) {
    const rect = svRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHsv({
      ...hsvRef.current,
      s: clamp01((e.clientX - rect.left) / rect.width),
      v: 1 - clamp01((e.clientY - rect.top) / rect.height),
    });
  }

  function commitHex(text: string) {
    const next = normaliseHex(text);
    if (!next) {
      setDraft(hex); // Not a colour: put the box back rather than paint junk.
      return;
    }
    setHsv(hexToHsv(next));
    onPick(next);
  }

  const NUDGE: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, 1],
    ArrowDown: [0, -1],
  };

  return (
    <div className="paint-custom" onClick={(e) => e.stopPropagation()}>
      <div
        ref={svRef}
        className="paint-sv"
        style={
          { "--paint-wheel": `hsl(${hsv.h} 100% 50%)` } as React.CSSProperties
        }
        tabIndex={0}
        role="group"
        aria-label="Saturation and brightness"
        onPointerDown={(e) => {
          e.stopPropagation();
          draggingRef.current = true;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* Capture is an improvement, not a requirement. */
          }
          svAt(e);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) svAt(e);
        }}
        onPointerUp={(e) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
          commit();
        }}
        onPointerCancel={() => {
          // The preview has already moved; leaving the card behind it would
          // read as the pick having been lost.
          if (!draggingRef.current) return;
          draggingRef.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          const move = NUDGE[e.key];
          if (!move) return;
          e.preventDefault();
          const step = e.shiftKey ? 0.1 : 0.02;
          setHsv({
            ...hsvRef.current,
            s: clamp01(hsvRef.current.s + move[0] * step),
            v: clamp01(hsvRef.current.v + move[1] * step),
          });
          commit();
        }}
      >
        <span
          className="paint-sv-thumb"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            background: hex,
          }}
        />
      </div>

      {/* A range input rather than a second hand-built track: hue is the axis
          people reach for with the arrow keys, and this gets that, the drag,
          and a focus ring for free. */}
      <input
        className="paint-hue"
        type="range"
        min={0}
        max={359}
        step={1}
        value={Math.round(hsv.h)}
        aria-label="Hue"
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) =>
          setHsv({ ...hsvRef.current, h: Number(e.target.value) })
        }
        onPointerUp={commit}
        onKeyUp={commit}
      />

      <div className="paint-hex">
        <span className="paint-hex-preview" style={{ background: hex, color: ink }}>
          Aa
        </span>
        <input
          value={draft}
          spellCheck={false}
          maxLength={7}
          aria-label="Hex colour"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commitHex(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitHex(e.currentTarget.value);
            if (e.key === "Escape") setDraft(hex);
          }}
        />
      </div>
    </div>
  );
}

/** Colour, in as many axes as the card type offers.
 *
 * The named hues come first and are still the answer most of the time: each
 * one is a solved set — a fill, a border one step deeper, and the ink that
 * stays readable on it — fixed across both themes. The wheel at the end of
 * the row is for when none of the six is the colour you meant. Its border
 * and ink are derived from whatever you pick, so a custom card is still
 * readable; whether the colour itself sits well on both surfaces is then your
 * call rather than the palette's.
 */
export default function ColourPicker({
  axes,
  paint,
  onPick,
  hues = HUES,
}: {
  axes: Axis[];
  paint: Paint;
  onPick: (axis: Axis, value: PaintValue | null) => void;
  hues?: readonly Hue[];
}) {
  // One wheel at a time: four of them open at once is taller than the card.
  const [wheelFor, setWheelFor] = useState<Axis | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [safeInk, setSafeInk] = useState<Record<TextTone, boolean>>({
    dark: true,
    light: true,
  });

  useEffect(() => {
    const host = pickerRef.current;
    if (!host) return;
    const fill = paint.fill
      ? isCustom(paint.fill)
        ? paint.fill
        : tokenColour(`--fill-${paint.fill}`, host)
      : tokenColour("--bg-card", host);
    const dark = tokenColour("--fill-ink-dark", host);
    const light = tokenColour("--fill-ink-light", host);
    if (!fill || !dark || !light) return;
    setSafeInk({
      dark: contrastRatio(fill, dark) >= 4.5,
      light: contrastRatio(fill, light) >= 4.5,
    });
  }, [paint.fill, hues]);

  return (
    <div className="paint-picker" ref={pickerRef}>
      {axes.map((axis) => {
        const chosen = paint[axis];
        const custom = isCustom(chosen);
        return (
          <div className="paint-axis" key={axis}>
            <span className="paint-axis-label">{LABEL[axis]}</span>
            {axis === "ink" ? (
              <div className="paint-ink-options">
                <button
                  className={!chosen ? "is-active" : ""}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPick("ink", null);
                  }}
                >
                  Auto
                </button>
                {(["dark", "light"] as const).map((tone) => (
                  <button
                    key={tone}
                    className={chosen === tone ? "is-active" : ""}
                    disabled={!safeInk[tone]}
                    title={
                      safeInk[tone]
                        ? `${tone[0].toUpperCase() + tone.slice(1)} text`
                        : `Not enough contrast with this card fill`
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      onPick("ink", tone);
                    }}
                  >
                    {tone[0].toUpperCase() + tone.slice(1)}
                  </button>
                ))}
              </div>
            ) : (
            <>
              <div className="paint-row">
              <button
                className={`paint-swatch paint-none ${chosen ? "" : "is-active"}`}
                title="Default"
                onClick={(e) => {
                  e.stopPropagation();
                  setWheelFor(null);
                  onPick(axis, null);
                }}
              >
                ✕
              </button>
              {hues.map((hue) => (
                <button
                  key={hue}
                  className={`paint-swatch is-${IS_FILL[axis] ? "fill" : axis} ${
                    chosen === hue ? "is-active" : ""
                  }`}
                  style={swatchStyle(axis, hue)}
                  title={hue[0].toUpperCase() + hue.slice(1)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setWheelFor(null);
                    onPick(axis, hue);
                  }}
                >
                  {""}
                </button>
              ))}
              <button
                className={`paint-swatch paint-wheel is-${
                  IS_FILL[axis] ? "fill" : axis
                } ${custom ? "is-custom is-active" : ""} ${
                  wheelFor === axis ? "is-open" : ""
                }`}
                style={custom ? swatchStyle(axis, chosen) : undefined}
                title={custom ? `Custom (${chosen})` : "Custom colour…"}
                aria-expanded={wheelFor === axis}
                onClick={(e) => {
                  e.stopPropagation();
                  setWheelFor(wheelFor === axis ? null : axis);
                }}
              >
                {""}
              </button>
              </div>
              {wheelFor === axis && (
                <CustomPaint
                  axis={axis}
                  value={chosen}
                  onPick={(next) => onPick(axis, next as PaintValue)}
                />
              )}
            </>
            )}
          </div>
        );
      })}
    </div>
  );
}
