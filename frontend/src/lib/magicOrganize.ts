import type { Card, CardType } from "../api/types";

export type OrganizeMode =
  | "cluster"
  | "project"
  | "timeline"
  | "moodboard"
  | "compact";

export interface OrganizeItem {
  id: string;
  card: Card;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OrganizeGroup {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
  tone: number;
}

export interface OrganizePlan {
  positions: Record<string, { x: number; y: number }>;
  groups: OrganizeGroup[];
  width: number;
  height: number;
}

const CARD_GAP = 28;
const GROUP_GAP = 72;
const GROUP_PAD = 28;
const GROUP_HEADER = 46;

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "because", "been",
  "before", "being", "between", "but", "can", "card", "could", "does",
  "for", "from", "have", "into", "just", "more", "not", "note", "our",
  "out", "that", "the", "their", "then", "there", "these", "they", "this",
  "todo", "use", "was", "were", "what", "when", "where", "which", "will",
  "body", "done", "false", "item", "task", "text", "title", "true", "with", "would",
  "you", "your",
]);

const TYPE_LABELS: Partial<Record<CardType, string>> = {
  image: "Visuals",
  audio: "Media",
  youtube: "Media",
  file: "Files",
  checklist: "Tasks",
  timer: "Tasks",
  board: "Boards",
  column: "Collections",
  document: "Documents",
  table: "Data",
  link: "References",
  portal: "Portals",
  text: "Notes",
};

function stableNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function words(card: Card): string[] {
  const payloadText = card.type === "checklist"
    ? JSON.stringify(card.payload.items ?? "")
    : "";
  const text = `${card.title ?? ""} ${card.body ?? ""} ${payloadText}`
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, " ");
  const matches = text.match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [];
  return [...new Set(matches
    .map((word) => word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word)
    .filter((word) => !STOP_WORDS.has(word) && !/^https?$/.test(word)))]
    .slice(0, 48);
}

function broadType(card: Card): string {
  if (["image", "audio", "youtube"].includes(card.type)) return "media";
  if (["checklist", "timer"].includes(card.type)) return "task";
  if (["link", "file"].includes(card.type)) return "reference";
  if (["board", "column", "portal"].includes(card.type)) return "structure";
  return "writing";
}

function clusterName(items: OrganizeItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const word of words(item.card)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const shared = [...counts.entries()]
    .filter(([, count]) => count > 1 || items.length === 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));
  if (shared.length) return shared.join(" & ");

  const typeCounts = new Map<CardType, number>();
  for (const item of items) {
    typeCounts.set(item.card.type, (typeCounts.get(item.card.type) ?? 0) + 1);
  }
  const type = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return (type && TYPE_LABELS[type]) || "Related notes";
}

