export const URL_PATTERN = /^https?:\/\/\S+$/i;
export const YOUTUBE_PATTERN =
  /(?:youtube\.com\/(?:watch|shorts|embed)|youtu\.be\/)/i;
export const SPOTIFY_PATTERN =
  /(?:open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:track|album|playlist|episode|show|artist)\/|spotify\.link\/)/i;

export function isSpotifyUrl(value: unknown): value is string {
  return typeof value === "string" && SPOTIFY_PATTERN.test(value);
}

/** Attachment URLs stay in the editable source of a note, but the reading
 * view replaces them with the richer footer they generated. */
export function withoutAttachmentUrl(body: string, url: unknown): string {
  if (typeof url !== "string" || !url) return body;
  return body
    .split("\n")
    .map((line) => line.split(url).join("").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function withoutAttachmentUrls(body: string, urls: unknown[]): string {
  return urls.reduce<string>((copy, url) => withoutAttachmentUrl(copy, url), body);
}
