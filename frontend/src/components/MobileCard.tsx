import { useState } from "react";
import type { Card } from "../api/types";
import CardMarkdown from "./CardMarkdown";
import SpotifyAttachment from "./SpotifyAttachment";
import YouTubeAttachment from "./YouTubeAttachment";
import { withoutAttachmentUrls } from "../lib/urls";

function fileId(card: Card, key: string) {
  const value = card.payload[key];
  return typeof value === "string" ? value : null;
}

export default function MobileCard({ card, titleCard = false }: { card: Card; titleCard?: boolean }) {
  const [open, setOpen] = useState(false);
  const items = Array.isArray(card.payload.items) ? card.payload.items as { text?: string; done?: boolean }[] : [];
  const rows = Array.isArray(card.payload.rows) ? card.payload.rows as string[][] : [];
  const imageId = fileId(card, "image_file_id");
  const audioId = fileId(card, "audio_file_id");
  const attachmentId = fileId(card, "file_id");

  if (titleCard) {
    return <article className={`mobile-card type-${card.type} is-title`}><div className="mobile-card-heading"><span><strong>{card.title}</strong><small>heading</small></span></div></article>;
  }

  return (
    <article className={`mobile-card type-${card.type}${titleCard ? " is-title" : ""}`}>
      <button className="mobile-card-heading" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>
          <strong>{card.title || (card.type === "document" ? "Untitled document" : card.type === "checklist" ? "To-do list" : "Untitled card")}</strong>
          <small>{card.type === "text" ? "note" : card.type}</small>
        </span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="mobile-card-content">
          {imageId && <img src={`/api/files/${imageId}`} alt={card.title ?? ""} />}
          {audioId && <audio controls preload="metadata" src={`/api/files/${audioId}`} />}
          {attachmentId && <a href={`/api/files/${attachmentId}`} target="_blank" rel="noreferrer">Open attached file</a>}
          {(card.type === "link" || card.type === "youtube") && typeof card.payload.url === "string" && (
            <a href={card.payload.url} target="_blank" rel="noreferrer">{card.payload.url}</a>
          )}
          {card.type === "checklist" && <ul className="mobile-checklist">{items.map((item, index) => <li className={item.done ? "is-done" : ""} key={index}>{item.done ? "✓" : "○"} {item.text}</li>)}</ul>}
          {card.type === "table" && rows.length > 0 && <div className="mobile-table-wrap"><table><tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => r === 0 ? <th key={c}>{cell}</th> : <td key={c}>{cell}</td>)}</tr>)}</tbody></table></div>}
          {card.body && card.type !== "checklist" && card.type !== "table" && (
            <CardMarkdown body={withoutAttachmentUrls(card.body, [card.payload.spotify_url, card.payload.youtube_url])} />
          )}
          {card.type === "text" && typeof card.payload.spotify_url === "string" && <SpotifyAttachment card={card} />}
          {card.type === "text" && typeof card.payload.youtube_url === "string" && <YouTubeAttachment card={card} />}
          {!card.body && !imageId && !audioId && !attachmentId && items.length === 0 && rows.length === 0 && <p className="mobile-empty-copy">No content yet.</p>}
        </div>
      )}
    </article>
  );
}
