import type { CanvasAppearance } from "../api/types";

const APPEARANCES = new Set<CanvasAppearance>([
  "studio",
  "pantry",
  "night_garden",
]);
const APPEARANCE_CLASSES = Array.from(APPEARANCES, (appearance) =>
  `canvas-appearance-${appearance}`
);
const LIST_APPEARANCE_KEY = "canvasListAppearance";
const LIST_SURFACE_CLASS = "canvas-list-surface";

function key(canvasId: string): string {
  return `canvasAppearance:${canvasId}`;
}

export function normaliseCanvasAppearance(value: unknown): CanvasAppearance {
  return APPEARANCES.has(value as CanvasAppearance)
    ? (value as CanvasAppearance)
    : "studio";
}

export function readCanvasAppearance(canvasId: string): CanvasAppearance | null {
  return localStorage.getItem(key(canvasId)) as CanvasAppearance | null;
}

export function rememberCanvasAppearance(
  canvasId: string,
  appearance: CanvasAppearance
): void {
  localStorage.setItem(key(canvasId), appearance);
}

/** The canvas index is a workspace in its own right, so it remembers which
 * of the three visual languages the person chose for it. */
export function readCanvasListAppearance(): CanvasAppearance {
  return normaliseCanvasAppearance(localStorage.getItem(LIST_APPEARANCE_KEY));
}

export function rememberCanvasListAppearance(
  appearance: CanvasAppearance
): void {
  localStorage.setItem(LIST_APPEARANCE_KEY, appearance);
}

/**
 * Canvas dialogs and editors are portalled to the app shell or document body.
 * Mirroring the active appearance onto both ancestors lets those surfaces use
 * exactly the same semantic tokens as the canvas beneath them.
 */
export function applyCanvasSurfaceAppearance(
  appearance: CanvasAppearance,
  surface: "canvas" | "list" = "canvas"
): void {
  const targets = [
    document.documentElement,
    document.getElementById("app-shell"),
  ].filter((target): target is HTMLElement => target instanceof HTMLElement);

  for (const target of targets) {
    target.classList.remove(...APPEARANCE_CLASSES);
    target.classList.add(`canvas-appearance-${appearance}`);
    target.classList.toggle(LIST_SURFACE_CLASS, surface === "list");
  }
}
