import type { CanvasAppearance } from "../api/types";

const APPEARANCES = new Set<CanvasAppearance>([
  "studio",
  "pantry",
  "night_garden",
]);

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
