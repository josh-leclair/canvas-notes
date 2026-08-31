import { memo, useEffect, useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import type { RevealLink } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import "./linkEdge.css";

const TYPE_GLYPH: Record<string, string> = {
  touched: "·",
  references: "@",
  supports: "+",
  contradicts: "!",
  source_for: "◆",
  follows_from: "→",
  related: "~",
};

const TYPE_LABEL: Record<string, string> = {
  touched: "touched today",
  references: "references",
  supports: "supports",
  contradicts: "contradicts",
  source_for: "source for",
  follows_from: "follows from",
  related: "related",
};

/** Whether the line should draw itself on at all.
 *
 *  The stylesheet already flattens the keyframes for anyone who asks for less
 *  motion, but the arrowhead is held back in React rather than in CSS, so the
 *  same question has to be asked here. Asked once, at mount: a line that is
 *  already drawn has nothing to wait for. */
function wantsMotion(): boolean {
  return (
    typeof matchMedia !== "function" ||
    !matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** The draw duration, read back out of the stylesheet.
 *
 *  Only ever used as a backstop (see below) — the real timing is the
 *  animation's own. Reading it rather than restating it keeps `theme.css` the
 *  one place a duration is written down; the literal is a floor for the case
 *  where the token has gone missing entirely. */
function drawMs(): number {
  if (typeof document === "undefined") return 500;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--dur-draw")
    .trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return 500;
  return raw.endsWith("ms") ? value : value * 1000;
}

/** An edge with a clickable badge at its midpoint.
 *
 * The line itself is a poor click target, so the badge is the affordance: it
 * opens the details panel. A typed link says what it is, right on the line —
 * the whole point of this app is that a link carries meaning, and a bare dot
 * kept that meaning hidden until you clicked. An untyped link has nothing to
 * announce, so it stays a dot. */
function LinkEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const setSelectedLinkId = useCanvasStore((s) => s.setSelectedLinkId);
  const selectedLinkId = useCanvasStore((s) => s.selectedLinkId);
  const link = data?.link as RevealLink | undefined;

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const active = selectedLinkId === id;
  const hop = link?.hop ?? 1;

  /* The line draws itself on by animating a dash as long as the whole path.
   * The arrowhead is not part of the stroke, so without holding it back it
   * would sit waiting on the destination card before the line ever got
   * there; released on the animation's own `animationend`, it arrives with
   * the line. Timing it off the event rather than a matching number in here
   * keeps every duration in `theme.css`, where the rest of them live.
   *
   * Deliberately scoped to the mount. The path element survives a drag, so
   * dragging a revealed card moves its lines rather than redrawing them; a
   * new selection is a new reveal with new edge ids, which remounts and
   * draws again. That is the gesture this is here for. */
  const [landed, setLanded] = useState(() => !wantsMotion());

  /* `animationend` is what actually releases the arrowhead. This only covers
   * the case where the animation never runs at all — an arrowhead that never
   * arrives would be a permanent missing arrowhead, which is a far worse
   * failure than one that appears slightly late. */
  useEffect(() => {
    if (landed) return;
    const grace = (hop >= 2 ? 2 : 1) * drawMs() + 400;
    const timer = setTimeout(() => setLanded(true), grace);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hop-2 edges are context, not the subject: labelling them all turns the
  // reveal back into the hairball the dimming exists to prevent.
  const label =
    link?.link_type && (link.hop ?? 1) < 2
      ? TYPE_LABEL[link.link_type] ?? link.link_type.replace(/_/g, " ")
      : null;
  const color = (style?.stroke as string) ?? "var(--link-untyped)";

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={landed ? markerEnd : undefined}
        /* Hop 2 waits for hop 1 to finish, so the reveal travels outward from
         * the card you selected instead of arriving all at once. */
        className={`link-draw ${hop >= 2 ? "is-hop2" : ""}`}
        /* Dashes are measured against this rather than the path's real
         * length, so a short line and a long one finish together instead of
         * being drawn at the same speed. */
        pathLength={1}
        style={style}
        onAnimationEnd={() => setLanded(true)}
      />
      <EdgeLabelRenderer>
        <button
          className={`link-badge nodrag nopan ${label ? "is-labelled" : ""} ${
            active ? "is-active" : ""
          } ${hop >= 2 ? "is-hop2" : ""}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            borderColor: color,
            color,
            opacity: (style?.opacity as number) ?? 1,
          }}
          title={
            link?.link_type
              ? `${link.link_type.replace("_", " ")}${link.note ? ` — ${link.note}` : ""}`
              : "Untyped link"
          }
          onClick={(e) => {
            e.stopPropagation();
            setSelectedLinkId(id);
          }}
        >
          <span className="link-badge-glyph">
            {link?.link_type ? TYPE_GLYPH[link.link_type] ?? "·" : "·"}
          </span>
          {label && <span className="link-badge-label">{label}</span>}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export default memo(LinkEdgeImpl);
