import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { CanvasAppearance } from "../api/types";

const VIEWPORT_GUTTER = 8;
const ANCHOR_GAP = 4;

interface Position {
  top: number;
  left: number;
  ready: boolean;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/** A menu belongs to a zoomed canvas node, but its screen position does not.
 * Rendering on document.body escapes xyflow's transformed stacking contexts;
 * measuring both surfaces lets the menu choose the visible side of its
 * anchor and stay inside every edge of the browser viewport. */
export default function FloatingCardMenu({
  anchorRef,
  open,
  onClose,
  appearance,
  children,
}: {
  anchorRef: RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  appearance: CanvasAppearance;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>({ top: 0, left: 0, ready: false });

  useLayoutEffect(() => {
    if (!open) {
      setPosition((current) =>
        current.ready ? { ...current, ready: false } : current
      );
      return;
    }

    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const menu = menuRef.current?.getBoundingClientRect();
      if (!anchor || !menu) return;

      const maxLeft = window.innerWidth - VIEWPORT_GUTTER - menu.width;
      const left = clamp(
        anchor.right - menu.width,
        VIEWPORT_GUTTER,
        maxLeft
      );
      const below = anchor.bottom + ANCHOR_GAP;
      const above = anchor.top - ANCHOR_GAP - menu.height;
      const roomBelow = window.innerHeight - VIEWPORT_GUTTER - below;
      const roomAbove = anchor.top - VIEWPORT_GUTTER - ANCHOR_GAP;
      const preferredTop =
        menu.height <= roomBelow || roomBelow >= roomAbove ? below : above;
      const top = clamp(
        preferredTop,
        VIEWPORT_GUTTER,
        window.innerHeight - VIEWPORT_GUTTER - menu.height
      );

      setPosition((current) =>
        current.ready && current.top === top && current.left === left
          ? current
          : { top, left, ready: true }
      );
    };

    place();
    const observer = new ResizeObserver(place);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !anchorRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    // A wheel gesture pans or zooms the canvas, so the anchor is about to
    // move independently of this body-level portal.
    window.addEventListener("wheel", onClose, { passive: true });
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => {
      window.removeEventListener("wheel", onClose);
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    };
  }, [anchorRef, onClose, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={menuRef}
      className={`card-menu nodrag is-floating canvas-appearance-${appearance}`}
      style={{
        top: position.top,
        left: position.left,
        visibility: position.ready ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body
  );
}
