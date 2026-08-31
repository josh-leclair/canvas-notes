import { inkFor, normaliseHex, shade } from "../lib/colour";
import type { CanvasAppearance, Card } from "../api/types";

export const HUES = [
  "avocado",
  "plum",
  "linen",
  "cement",
  "maple",
  "rust",
] as const;

export const PANTRY_HUES = [
  "citrus",
  "strawberry",
  "chocolate",
  "floral",
  "blueberry",
  "ferment",
  "wine",
  "vanilla",
  "herb",
  "bay",
] as const;

export const NIGHT_GARDEN_HUES = [
  "flare",
  "sky",
  "orchid",
  "coral",
  "sprout",
  "navy",
  "mint",
  "aqua",
] as const;

const ALL_HUES = [...HUES, ...PANTRY_HUES, ...NIGHT_GARDEN_HUES] as const;
export type Hue = (typeof ALL_HUES)[number];

export function huesForAppearance(appearance: CanvasAppearance): readonly Hue[] {
  if (appearance === "pantry") return PANTRY_HUES;
  if (appearance === "night_garden") return NIGHT_GARDEN_HUES;
  return HUES;
}

/** Existing cards may still carry one of the original preset names. Keep
 * reading those values so adopting the new palette never erases old paint;
 * the picker itself offers only the six current choices above. */
const LEGACY_HUES = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "slate",
] as const;
type LegacyHue = (typeof LEGACY_HUES)[number];

/** A colour picked off the wheel, stored as a canonical `#aabbcc`.
 *
 * The named hues stay the recommended answer — each is a solved set of fill,
 * border and ink, and is legible on either theme's surface. A custom colour
 * cannot promise that, so its border and ink are derived at paint time
 * (`lib/colour.ts`) rather than looked up, and how it reads is the user's
 * call. The `#` prefix is what tells the two apart everywhere below. */
export type Custom = `#${string}`;
export type TextTone = "dark" | "light";

/** What an axis can be painted: one of the presets, or anything at all. */
export type PaintValue = Hue | LegacyHue | TextTone | Custom;

export function isCustom(value: PaintValue | null): value is Custom {
  return typeof value === "string" && value.startsWith("#");
}

/** The three things a colour can be applied to.
 *
 *  - `accent` is the bar across the top of the card.
 *  - `fill` is the card's own background.
 *  - `header` is a table's top row. Its payload key is `header_color`, not
 *    `header`: a table already stores a boolean under that name saying
 *    whether it has a header row at all, and the server's normaliser
 *    rewrote the colour to `true` every time it saved.
 *  - `ink` is the text.
 */
export type Axis = "accent" | "fill" | "header" | "ink";

/** Which axes each kind of card offers.
 *
 * Not every card wants every option. A note is mostly your own words, so it
 * takes all three. A table is a grid of other people's numbers: colouring the
 * card behind it just makes the grid harder to read, so only the text can be
 * coloured. Everything built around a piece of media — a link, an image, a
 * video, a document — gets the accent alone, which is enough to group things
 * without competing with the thumbnail it sits above.
 */
const AXES: Record<string, Axis[]> = {
  text: ["accent", "fill", "ink"],
  checklist: ["accent", "fill", "ink"],
  table: ["accent", "header", "ink"],
  column: ["fill"],
  link: ["accent"],
  image: ["accent"],
  youtube: ["accent"],
  audio: ["accent"],
  file: ["accent"],
  board: ["accent"],
  portal: ["accent"],
  document: ["accent"],
};

/** The kinds of card that wear an accent without being asked.
 *
 * A link, a photograph or a video already has something at the top of it that
 * says what it is, and the bar reinforces that grouping. A note has nothing to
 * reinforce, so it stays bare until you pick a colour yourself. */
const DEFAULT_ACCENT = new Set([
  "link",
  "youtube",
  "audio",
  "image",
  "file",
  "board",
  "portal",
  "document",
]);

export function hasAccent(card: Card, accent: PaintValue | null): boolean {
  return accent !== null || DEFAULT_ACCENT.has(card.type);
}

export function axesFor(card: Card): Axis[] {
  return AXES[card.type] ?? ["accent"];
}

/** A stored paint value, or null if the payload holds something that is not
 *  one — an old key, a truncated hex, anything hand-edited. */
function paintValue(value: unknown): PaintValue | null {
  if (typeof value !== "string") return null;
  if (
    (ALL_HUES as readonly string[]).includes(value) ||
    (LEGACY_HUES as readonly string[]).includes(value)
  )
    return value as Hue | LegacyHue;
  const hex = normaliseHex(value);
  return hex ? (hex as Custom) : null;
}

/** Text deliberately has a smaller contract than the other paint axes.
 * Legacy coloured ink remains untouched in the payload for reversibility,
 * but renders as Auto; only the two contrast-safe foregrounds are honoured. */
function textTone(value: unknown): TextTone | null {
  return value === "dark" || value === "light" ? value : null;
}

export interface Paint {
  accent: PaintValue | null;
  fill: PaintValue | null;
  header: PaintValue | null;
  ink: PaintValue | null;
}

/** `fill` keeps the old `color` key so cards painted before the axes were
 *  split still come back the colour they were left. */
export function paintOf(card: Card): Paint {
  const payload = card.payload as Record<string, unknown>;
  return {
    accent: paintValue(payload.accent),
    fill: paintValue(payload.color),
    header: paintValue(payload.header_color),
    ink: textTone(payload.ink),
  };
}

const KEYS: Record<Axis, string> = {
  accent: "accent",
  fill: "color",
  header: "header_color",
  ink: "ink",
};

export function withPaint(
  payload: Record<string, unknown>,
  axis: Axis,
  value: PaintValue | null
): Record<string, unknown> {
  const next = { ...payload };
  if (value) next[KEYS[axis]] = value;
  else delete next[KEYS[axis]];
  return next;
}

/** The colour an accent or ink value resolves to: a token for a named hue,
 *  the value itself for a custom one. */
export function lineColour(value: PaintValue): string {
  if (value === "dark" || value === "light") return `var(--fill-ink-${value})`;
  return isCustom(value) ? value : `var(--hue-${value})`;
}

/** The three properties a fill resolves to. A named hue reads all three out
 *  of the palette; a custom one keeps its own colour and has the other two
 *  derived from it. */
export function fillColours(value: PaintValue): {
  fill: string;
  edge: string;
  ink: string;
} {
  if (isCustom(value))
    return {
      fill: value,
      edge: shade(value),
      ink: `var(--fill-ink-${inkFor(value)})`,
    };
  return {
    fill: `var(--fill-${value})`,
    edge: `var(--fill-edge-${value})`,
    ink: `var(--fill-ink-${value})`,
  };
}

/** The custom properties a card's paint resolves to. Only the axes actually
 *  chosen are set, so the stylesheet can fall back to the type's own colour. */
export function paintStyle(paint: Paint): Record<string, string> {
  const style: Record<string, string> = {};
  if (paint.accent) style["--card-accent"] = lineColour(paint.accent);
  if (paint.fill) {
    const { fill, edge, ink } = fillColours(paint.fill);
    style["--card-fill"] = fill;
    style["--card-fill-edge"] = edge;
    style["--card-fill-ink"] = ink;
  }
  if (paint.header) {
    const { fill, ink } = fillColours(paint.header);
    style["--card-header"] = fill;
    style["--card-header-ink"] = ink;
  }
  if (paint.ink) style["--card-ink"] = lineColour(paint.ink);
  return style;
}
