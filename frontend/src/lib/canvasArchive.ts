import { ApiError } from "../api/client";
import type { CanvasAppearance } from "../api/types";
import { readCanvasAppearance, rememberCanvasAppearance } from "./canvasAppearance";
import { readCanvasTextSize, rememberCanvasTextSize } from "./canvasTextSize";

export interface ArchiveImportResult {
  scope: "all" | "canvas";
  root_canvas_id: string | null;
  canvases: Array<{
    source_id: string;
    id: string;
    name: string;
    appearance: CanvasAppearance;
    text_size: number;
  }>;
  card_count: number;
  file_count: number;
}

function preferences(canvasIds: string[]) {
  return Object.fromEntries(
    canvasIds.map((id) => [
      id,
      {
        appearance: readCanvasAppearance(id) ?? "studio",
        text_size: readCanvasTextSize(id),
      },
    ])
  );
}

async function errorFrom(response: Response): Promise<ApiError> {
  const data = await response.json().catch(() => null);
  const error = data?.error ?? {
    code: "archive_failed",
    message: `Archive request failed (HTTP ${response.status})`,
  };
  return new ApiError(response.status, error.code, error.message);
}

function responseFilename(response: Response): string {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? "canvas-notes.canvas-notes.zip";
}

export async function exportCanvasArchive(
  canvasIds: string[],
  canvasId: string | null = null
): Promise<void> {
  const response = await fetch("/api/archive/export", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ canvas_id: canvasId, preferences: preferences(canvasIds) }),
  });
  if (!response.ok) throw await errorFrom(response);

  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = responseFilename(response);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function importCanvasArchive(file: File): Promise<ArchiveImportResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/archive/import", {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  if (!response.ok) throw await errorFrom(response);
  const result = (await response.json()) as ArchiveImportResult;
  for (const canvas of result.canvases) {
    rememberCanvasAppearance(canvas.id, canvas.appearance);
    rememberCanvasTextSize(canvas.id, canvas.text_size);
  }
  return result;
}
