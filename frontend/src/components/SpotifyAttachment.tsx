import { useState } from "react";
import type { Card } from "../api/types";
import Icon from "./Icon";
import "./spotifyAttachment.css";

type SpotifyData = {
  url?: unknown;
  title?: unknown;
  thumbnail_url?: unknown;
  kind?: unknown;
};

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export default function SpotifyAttachment({
  card,
  standalone = false,
}: {
  card: Card;
  standalone?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const stored = card.payload.spotify as SpotifyData | undefined;
  const unfurl = card.payload.unfurl as { title?: unknown; image?: unknown } | undefined;
  const data = stored ?? {
    url: card.payload.url,
    title: unfurl?.title,
    thumbnail_url: unfurl?.image,
    kind: "Track",
  };
  const url = safeHttpUrl(data.url ?? card.payload.spotify_url ?? card.payload.url);
  if (!url) return null;

  const status = String(card.payload.spotify_status ?? "");
  const title = typeof data.title === "string" ? data.title : null;
  const kind = typeof data.kind === "string" ? data.kind : "Spotify";
  const thumbnail = safeHttpUrl(data.thumbnail_url);

  return (
    <div
      className={`media-attachment spotify-attachment${standalone ? " is-standalone" : ""}`}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {thumbnail && !imageFailed ? (
        <img src={thumbnail} alt="" draggable={false} onError={() => setImageFailed(true)} />
      ) : (
        <span className="media-attachment-mark" aria-hidden="true">
          <Icon name="audio" />
        </span>
      )}
      <span className="media-attachment-copy">
        <strong>{title ?? (status === "queued" ? "Finding Spotify details…" : "Open in Spotify")}</strong>
        <small>{status === "error" ? "Spotify link · preview unavailable" : `Spotify · ${kind}`}</small>
      </span>
      <a
        className="media-attachment-open nodrag nopan"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="Open in Spotify"
        aria-label="Open in Spotify"
      >↗</a>
    </div>
  );
}
