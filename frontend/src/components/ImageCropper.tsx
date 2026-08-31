import { useEffect, useRef, useState } from "react";
import "./imageCropper.css";

export interface Crop {
  /** All four are fractions of the natural image, 0–1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 };

type Handle = "nw" | "ne" | "sw" | "se" | "move";

const MIN_SIZE = 0.06;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Pick a rectangle out of an image, without touching the image.
 *
 * The result is stored as fractions of the original on the card, so the file
 * on disk is never rewritten and "revert to original" is just deleting the
 * crop. That also means a crop survives being re-cropped: every drag starts
 * from the whole picture again rather than compounding on the last one.
 */
export default function ImageCropper({
  src,
  initial,
  onCancel,
  onApply,
}: {
  src: string;
  initial: Crop | null;
  onCancel: () => void;
  onApply: (crop: Crop | null) => void;
}) {
  const [crop, setCrop] = useState<Crop>(initial ?? FULL_CROP);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ handle: Handle; startX: number; startY: number; from: Crop } | null>(
    null
  );

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = dragRef.current;
      const frame = frameRef.current;
      if (!drag || !frame) return;
      const box = frame.getBoundingClientRect();
      const dx = (e.clientX - drag.startX) / box.width;
      const dy = (e.clientY - drag.startY) / box.height;
      const from = drag.from;

      if (drag.handle === "move") {
        setCrop({
          ...from,
          x: clamp(from.x + dx, 0, 1 - from.w),
          y: clamp(from.y + dy, 0, 1 - from.h),
        });
        return;
      }

      // Corner drags move two edges; the opposite corner stays put.
      let { x, y, w, h } = from;
      if (drag.handle === "nw" || drag.handle === "sw") {
        const nx = clamp(from.x + dx, 0, from.x + from.w - MIN_SIZE);
        w = from.x + from.w - nx;
        x = nx;
      } else {
        w = clamp(from.w + dx, MIN_SIZE, 1 - from.x);
      }
      if (drag.handle === "nw" || drag.handle === "ne") {
        const ny = clamp(from.y + dy, 0, from.y + from.h - MIN_SIZE);
        h = from.y + from.h - ny;
        y = ny;
      } else {
        h = clamp(from.h + dy, MIN_SIZE, 1 - from.y);
      }
      setCrop({ x, y, w, h });
    }

    function onUp() {
      dragRef.current = null;
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function start(handle: Handle, e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { handle, startX: e.clientX, startY: e.clientY, from: crop };
  }

  const untouched = crop.w >= 0.999 && crop.h >= 0.999;
  const box = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.w * 100}%`,
    height: `${crop.h * 100}%`,
  };

  return (
    <div className="cropper-backdrop" onPointerDown={onCancel}>
      <div className="cropper-stage" onPointerDown={(e) => e.stopPropagation()}>
        <div className="cropper-frame" ref={frameRef}>
          <img src={src} alt="" draggable={false} />
          {/* Four shades rather than one box-shadow, so the dimming stays put
              when the crop is dragged to an edge. */}
          <div className="cropper-shade" style={{ inset: `0 0 ${(1 - crop.y) * 100}% 0` }} />
          <div
            className="cropper-shade"
            style={{ inset: `${(crop.y + crop.h) * 100}% 0 0 0` }}
          />
          <div
            className="cropper-shade"
            style={{
              inset: `${crop.y * 100}% ${(1 - crop.x) * 100}% ${
                (1 - crop.y - crop.h) * 100
              }% 0`,
            }}
          />
          <div
            className="cropper-shade"
            style={{
              inset: `${crop.y * 100}% 0 ${(1 - crop.y - crop.h) * 100}% ${
                (crop.x + crop.w) * 100
              }%`,
            }}
          />
          <div
            className="cropper-box"
            style={box}
            onPointerDown={(e) => start("move", e)}
          >
            {(["nw", "ne", "sw", "se"] as const).map((handle) => (
              <span
                key={handle}
                className={`cropper-handle is-${handle}`}
                onPointerDown={(e) => start(handle, e)}
              />
            ))}
          </div>
        </div>

        <div className="cropper-bar">
          <span className="cropper-hint">
            Drag the corners. The original is kept, so this can be undone.
          </span>
          <div className="cropper-actions">
            {initial && (
              <button onClick={() => onApply(null)}>Revert to original</button>
            )}
            <button onClick={onCancel}>Cancel</button>
            <button
              className="primary"
              disabled={untouched && !initial}
              onClick={() => onApply(untouched ? null : crop)}
            >
              Apply crop
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
