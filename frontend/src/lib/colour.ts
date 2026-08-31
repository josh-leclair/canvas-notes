/** Colour maths for custom paints.
 *
 * Each named hue in `theme.css` was solved by hand: a fill, a border one step
 * deeper than it, and whichever of two inks stays legible on top. A colour
 * pulled off the wheel arrives with none of that, so the same three decisions
 * are made here, at paint time, from the one value the user chose.
 *
 * Nothing in this file is a design value — the two ink colours it chooses
 * between are tokens, read back out of the stylesheet. What lives here is the
 * arithmetic that picks between them.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Hue 0–360, saturation and value 0–1. The picker works in this space
 *  because a square of saturation against value is the shape people expect to
 *  drag a colour out of; storage stays hex. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

/** `#abc` or `#aabbcc`, in any case, to a canonical `#aabbcc`.
 *
 *  Anything else is not a colour and comes back null rather than being
 *  guessed at — a half-typed hex in the input box must not paint the card. */
export function normaliseHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, "").toLowerCase();
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(raw)) return null;
  const full = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw;
  return `#${full}`;
}

export function hexToRgb(hex: string): Rgb {
  const full = normaliseHex(hex) ?? "#000000";
  return {
    r: parseInt(full.slice(1, 3), 16),
    g: parseInt(full.slice(3, 5), 16),
    b: parseInt(full.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hexToHsv(hex: string): Hsv {
  return rgbToHsv(hexToRgb(hex));
}

export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(hsvToRgb(hsv));
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (n: number) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

export function contrastRatio(a: string, b: string): number {
  return contrast(hexToRgb(a), hexToRgb(b));
}

/** Which of the two fill inks to put on a colour: the same choice the named
 *  fills make, made arithmetically. White over a deep blue, near-black over a
 *  bright yellow — whichever of the two is further from the fill. */
export function inkFor(hex: string): "light" | "dark" {
  const fill = hexToRgb(hex);
  const light = tokenColour("--fill-ink-light") ?? "#ffffff";
  const dark = tokenColour("--fill-ink-dark") ?? "#000000";
  return contrast(fill, hexToRgb(light)) >= contrast(fill, hexToRgb(dark))
    ? "light"
    : "dark";
}

/** A colour some way towards black, for the border under a fill.
 *
 *  0.25 is the step the hand-solved palette already uses: `--fill-red`
 *  #ac3d39 sits against `--fill-edge-red` #872926, which is very close to
 *  three quarters of it. */
export function shade(hex: string, amount = 0.25): string {
  const { r, g, b } = hexToRgb(hex);
  const k = 1 - amount;
  return rgbToHex({ r: r * k, g: g * k, b: b * k });
}

/** A theme token's value, resolved off the document.
 *
 *  The named hues live in `theme.css` and nowhere else, so seeding the wheel
 *  from the hue a card already wears means reading it back rather than
 *  keeping a second copy of the palette here. */
export function tokenColour(name: string, scope?: HTMLElement | null): string | null {
  if (typeof document === "undefined") return null;
  const host = scope ?? document.documentElement;
  const raw = getComputedStyle(host)
    .getPropertyValue(name)
    .trim();
  const direct = raw ? normaliseHex(raw) : null;
  if (direct) return direct;

  // Custom properties may alias another token (`var(--palette-citrus)`). A
  // real colour property resolves that chain for us, inside the canvas mood
  // that owns the picker.
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = `var(${name})`;
  host.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const match = resolved.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
  return match
    ? rgbToHex({ r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) })
    : null;
}
