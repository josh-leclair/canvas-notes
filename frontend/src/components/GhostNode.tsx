import { memo } from "react";
import { type NodeProps } from "@xyflow/react";
import { useNavigate } from "react-router-dom";
import { useCanvasStore } from "../store/canvasStore";
import { confirmDialog } from "../store/dialogStore";
import type { PortalNode as PortalNodeType } from "../store/revealGraph";
import SideHandles from "./SideHandles";
import "./ghostNode.css";

/** A portal: this card links somewhere that is not on this canvas.
 *
 * The whole chip is a door. Click it and you travel to the card's home canvas,
 * landing centred on the card, so following a trail of thought across canvases
 * is one click per hop. Pulling a copy onto this canvas is the secondary
 * action, tucked behind hover — canvas membership never changes by accident. */
function GhostNodeImpl({ data }: NodeProps<PortalNodeType>) {
  const addGhostToCanvas = useCanvasStore((s) => s.addGhostToCanvas);
  const deleteLink = useCanvasStore((s) => s.deleteLink);
  const navigate = useNavigate();

  const location = data.homeCanvasName ?? "Inbox";
  const canTravel = Boolean(data.homeCanvasId);

  return (
    <button
      className="portal-chip nodrag"
      title={
        canTravel
          ? `Step through to “${location}”`
          : "This card is in the inbox — drag it out to place it"
      }
      onClick={(e) => {
        e.stopPropagation();
        if (canTravel) {
          navigate(`/c/${data.homeCanvasId}?card=${data.cardId}`);
        }
      }}
    >
      <SideHandles connectable={false} className="reveal-handle" />
      <span className="portal-swirl" aria-hidden>
        <svg viewBox="0 0 24 24" width="22" height="22">
          <path
            d="M12 3a9 9 0 1 1-8.6 6.3M12 7a5 5 0 1 1-4.7 3.4M12 11a1.5 1.5 0 1 1-1.4 1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="portal-text">
        <span className="portal-title">{data.title ?? "Untitled"}</span>
        <span className="portal-where">{canTravel ? location : "Inbox"}</span>
      </span>
      <span className="portal-actions">
        <span
          className="portal-act"
          role="button"
          title="Bring onto this canvas"
          onClick={(e) => {
            e.stopPropagation();
            const el = e.currentTarget.closest(".react-flow__node") as HTMLElement | null;
            const m = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(
              el?.style.transform ?? ""
            );
            addGhostToCanvas(
              data.cardId,
              m ? parseFloat(m[1]) : 0,
              m ? parseFloat(m[2]) : 0
            );
          }}
        >
          +
        </span>
        {data.linkIds.length > 0 && (
          <span
            className="portal-act danger-act"
            role="button"
            title="Remove this link"
            onClick={async (e) => {
              e.stopPropagation();
              const many = data.linkIds.length > 1;
              const ok = await confirmDialog({
                title: many
                  ? `Remove ${data.linkIds.length} links to “${data.title ?? "this card"}”?`
                  : `Unlink “${data.title ?? "this card"}”?`,
                body: "The connection is removed. Both cards are kept.",
                confirmLabel: "Unlink",
                danger: true,
              });
              if (!ok) return;
              for (const id of data.linkIds) await deleteLink(id);
            }}
          >
            ⛌
          </span>
        )}
      </span>
    </button>
  );
}

export default memo(GhostNodeImpl);
