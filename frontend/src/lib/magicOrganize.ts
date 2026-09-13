import type { Card, CardType, Link } from "../api/types";

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
  reason: string;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
  tone: number;
}

export interface OrganizePlan {
  positions: Record<string, { x: number; y: number }>;
  sizes: Record<string, { w: number; h: number }>;
  groups: OrganizeGroup[];
  width: number;
  height: number;
}

export interface OrganizeContext {
  links?: Link[];
}

interface OrganizeGroupInput {
  name: string;
  reason: string;
  items: OrganizeItem[];
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
    // Keep the label from Markdown links, but never let hostnames and URL
    // fragments become accidental zone names on a board full of clippings.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
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

export function isMagicHeading(card: Card): boolean {
  return card.type === "text" && card.payload.display === "heading";
}

function center(item: OrganizeItem): { x: number; y: number } {
  return { x: item.x + item.w / 2, y: item.y + item.h / 2 };
}

function distanceBetween(left: OrganizeItem, right: OrganizeItem): number {
  const a = center(left);
  const b = center(right);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function adaptedItems(items: OrganizeItem[], mode: OrganizeMode): OrganizeItem[] {
  return items.map((item) => {
    let { w, h } = item;
    if (isMagicHeading(item.card)) {
      w = Math.max(w, 520);
      h = Math.min(150, Math.max(88, h));
    } else if (item.card.type === "image" && mode === "moodboard") {
      const targetWidth = Math.min(480, Math.max(320, w * 1.24));
      const scale = Math.min(1.45, targetWidth / Math.max(1, w));
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    } else if (item.card.type === "document") {
      w = Math.min(460, Math.max(360, w));
    } else if (item.card.type === "checklist") {
      w = Math.min(460, Math.max(280, w));
    }
    return { ...item, w, h };
  });
}

function linkedCardIds(item: OrganizeItem, links: Link[]): Set<string> {
  const neighbours = new Set<string>();
  for (const link of links) {
    if (link.source_card_id === item.card.id && link.target_card_id) {
      neighbours.add(link.target_card_id);
    }
    if (link.target_card_id === item.card.id && link.source_card_id) {
      neighbours.add(link.source_card_id);
    }
  }
  return neighbours;
}

function headingName(item: OrganizeItem): string {
  const value = item.card.title || item.card.body?.split("\n")[0] || "Untitled section";
  return value.trim().slice(0, 64) || "Untitled section";
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

function clusterReason(signals: Set<string>): string {
  const labels = [
    signals.has("topic") ? "shared topics" : null,
    signals.has("link") ? "card links" : null,
    signals.has("proximity") ? "nearby placement" : null,
    signals.has("type") ? "card type" : null,
  ].filter((value): value is string => Boolean(value));
  if (!labels.length) return "Related cards";
  if (labels.length === 1) return `Grouped by ${labels[0]}`;
  return `Grouped by ${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function semanticClusters(items: OrganizeItem[], links: Link[]): OrganizeGroupInput[] {
  const limit = Math.min(5, Math.max(2, Math.round(Math.sqrt(items.length))));
  const prepared = items
    .map((item) => ({
      item,
      tokens: new Set(words(item.card)),
      kind: broadType(item.card),
      neighbours: linkedCardIds(item, links),
    }))
    .sort((a, b) => b.tokens.size - a.tokens.size || a.item.y - b.item.y);
  const clusters: Array<{
    items: OrganizeItem[];
    tokens: Set<string>;
    kinds: Set<string>;
    signals: Set<string>;
  }> = [];
  const unassigned: OrganizeItem[] = [];

  for (const entry of prepared) {
    let bestIndex = -1;
    let bestScore = -1;
    let bestSignals = new Set<string>();
    clusters.forEach((cluster, index) => {
      const common = [...entry.tokens].filter((word) => cluster.tokens.has(word)).length;
      const lexical = common / Math.max(1, Math.min(entry.tokens.size, cluster.tokens.size));
      const linked = cluster.items.some((item) => entry.neighbours.has(item.card.id));
      const nearest = Math.min(...cluster.items.map((item) => distanceBetween(entry.item, item)));
      const proximity = nearest < 560 ? 0.24 * (1 - nearest / 560) : 0;
      const sameType = cluster.kinds.has(entry.kind);
      const score = lexical + (linked ? 0.72 : 0) + proximity + (sameType ? 0.08 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
        bestSignals = new Set([
          ...(lexical >= 0.12 ? ["topic"] : []),
          ...(linked ? ["link"] : []),
          ...(proximity >= 0.06 ? ["proximity"] : []),
          ...(sameType ? ["type"] : []),
        ]);
      }
    });

    // Links are strong evidence, while proximity and card type are weak
    // evidence that can reinforce each other without overriding the words.
    const related = bestScore >= 0.18;
    if (bestIndex < 0 || (!related && clusters.length < limit)) {
      clusters.push({
        items: [entry.item],
        tokens: new Set(entry.tokens),
        kinds: new Set([entry.kind]),
        signals: new Set(),
      });
      continue;
    }
    if (!related) {
      unassigned.push(entry.item);
      continue;
    }
    const cluster = clusters[bestIndex];
    cluster.items.push(entry.item);
    entry.tokens.forEach((word) => cluster.tokens.add(word));
    cluster.kinds.add(entry.kind);
    bestSignals.forEach((signal) => cluster.signals.add(signal));
  }

  const grouped = clusters.filter((cluster) => cluster.items.length > 1);
  const orphans = [
    ...clusters.filter((cluster) => cluster.items.length === 1).flatMap((cluster) => cluster.items),
    ...unassigned,
  ].sort((a, b) => a.y - b.y || a.x - b.x);

  const result = grouped
    .sort((a, b) => b.items.length - a.items.length)
    .map((cluster) => ({
      name: clusterName(cluster.items),
      reason: clusterReason(cluster.signals),
      items: relationshipOrder(cluster.items, links),
    }));
  if (orphans.length) {
    result.push({
      name: "Unsorted",
      reason: "No strong topic, link, or nearby grouping signal",
      items: orphans,
    });
  }
  return result;
}

function followsOrder(items: OrganizeItem[], links: Link[]): OrganizeItem[] {
  const byCard = new Map(items.map((item) => [item.card.id, item]));
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map(items.map((item) => [item.card.id, 0]));
  for (const link of links) {
    if (
      link.link_type !== "follows_from" ||
      !link.source_card_id ||
      !link.target_card_id ||
      !byCard.has(link.source_card_id) ||
      !byCard.has(link.target_card_id)
    ) continue;
    // “A follows from B” means B is the predecessor even though A is the
    // source end of the relationship in storage.
    const targets = outgoing.get(link.target_card_id) ?? new Set<string>();
    if (!targets.has(link.source_card_id)) {
      targets.add(link.source_card_id);
      outgoing.set(link.target_card_id, targets);
      indegree.set(link.source_card_id, (indegree.get(link.source_card_id) ?? 0) + 1);
    }
  }

  const positionOrder = (left: OrganizeItem, right: OrganizeItem) =>
    left.y - right.y || left.x - right.x;
  const ready = items
    .filter((item) => (indegree.get(item.card.id) ?? 0) === 0)
    .sort(positionOrder);
  const ordered: OrganizeItem[] = [];
  const seen = new Set<string>();
  while (ready.length) {
    const item = ready.shift()!;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    ordered.push(item);
    for (const target of outgoing.get(item.card.id) ?? []) {
      const next = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, next);
      if (next === 0) {
        const candidate = byCard.get(target);
        if (candidate) {
          ready.push(candidate);
          ready.sort(positionOrder);
        }
      }
    }
  }
  return [...ordered, ...items.filter((item) => !seen.has(item.id)).sort(positionOrder)];
}

function relationshipOrder(items: OrganizeItem[], links: Link[]): OrganizeItem[] {
  const positionOrder = (left: OrganizeItem, right: OrganizeItem) =>
    left.y - right.y || left.x - right.x;
  const byCard = new Map(items.map((item) => [item.card.id, item]));
  const neighbours = new Map<string, Set<string>>();
  const join = (left: string, right: string) => {
    const values = neighbours.get(left) ?? new Set<string>();
    values.add(right);
    neighbours.set(left, values);
  };
  for (const link of links) {
    if (
      !link.source_card_id ||
      !link.target_card_id ||
      !byCard.has(link.source_card_id) ||
      !byCard.has(link.target_card_id)
    ) continue;
    join(link.source_card_id, link.target_card_id);
    join(link.target_card_id, link.source_card_id);
  }

  const remaining = new Set(items.map((item) => item.card.id));
  const result: OrganizeItem[] = [];
  while (remaining.size) {
    const seed = items
      .filter((item) => remaining.has(item.card.id))
      .sort(positionOrder)[0];
    const queue = [seed.card.id];
    const component: OrganizeItem[] = [];
    while (queue.length) {
      const cardId = queue.shift()!;
      if (!remaining.delete(cardId)) continue;
      const item = byCard.get(cardId);
      if (item) component.push(item);
      const next = [...(neighbours.get(cardId) ?? [])]
        .map((id) => byCard.get(id))
        .filter((candidate): candidate is OrganizeItem => Boolean(candidate))
        .sort(positionOrder);
      queue.push(...next.map((candidate) => candidate.card.id));
    }
    result.push(...followsOrder(component, links));
  }
  return result;
}

function headingSections(items: OrganizeItem[], links: Link[]): OrganizeGroupInput[] | null {
  const headings = items
    .filter((item) => isMagicHeading(item.card))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (!headings.length) return null;

  const sections = new Map(headings.map((heading) => [heading.id, [] as OrganizeItem[]]));
  const unassigned: OrganizeItem[] = [];
  for (const item of items.filter((candidate) => !isMagicHeading(candidate.card))) {
    const linked = linkedCardIds(item, links);
    const candidates = headings
      .map((heading) => {
        const vertical = item.y - (heading.y + heading.h);
        const horizontal = Math.abs(center(item).x - center(heading).x);
        const relationship = linked.has(heading.card.id);
        const eligible = relationship || (vertical >= -48 && vertical <= 1150);
        return {
          heading,
          eligible,
          score: relationship ? -1000 : Math.max(0, vertical) + horizontal * 0.42,
        };
      })
      .filter((candidate) => candidate.eligible)
      .sort((a, b) => a.score - b.score);
    const owner = candidates[0];
    if (!owner || owner.score > 1050) unassigned.push(item);
    else sections.get(owner.heading.id)!.push(item);
  }

  const result = headings.map((heading) => ({
    name: headingName(heading),
    reason: `Section anchored by the “${headingName(heading)}” heading`,
    items: [heading, ...relationshipOrder(sections.get(heading.id) ?? [], links)],
  }));
  if (unassigned.length) {
    result.push(...semanticClusters(unassigned, links));
  }
  return result;
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

function packGroup(group: OrganizeGroupInput) {
  const heading = group.items.find((item) => isMagicHeading(item.card));
  const contents = group.items.filter((item) => item !== heading);
  const contentLayout = packRows(contents, contents.length > 8 ? 1120 : 760);
  const innerWidth = Math.max(360, heading?.w ?? 0, contentLayout.width);
  const positions: OrganizePlan["positions"] = {};
  const sizes: OrganizePlan["sizes"] = {};
  let contentTop = 0;
  if (heading) {
    positions[heading.id] = { x: 0, y: 0 };
    sizes[heading.id] = { w: innerWidth, h: heading.h };
    contentTop = heading.h + CARD_GAP;
  }
  for (const item of contents) {
    const position = contentLayout.positions[item.id];
    positions[item.id] = { x: position.x, y: position.y + contentTop };
    sizes[item.id] = { w: item.w, h: item.h };
  }
  return {
    positions,
    sizes,
    width: innerWidth,
    height: contentTop + contentLayout.height,
  };
}

function groupedPlan(groups: OrganizeGroupInput[]): OrganizePlan {
  const packed = groups.map((group) => ({ ...group, layout: packGroup(group) }));
  const columnCount = packed.length <= 2 ? packed.length : 2;
  const cellWidth = Math.max(
    360,
    ...packed.map((group) => group.layout.width + GROUP_PAD * 2)
  );
  const columnBottoms = Array.from({ length: Math.max(1, columnCount) }, () => 0);
  const positions: OrganizePlan["positions"] = {};
  const sizes: OrganizePlan["sizes"] = {};
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
      const size = group.layout.sizes[item.id] ?? { w: item.w, h: item.h };
      sizes[item.id] = isMagicHeading(item.card)
        ? { ...size, w: w - GROUP_PAD * 2 }
        : size;
    }
    planGroups.push({
      name: group.name,
      reason: group.reason,
      x,
      y,
      w,
      h,
      count: group.items.length,
      tone: index % 4,
    });
    columnBottoms[column] += h + GROUP_GAP;
  });

  return {
    positions,
    sizes,
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
  const sizes: OrganizePlan["sizes"] = {};
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
      sizes[item.id] = { w: item.w, h: item.h };
    }
    const h = Math.max(220, layout.height + GROUP_HEADER + GROUP_PAD * 2);
    groups.push({
      name: lane.name,
      reason: `Grouped by ${lane.name.toLocaleLowerCase()} status`,
      x,
      y: 0,
      w,
      h,
      count: lane.items.length,
      tone: index % 4,
    });
    x += w + GROUP_GAP;
    height = Math.max(height, h);
  });
  return {
    positions,
    sizes,
    groups: groups.map((group) => ({ ...group, h: height })),
    width: Math.max(0, x - GROUP_GAP),
    height,
  };
}

function moodboardMasonry(items: OrganizeItem[]) {
  if (!items.length) {
    return {
      positions: {} as OrganizePlan["positions"],
      sizes: {} as OrganizePlan["sizes"],
      width: 0,
      height: 0,
    };
  }
  const readingOrder = new Map(items.map((item, index) => [item.id, index]));
  const ordered = [...items].sort((a, b) => {
    const imageDifference = Number(b.card.type === "image") - Number(a.card.type === "image");
    return imageDifference || (readingOrder.get(a.id) ?? 0) - (readingOrder.get(b.id) ?? 0);
  });
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(items.length))));
  const maxWidth = Math.max(...items.map((item) => item.w));
  const columnWidth = maxWidth + 48;
  const bottoms: number[] = Array.from(
    { length: columns },
    (_, index) => index % 2 ? 42 : 0
  );
  const positions: OrganizePlan["positions"] = {};
  const sizes: OrganizePlan["sizes"] = {};
  for (const item of ordered) {
    const column = bottoms.indexOf(Math.min(...bottoms));
    const jitter = (stableNumber(item.id) % 31) - 15;
    positions[item.id] = {
      x: column * columnWidth + 20 + jitter,
      y: bottoms[column],
    };
    sizes[item.id] = { w: item.w, h: item.h };
    bottoms[column] += item.h + 24 + (stableNumber(`${item.id}:gap`) % 35);
  }
  return {
    positions,
    sizes,
    width: columns * columnWidth,
    height: Math.max(...bottoms),
  };
}

function moodboardPlan(items: OrganizeItem[], links: Link[]): OrganizePlan {
  const sections = headingSections(items, links);
  if (!sections) return { ...moodboardMasonry(items), groups: [] };

  const positions: OrganizePlan["positions"] = {};
  const sizes: OrganizePlan["sizes"] = {};
  const groups: OrganizeGroup[] = [];
  let y = 0;
  let width = 0;
  sections.forEach((section, index) => {
    const heading = section.items.find((item) => isMagicHeading(item.card));
    const contents = section.items.filter((item) => item !== heading);
    const layout = moodboardMasonry(contents);
    const sectionWidth = Math.max(520, heading?.w ?? 0, layout.width);
    let contentTop = y + GROUP_PAD;
    if (heading) {
      positions[heading.id] = { x: GROUP_PAD, y: contentTop };
      sizes[heading.id] = { w: sectionWidth, h: heading.h };
      contentTop += heading.h + CARD_GAP;
    }
    for (const item of contents) {
      const position = layout.positions[item.id];
      positions[item.id] = {
        x: GROUP_PAD + position.x,
        y: contentTop + position.y,
      };
      sizes[item.id] = layout.sizes[item.id];
    }
    const contentHeight = Math.max(
      heading?.h ?? 0,
      contentTop - (y + GROUP_PAD) + layout.height
    );
    const groupWidth = sectionWidth + GROUP_PAD * 2;
    const groupHeight = contentHeight + GROUP_PAD * 2;
    groups.push({
      name: section.name,
      reason: section.reason,
      x: 0,
      y,
      w: groupWidth,
      h: groupHeight,
      count: section.items.length,
      tone: index % 4,
    });
    width = Math.max(width, groupWidth);
    y += groupHeight + GROUP_GAP;
  });
  return { positions, sizes, groups, width, height: Math.max(0, y - GROUP_GAP) };
}

export function createOrganizePlan(
  items: OrganizeItem[],
  mode: OrganizeMode,
  context: OrganizeContext = {}
): OrganizePlan {
  if (items.length === 0) {
    return { positions: {}, sizes: {}, groups: [], width: 0, height: 0 };
  }
  const links = context.links ?? [];
  const prepared = adaptedItems(items, mode);
  if (mode === "cluster") {
    const usedNames = new Map<string, number>();
    const groups = headingSections(prepared, links) ?? semanticClusters(prepared, links);
    return groupedPlan(groups.map((group) => {
      const base = group.name;
      const occurrence = (usedNames.get(base) ?? 0) + 1;
      usedNames.set(base, occurrence);
      return {
        name: occurrence === 1 ? base : `${base} ${occurrence}`,
        reason: group.reason,
        items: group.items,
      };
    }));
  }
  if (mode === "project") return projectPlan(relationshipOrder(prepared, links));
  if (mode === "timeline") return timelinePlan(relationshipOrder(prepared, links));
  if (mode === "moodboard") {
    return moodboardPlan(relationshipOrder(prepared, links), links);
  }

  const ordered = relationshipOrder(prepared, links);
  const layout = packRows(ordered);
  return {
    ...layout,
    sizes: Object.fromEntries(ordered.map((item) => [item.id, { w: item.w, h: item.h }])),
    groups: [],
  };
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
