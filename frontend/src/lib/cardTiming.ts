import type { Card } from "../api/types";

type TimedCard = Pick<
  Card,
  "timer_started_at" | "timer_elapsed_seconds"
>;

export function elapsedSeconds(card: TimedCard, now = Date.now()): number {
  const running = card.timer_started_at
    ? Math.max(0, Math.floor((now - new Date(card.timer_started_at).getTime()) / 1_000))
    : 0;
  return Math.max(0, card.timer_elapsed_seconds || 0) + running;
}

export function formatDuration(seconds: number, exact = false): string {
  const safe = Math.max(0, Math.floor(seconds));
  const days = Math.floor(safe / 86_400);
  const hours = Math.floor((safe % 86_400) / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const remainingSeconds = safe % 60;
  if (exact) {
    const clock = `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
    return days ? `${days}d ${clock}` : clock;
  }
  if (days > 0) return `${days}d${hours ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  return `${minutes || 1}m`;
}

export function etaLabel(minutes: number | null): string | null {
  return minutes ? formatDuration(minutes * 60) : null;
}
