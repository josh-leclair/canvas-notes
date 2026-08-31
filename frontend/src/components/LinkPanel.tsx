import { useEffect, useState } from "react";
import { LINK_TYPES, type LinkType } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import { confirmDialog } from "../store/dialogStore";
import "./linkPanel.css";

/** Editor for the selected link: type, note, delete. The reason field is
 * optional and addable later, so it lives here rather than in creation. */
export default function LinkPanel() {
  const selectedLinkId = useCanvasStore((s) => s.selectedLinkId);
  const setSelectedLinkId = useCanvasStore((s) => s.setSelectedLinkId);
  const reveal = useCanvasStore((s) => s.reveal);
  const updateLink = useCanvasStore((s) => s.updateLink);
  const flipLink = useCanvasStore((s) => s.flipLink);
  const deleteLink = useCanvasStore((s) => s.deleteLink);

  const link = reveal?.links.find((l) => l.id === selectedLinkId) ?? null;
  const [note, setNote] = useState("");

  useEffect(() => {
    setNote(link?.note ?? "");
  }, [link?.id, link?.note]);

  if (!link) return null;

  const sourceTitle =
    (link.source_card_id && reveal?.cards[link.source_card_id]?.card.title) ||
    link.source_snapshot.title ||
    "Untitled";
  const targetTitle =
    (link.target_card_id && reveal?.cards[link.target_card_id]?.card.title) ||
    link.target_snapshot.title ||
    "Untitled";

  return (
    <div className="link-panel">
      <div className="link-panel-header">
        {/* The arrow between the two titles is the control: direction is the
            thing it already draws, so turning it around is the obvious way to
            ask for the link to be turned around. */}
        <span className="link-endpoints">
          <span className="link-end">{sourceTitle}</span>
          <button
            className="link-flip"
            title={`Point it the other way: ${targetTitle} → ${sourceTitle}`}
            aria-label="Switch direction"
            onClick={() => flipLink(link.id)}
          >
            →
          </button>
          <span className="link-end">{targetTitle}</span>
        </span>
        <button onClick={() => setSelectedLinkId(null)}>✕</button>
      </div>
      <div className="link-panel-row">
        {LINK_TYPES.map((type) => (
          <button
            key={type}
            className={`link-type-chip ${link.link_type === type ? "is-active" : ""}`}
            style={{ borderColor: `var(--link-${type})` }}
            onClick={() =>
              updateLink(link.id, {
                link_type: link.link_type === type ? null : (type as LinkType),
              })
            }
          >
            {type.replace("_", " ")}
          </button>
        ))}
      </div>
      <textarea
        placeholder="Why are these connected?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note !== (link.note ?? "")) updateLink(link.id, { note: note || null });
        }}
        rows={2}
      />
      <div className="link-panel-row">
        <span className="link-meta">
          linked {new Date(link.created_at).toLocaleDateString()}
        </span>
        <button
          className="danger"
          onClick={async () => {
            const ok = await confirmDialog({
              title: "Delete this link?",
              body: `The connection between “${sourceTitle}” and “${targetTitle}” will be removed. Both cards are kept.`,
              confirmLabel: "Delete link",
              danger: true,
            });
            if (ok) deleteLink(link.id);
          }}
        >
          Delete link
        </button>
      </div>
    </div>
  );
}