function semanticClusters(items: OrganizeItem[]): OrganizeItem[][] {
  const limit = Math.min(5, Math.max(2, Math.round(Math.sqrt(items.length))));
  const prepared = items
    .map((item) => ({
      item,
      tokens: new Set(words(item.card)),
      kind: broadType(item.card),
    }))
    .sort((a, b) => b.tokens.size - a.tokens.size || a.item.y - b.item.y);
  const clusters: Array<{
    items: OrganizeItem[];
    tokens: Set<string>;
    kinds: Set<string>;
  }> = [];

  for (const entry of prepared) {
    let bestIndex = -1;
    let bestScore = -1;
    clusters.forEach((cluster, index) => {
      const common = [...entry.tokens].filter((word) => cluster.tokens.has(word)).length;
      const lexical = common / Math.max(1, Math.min(entry.tokens.size, cluster.tokens.size));
      const score = lexical + (cluster.kinds.has(entry.kind) ? 0.1 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    // A shared subject joins cards even across types; otherwise their broad
    // role (task, visual, reference, writing) is enough to keep sparse cards
    // together. New groups stop at a deliberately small visual maximum.
    const related = bestScore >= 0.15 || (entry.tokens.size === 0 && bestScore >= 0.1);
    if (bestIndex < 0 || (!related && clusters.length < limit)) {
      clusters.push({
        items: [entry.item],
        tokens: new Set(entry.tokens),
        kinds: new Set([entry.kind]),
      });
      continue;
    }
    const cluster = clusters[bestIndex];
    cluster.items.push(entry.item);
    entry.tokens.forEach((word) => cluster.tokens.add(word));
    cluster.kinds.add(entry.kind);
  }

  return clusters.map((cluster) => cluster.items).sort((a, b) => b.length - a.length);
}

function packRows(items: OrganizeItem[], maxWidth?: number) {
  const area = items.reduce(
    (total, item) => total + (item.w + CARD_GAP) * (item.h + CARD_GAP),
    0
  );
  const targetWidth = maxWidth ?? Math.max(420, Math.sqrt(area * 1.55));
  const positions: Record<string, { x: number; y: number }> = {};
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const item of items) {
    if (x > 0 && x + item.w > targetWidth) {
      x = 0;
      y += rowHeight + CARD_GAP;
      rowHeight = 0;
    }
    positions[item.id] = { x, y };
    width = Math.max(width, x + item.w);
    rowHeight = Math.max(rowHeight, item.h);
    x += item.w + CARD_GAP;
  }
  return { positions, width, height: y + rowHeight };
}

function groupedPlan(groups: Array<{ name: string; items: OrganizeItem[] }>): OrganizePlan {
  const packed = groups.map((group) => ({
    ...group,
    layout: packRows(group.items, group.items.length > 8 ? 1120 : 760),
  }));
  const columnCount = packed.length <= 2 ? packed.length : 2;
  const cellWidth = Math.max(
    360,
    ...packed.map((group) => group.layout.width + GROUP_PAD * 2)
  );
  const columnBottoms = Array.from({ length: Math.max(1, columnCount) }, () => 0);
  const positions: OrganizePlan["positions"] = {};
  const planGroups: OrganizeGroup[] = [];

  packed.forEach((group, index) => {
    const column = columnBottoms.indexOf(Math.min(...columnBottoms));
    const x = column * (cellWidth + GROUP_GAP);
    const y = columnBottoms[column];
    const w = cellWidth;
    const h = group.layout.height + GROUP_HEADER + GROUP_PAD * 2;
    for (const item of group.items) {
      const local = group.layout.positions[item.id];
      positions[item.id] = {
        x: x + GROUP_PAD + local.x,
        y: y + GROUP_HEADER + GROUP_PAD + local.y,
      };
    }
    planGroups.push({ name: group.name, x, y, w, h, count: group.items.length, tone: index % 4 });
    columnBottoms[column] += h + GROUP_GAP;
  });

  return {
    positions,
    groups: planGroups,
    width: columnCount * cellWidth + Math.max(0, columnCount - 1) * GROUP_GAP,
    height: Math.max(0, ...columnBottoms) - (packed.length ? GROUP_GAP : 0),
  };
}

function checklistProgress(card: Card): { done: number; total: number } {
  const raw = Array.isArray(card.payload.items) ? card.payload.items : [];
  return {
    total: raw.length,
    done: raw.filter(
      (item) => Boolean(item) && typeof item === "object" && (item as Record<string, unknown>).done === true
    ).length,
  };
}

function projectPlan(items: OrganizeItem[]): OrganizePlan {
  const lanes = [
    { name: "In progress", items: [] as OrganizeItem[] },
    { name: "Next", items: [] as OrganizeItem[] },
    { name: "Ideas & reference", items: [] as OrganizeItem[] },
    { name: "Done", items: [] as OrganizeItem[] },
  ];
  for (const item of items) {
    const progress = checklistProgress(item.card);
    if (progress.total > 0 && progress.done === progress.total) lanes[3].items.push(item);
    else if (item.card.timer_started_at || (progress.done > 0 && progress.done < progress.total)) lanes[0].items.push(item);
    else if (item.card.due_at || item.card.eta_minutes || item.card.type === "checklist" || item.card.type === "timer") lanes[1].items.push(item);
    else lanes[2].items.push(item);
  }
  for (const lane of lanes) {
    lane.items.sort((a, b) => a.y - b.y || a.x - b.x);
  }
  return lanePlan(lanes.filter((lane) => lane.items.length));
}

function dayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function timelinePlan(items: OrganizeItem[]): OrganizePlan {
  const now = new Date();
  const today = dayStart(now);
  const lanes = [
    { name: "Overdue", items: [] as OrganizeItem[] },
    { name: "Today", items: [] as OrganizeItem[] },
    { name: "Upcoming", items: [] as OrganizeItem[] },
    { name: "Unscheduled", items: [] as OrganizeItem[] },
  ];
  for (const item of items) {
    if (!item.card.due_at) {
      lanes[3].items.push(item);
      continue;
    }
    const due = new Date(item.card.due_at);
    if (Number.isNaN(due.getTime())) lanes[3].items.push(item);
    else if (due.getTime() < now.getTime()) lanes[0].items.push(item);
    else if (dayStart(due) === today) lanes[1].items.push(item);
    else lanes[2].items.push(item);
  }
  for (const lane of lanes) {
    lane.items.sort((a, b) =>
      (a.card.due_at ? new Date(a.card.due_at).getTime() : Number.MAX_SAFE_INTEGER) -
      (b.card.due_at ? new Date(b.card.due_at).getTime() : Number.MAX_SAFE_INTEGER)
    );
  }
  return lanePlan(lanes.filter((lane) => lane.items.length));
}

function lanePlan(lanes: Array<{ name: string; items: OrganizeItem[] }>): OrganizePlan {
  const positions: OrganizePlan["positions"] = {};
  const groups: OrganizeGroup[] = [];
  let x = 0;
  let height = 0;
  lanes.forEach((lane, index) => {
    const singleColumnWidth = Math.max(280, ...lane.items.map((item) => item.w));
    const layout = packRows(
      lane.items,
      lane.items.length > 8 ? Math.max(1120, singleColumnWidth) : singleColumnWidth
    );
    const w = Math.max(280, layout.width) + GROUP_PAD * 2;
    for (const item of lane.items) {
      const local = layout.positions[item.id];
      positions[item.id] = {
        x: x + GROUP_PAD + local.x,
        y: GROUP_HEADER + GROUP_PAD + local.y,
      };
    }
    const h = Math.max(220, layout.height + GROUP_HEADER + GROUP_PAD * 2);
    groups.push({ name: lane.name, x, y: 0, w, h, count: lane.items.length, tone: index % 4 });
    x += w + GROUP_GAP;
    height = Math.max(height, h);
  });
  return {
    positions,
    groups: groups.map((group) => ({ ...group, h: height })),
    width: Math.max(0, x - GROUP_GAP),
    height,
  };
}

function moodboardPlan(items: OrganizeItem[]): OrganizePlan {
  const ordered = [...items].sort((a, b) => {
    const imageDifference = Number(b.card.type === "image") - Number(a.card.type === "image");
    return imageDifference || a.y - b.y || a.x - b.x;
  });
  const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(items.length))));
  const maxWidth = Math.max(...items.map((item) => item.w));
  const columnWidth = maxWidth + 48;
  const bottoms: number[] = Array.from(
    { length: columns },
    (_, index) => index % 2 ? 42 : 0
  );
  const positions: OrganizePlan["positions"] = {};
  for (const item of ordered) {
    const column = bottoms.indexOf(Math.min(...bottoms));
    const jitter = (stableNumber(item.id) % 31) - 15;
    positions[item.id] = {
      x: column * columnWidth + 20 + jitter,
      y: bottoms[column],
    };
    bottoms[column] += item.h + 24 + (stableNumber(`${item.id}:gap`) % 35);
  }
  return {
    positions,
    groups: [],
    width: columns * columnWidth,
    height: Math.max(...bottoms),
  };
}

