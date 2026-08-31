/** Cards switch to their simplified overview treatment below this zoom. */
export const CARD_OVERVIEW_ZOOM = 0.35;

/** Fallback when a client cannot report its viewport. */
export const DEFAULT_CANVAS_WIDTH = 1920;
export const DEFAULT_CANVAS_HEIGHT = 1080;

export const CANVAS_GROW_MARGIN = 240;
export const CANVAS_GROW_WIDTH = 640;
export const CANVAS_GROW_HEIGHT = 360;

/** New boards begin at roughly one screen and grow as content reaches them. */
export function initialCanvasSize() {
  return {
    width: Math.max(960, Math.round(window.innerWidth)),
    height: Math.max(640, Math.round(window.innerHeight)),
  };
}
