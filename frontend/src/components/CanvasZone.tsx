import { useReactFlow } from "@xyflow/react";
import type { Zone } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import { confirmDialog, promptDialog } from "../store/dialogStore";
import "./canvasZone.css";

export default function CanvasZone({ zone, readOnly }: { zone: Zone; readOnly: boolean }) {
  const { screenToFlowPosition } = useReactFlow();
  const setGeometry = useCanvasStore((state) => state.setZoneGeometry);
  const updateZone = useCanvasStore((state) => state.updateZone);
  const deleteZone = useCanvasStore((state) => state.deleteZone);
  const canvasInfinite = useCanvasStore((state) => state.canvasInfinite);
  const canvasWidth = useCanvasStore((state) => state.canvasWidth);
  const canvasHeight = useCanvasStore((state) => state.canvasHeight);

  function constrain(geometry: { x: number; y: number; w: number; h: number }) {
    if (canvasInfinite) return geometry;
    const w = Math.min(geometry.w, canvasWidth);
    const h = Math.min(geometry.h, canvasHeight);
    return {
      w,
      h,
      x: Math.max(0, Math.min(geometry.x, canvasWidth - w)),
      y: Math.max(0, Math.min(geometry.y, canvasHeight - h)),
    };
  }

  function begin(event: React.PointerEvent, mode: "move" | "resize") {
    if (readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    const start = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const original = { x: zone.x, y: zone.y, w: zone.w, h: zone.h };
    let latest = original;

    const move = (pointer: PointerEvent) => {
      const current = screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
      const dx = current.x - start.x;
      const dy = current.y - start.y;
      latest = constrain(mode === "move"
        ? { ...original, x: original.x + dx, y: original.y + dy }
        : { ...original, w: Math.max(180, original.w + dx), h: Math.max(140, original.h + dy) });
      setGeometry(zone.id, latest);
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      void updateZone(zone.id, latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  }

  async function rename(event: React.MouseEvent) {
    event.stopPropagation();
    const name = await promptDialog({ title: "Rename zone", label: "Name", initial: zone.name, confirmLabel: "Rename" });
    if (name && name !== zone.name) await updateZone(zone.id, { name });
  }

  async function remove(event: React.MouseEvent) {
    event.stopPropagation();
    const ok = await confirmDialog({ title: `Delete “${zone.name}”?`, body: "The cards stay exactly where they are.", confirmLabel: "Delete zone", danger: true });
    if (ok) await deleteZone(zone.id);
  }

  return (
    <section className="canvas-zone" style={{ transform: `translate(${zone.x}px, ${zone.y}px)`, width: zone.w, height: zone.h }}>
      <header className="canvas-zone-title" onPointerDown={(event) => begin(event, "move")}>
        <strong>{zone.name}</strong>
        {!readOnly && <span className="canvas-zone-actions">
          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={rename} title="Rename zone">✎</button>
          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={remove} title="Delete zone">×</button>
        </span>}
      </header>
      {!readOnly && <button className="canvas-zone-resize" type="button" aria-label={`Resize ${zone.name}`} onPointerDown={(event) => begin(event, "resize")} />}
    </section>
  );
}