export function createOrganizePlan(items: OrganizeItem[], mode: OrganizeMode): OrganizePlan {
  if (items.length === 0) return { positions: {}, groups: [], width: 0, height: 0 };
  if (mode === "cluster") {
    const usedNames = new Map<string, number>();
    return groupedPlan(semanticClusters(items).map((cluster) => {
      const base = clusterName(cluster);
      const occurrence = (usedNames.get(base) ?? 0) + 1;
      usedNames.set(base, occurrence);
      return {
        name: occurrence === 1 ? base : `${base} ${occurrence}`,
        items: cluster.sort((a, b) => a.y - b.y || a.x - b.x),
      };
    }));
  }
  if (mode === "project") return projectPlan(items);
  if (mode === "timeline") return timelinePlan(items);
  if (mode === "moodboard") return moodboardPlan(items);

  const layout = packRows([...items].sort((a, b) => a.y - b.y || a.x - b.x));
  return { ...layout, groups: [] };
}

export function translateOrganizePlan(
  plan: OrganizePlan,
  x: number,
  y: number
): OrganizePlan {
  return {
    ...plan,
    positions: Object.fromEntries(
      Object.entries(plan.positions).map(([id, position]) => [
        id,
        { x: position.x + x, y: position.y + y },
      ])
    ),
    groups: plan.groups.map((group) => ({ ...group, x: group.x + x, y: group.y + y })),
  };
}

export function modeSupportsZones(mode: OrganizeMode): boolean {
  return mode === "cluster" || mode === "project" || mode === "timeline";
}
