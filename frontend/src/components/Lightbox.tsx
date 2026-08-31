import { useEffect, useState } from "react";
import { useCanvasStore } from "../store/canvasStore";
import "./lightbox.css";

/** Focused view for media that is unreadable at card size.
 *
 * It grows out of the card's on-screen rectangle so the connection to the
 * card stays visible, rather than teleporting to the middle of nowhere. The
 * canvas viewport is deliberately left alone: zooming the board to frame a
 * card would give a video whatever aspect ratio the card happens to have,
 * and would leave a viewport to restore on close. */
export default function Lightbox() {
  const media = useCanvasStore((s) => s.lightbox);
  const close = useCanvasStore((s) => s.closeLightbox);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!media) {
      setOpen(false);
      return;
    }
    // One frame at the origin rect, then animate to full size.
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, [media]);

  useEffect(() => {
    if (!media) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [media, close]);

  if (!media) return null;

  const origin = media.origin;
  const startStyle = origin
    ? {
        // Collapse toward the card's centre before expanding.
        transformOrigin: `${origin.x + origin.width / 2}px ${
          origin.y + origin.height / 2
        }px`,
      }
    : undefined;

  return (
    <div className="lightbox-backdrop" onClick={close} style={startStyle}>
      <div
        className={`lightbox-stage ${open ? "is-open" : ""} ${
          media.kind === "video" ? "is-video" : "is-image"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {media.kind === "video" ? (
          <div className="lightbox-frame">
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${media.videoId}?autoplay=1&rel=0`}
              title={media.title ?? "Video"}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          </div>
        ) : (
          <img src={media.src} alt={media.title ?? ""} />
        )}

        <div className="lightbox-bar">
          <span className="lightbox-title">{media.title}</span>
          <button onClick={close} title="Close (Esc)">
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
