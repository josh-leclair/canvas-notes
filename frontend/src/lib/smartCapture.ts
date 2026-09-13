import type { Card, CardType } from "../api/types";
import { URL_PATTERN, YOUTUBE_PATTERN } from "./urls";

export type CaptureDraftType = Extract<
  CardType,
  "text" | "document" | "checklist" | "link" | "youtube" | "image" | "audio" | "file"
>;

export interface CaptureDraft {
  id: string;
  type: CaptureDraftType;
  title: string;
  body: string;
  file?: File;
  crop?: ImageCrop;
}

export interface ImageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const SMART_CAPTURE_PLACE_EVENT = "canvas-notes:smart-capture-place";

export interface SmartCapturePlaceDetail {
  cardIds: string[];
  organize: boolean;
}

const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)]|\[[ xX]\])\s+(.+)$/;

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function urlDraft(url: string): CaptureDraft {
  return {
    id: id(),
    type: YOUTUBE_PATTERN.test(url) ? "youtube" : "link",
    title: "",
    body: url,
  };
}

/** Turn clipboard text into a small, predictable review batch. We split a
 * list of URLs because each can unfurl independently, and recognise explicit
 * bullets as one checklist. Ordinary prose remains one note, including its
 * paragraph breaks, rather than unexpectedly exploding into many cards. */
export function captureDraftsFromText(value: string): CaptureDraft[] {
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  if (lines.length > 1 && lines.every((line) => URL_PATTERN.test(line))) {
    return lines.map(urlDraft);
  }
  if (URL_PATTERN.test(text)) return [urlDraft(text)];

  const listItems = lines.map((line) => line.match(LIST_ITEM)?.[1]?.trim() ?? null);
  if (listItems.length > 1 && listItems.every(Boolean)) {
    return [{
      id: id(),
      type: "checklist",
      title: "Checklist",
      body: listItems.join("\n"),
    }];
  }

  const firstBreak = text.indexOf("\n");
  const firstLine = firstBreak >= 0 ? text.slice(0, firstBreak).trim() : "";
  const firstLineLooksLikeTitle =
    firstBreak >= 0 && firstLine.length > 0 && firstLine.length <= 72;
  return [{
    id: id(),
    type: "text",
    title: firstLineLooksLikeTitle ? firstLine : "",
    body: firstLineLooksLikeTitle ? text.slice(firstBreak + 1).trim() : text,
  }];
}

export function captureDraftsFromFiles(files: Iterable<File>): CaptureDraft[] {
  return Array.from(files).map((file) => {
    const type = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("audio/")
        ? "audio"
        : "file";
    return {
      id: id(),
      type,
      // The filename remains visible beside the preview. An image title is
      // editorial metadata, so choosing a file must not silently invent one.
      title: type === "image" ? "" : file.name,
      body: "",
      file,
    };
  });
}

function normal(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function duplicateForDraft(
  draft: CaptureDraft,
  existing: Card[]
): Card | undefined {
  if (draft.file) {
    return existing.find((card) =>
      normal(String(card.payload.file_name ?? card.title ?? "")) === normal(draft.file?.name)
    );
  }
  if (draft.type === "link" || draft.type === "youtube") {
    return existing.find((card) => normal(String(card.payload.url ?? "")) === normal(draft.body));
  }
  const title = normal(draft.title);
  const body = normal(draft.body);
  if (!title && !body) return undefined;
  return existing.find((card) => normal(card.title) === title && normal(card.body) === body);
}

export function captureTypeLabel(type: CaptureDraftType): string {
  return {
    text: "Note",
    document: "Document",
    checklist: "To-do",
    link: "Link",
    youtube: "YouTube",
    image: "Image",
    audio: "Audio",
    file: "File",
  }[type];
}

export function captureTypeIcon(type: CaptureDraftType) {
  if (type === "text" || type === "link" || type === "youtube") return "note" as const;
  return type;
}
