import { memo } from "react";
import { type NodeProps } from "@xyflow/react";
import { useCanvasStore } from "../store/canvasStore";
import type { TombstoneNode as TombstoneNodeType } from "../store/revealGraph";
import SideHandles from "./SideHandles";
import "./ghostNode.css";

/** An echo: a link whose endpoint no longer exists, drawn from its snapshot.
 * One click rebuilds the card from what was remembered about it. */
function TombstoneNodeImpl({ data }: NodeProps<TombstoneNodeType>) {
  const recreateFromTombstone = useCanvasStore((s) => s.recreateFromTombstone);
  const linked = new Date(data.linkedAt).toLocaleDateString();

  return (
    <button
      className="portal-chip echo-chip nodrag"
      title={
        (data.note ? `“${data.note}” — ` : "") +
        `linked ${linked}. Click to recreate from the snapshot.`
      }
      onClick={(e) => {
        e.stopPropagation();
        recreateFromTombstone(data.linkId, data.side);
      }}
    >
      <SideHandles connectable={false} className="reveal-handle" />
      <span className="portal-swirl echo-swirl" aria-hidden>
        <svg viewBox="0 0 24 24" width="22" height="22">
          <path
            d="M4 12a8 8 0 1 1 2.3 5.6M4 12l-1.5-3M4 12l3-1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="portal-text">
        <span className="portal-title">{data.snapshot.title ?? "Untitled"}</span>
        <span className="portal-where">gone · click to recreate</span>
      </span>
    </button>
  );
}

export default memo(TombstoneNodeImpl);
