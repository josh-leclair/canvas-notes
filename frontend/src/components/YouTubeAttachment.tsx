import { useState } from "react";
import type { Card } from "../api/types";
import Icon from "./Icon";
import "./spotifyAttachment.css";

type YouTubeData = {
  url?: unknown;
  title?: unknown;
  thumbnail_url?: unknown;
  kind?: unknown;
};

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export default function YouTubeAttachment({ card }: { card: Card }) {
  const [imageFailed, setImageFailed] = useState(false);
  const data = (card.payload.youtube ?? {}) as YouTubeData;
  const url = safeHttpUrl(data.url ?? card.payload.youtube_url);
  if (!url) return null;
  const status = String(card.payload.youtube_status ?? "");
  const thumbnail = safeHttpUrl(data.thumbnail_url);
  const title = typeof data.title === "string" ? data.title : null;

  return (
    <div className="media-attachment youtube-attachment" onDoubleClick={(event) => event.stopPropagation()}>
      {thumbnail && !imageFailed ? (
        <img src={thumbnail} alt="" draggable={false} onError={() => setImageFailed(true)} />
      ) : (
        <span className="media-attachment-mark" aria-hidden="true"><Icon name="play" /></span>
      )}
      <span className="media-attachment-copy">
        <strong>{title ?? (status === "queued" ? "Finding YouTube details…" : "Watch on YouTube")}</strong>
        <small>{status === "error" ? "YouTube link · preview unavailable" : "YouTube · Video"}</small>
      </span>
      <a
        className="media-attachment-open nodrag nopan"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="Watch on YouTube"
        aria-label="Watch on YouTube"
      >↗</a>
    </div>
  );
}
