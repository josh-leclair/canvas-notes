export type CanvasTextSize = number;
export const MIN_CANVAS_TEXT_SIZE = 9;
export const MAX_CANVAS_TEXT_SIZE = 22;
export const DEFAULT_CANVAS_TEXT_SIZE = 13;

function key(canvasId: string): string {
  return `canvasTextSize:${canvasId}`;
}

export function normaliseCanvasTextSize(value: unknown): CanvasTextSize {
  // Carry the first preset implementation forward without making anyone
  // revisit every canvas after the control becomes numeric.
  if (value === "small") return 11;
  if (value === "standard") return DEFAULT_CANVAS_TEXT_SIZE;
  if (value === "large") return 15;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CANVAS_TEXT_SIZE;
  return Math.max(MIN_CANVAS_TEXT_SIZE, Math.min(MAX_CANVAS_TEXT_SIZE, Math.round(parsed)));
}

export function readCanvasTextSize(canvasId: string): CanvasTextSize {
  return normaliseCanvasTextSize(localStorage.getItem(key(canvasId)));
}

export function rememberCanvasTextSize(canvasId: string, size: CanvasTextSize): void {
  localStorage.setItem(key(canvasId), String(normaliseCanvasTextSize(size)));
}
