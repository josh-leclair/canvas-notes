import type { Card } from "../api/types";

type TimedCard = Pick<
  Card,
  "due_at" | "eta_minutes" | "timer_started_at" | "timer_elapsed_seconds"
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

export function dueLabel(iso: string | null, now = new Date()): string | null {
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  const days = Math.round(
    (Date.UTC(due.getFullYear(), due.getMonth(), due.getDate()) -
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) /
      86_400_000
  );
  if (due.getTime() < now.getTime()) return "Overdue";
  const time = due.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) {
    return due.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  }
  return due.toLocaleDateString([], { month: "short", day: "numeric" });
}

export type DueTone = "quiet" | "soon" | "overdue";

export function timingTone(iso: string | null, now = Date.now()): DueTone {
  if (!iso) return "quiet";
  const difference = new Date(iso).getTime() - now;
  if (difference < 0) return "overdue";
  if (difference < 86_400_000) return "soon";
  return "quiet";
}

export type TimeLensBucket = "overdue" | "today" | "week" | "later" | "estimate";

export function timeLensBucket(card: TimedCard, now = new Date()): TimeLensBucket | null {
  if (!card.due_at) return card.eta_minutes ? "estimate" : null;
  const due = new Date(card.due_at);
  if (due.getTime() < now.getTime()) return "overdue";
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  if (due <= todayEnd) return "today";
  if (due.getTime() < now.getTime() + 7 * 86_400_000) return "week";
  return "later";
}
