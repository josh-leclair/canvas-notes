async function canvasNotesSelectRegion() {
  "use strict";

  const existing = document.getElementById("canvas-notes-region-selector");
  if (existing) existing.remove();

  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.id = "canvas-notes-region-selector";
    host.style.cssText = [
      "all:initial",
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "cursor:crosshair",
      "touch-action:none",
      "user-select:none",
    ].join(";");

    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { color-scheme: light dark; }
      .shade { position: fixed; inset: 0; background: rgba(7, 12, 20, .34); }
      .hint {
        position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
        padding: 9px 13px; border-radius: 8px; color: #fff;
        background: rgba(20, 25, 34, .94); box-shadow: 0 3px 16px rgba(0,0,0,.28);
        font: 600 13px/1.35 system-ui, sans-serif; white-space: nowrap;
      }
      .selection {
        position: fixed; display: none; box-sizing: border-box;
        border: 2px solid #fff; background: transparent;
        box-shadow: 0 0 0 1px rgba(20, 25, 34, .9), 0 0 0 9999px rgba(7, 12, 20, .38);
      }
      .size {
        position: absolute; right: -1px; bottom: -27px; padding: 3px 6px;
        border-radius: 4px; color: #fff; background: rgba(20, 25, 34, .94);
        font: 500 11px/1.3 system-ui, sans-serif; white-space: nowrap;
      }
    `;
    const shade = document.createElement("div");
    shade.className = "shade";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Drag to select an area · Esc to cancel";
    const selection = document.createElement("div");
    selection.className = "selection";
    const size = document.createElement("span");
    size.className = "size";
    selection.append(size);
    shadow.append(style, shade, hint, selection);
    document.documentElement.append(host);

    let start = null;
    let pointerId = null;

    const point = (event) => ({
      x: Math.max(0, Math.min(innerWidth, event.clientX)),
      y: Math.max(0, Math.min(innerHeight, event.clientY)),
    });

    const rectangle = (end) => {
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      return {
        x,
        y,
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      };
    };

    const draw = (rect) => {
      selection.style.display = "block";
      selection.style.left = `${rect.x}px`;
      selection.style.top = `${rect.y}px`;
      selection.style.width = `${rect.width}px`;
      selection.style.height = `${rect.height}px`;
      size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    };

    const finish = (result) => {
      window.removeEventListener("keydown", onKeyDown, true);
      host.remove();
      resolve(result);
    };

    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    };

    host.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      start = point(event);
      pointerId = event.pointerId;
      host.setPointerCapture(pointerId);
      draw({ x: start.x, y: start.y, width: 0, height: 0 });
    });

    host.addEventListener("pointermove", (event) => {
      if (!start || event.pointerId !== pointerId) return;
      event.preventDefault();
      draw(rectangle(point(event)));
    });

    host.addEventListener("pointerup", (event) => {
      if (!start || event.pointerId !== pointerId) return;
      event.preventDefault();
      const rect = rectangle(point(event));
      if (rect.width < 8 || rect.height < 8) {
        start = null;
        selection.style.display = "none";
        hint.textContent = "Select an area at least 8 × 8 pixels · Esc to cancel";
        return;
      }
      finish({
        ...rect,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
      });
    });

    host.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });

    window.addEventListener("keydown", onKeyDown, true);
  });
}
