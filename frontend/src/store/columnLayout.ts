import type { CardNode } from "./canvasStore";

/** Milanote-style stacks: a titled container whose members flow down it.
 *
 * Members are real nodes — they keep their identity, can be linked, revealed
 * and selected — but the column owns their geometry. Their x/y in the
 * database go unused while they are inside one, and are restored the moment
 * they leave, so nothing is destroyed by joining a column.
 */
export const COLUMN_WIDTH = 300;
export const COLUMN_HEADER = 50;
/* A hairline all round so the cards clear the column's own border and the
   stack does not start or end hard against the header and the base. Kept
   separate on each axis because they were tuned separately. All three feed
   the drop-slot maths, so they only change here. */
export const COLUMN_PAD_X = 5;
export const COLUMN_PAD_Y = 5;
export const COLUMN_GAP = 6;
/** An empty column still needs somewhere to aim at. */
export const COLUMN_EMPTY_BODY = 74;

export function isColumn(node: CardNode): boolean {
  return node.data.card.type === "column";
}

/** Height a column needs to hold the given members. */
export function columnHeight(memberHeights: number[]): number {
  if (memberHeights.length === 0) {
    return COLUMN_HEADER + COLUMN_EMPTY_BODY;
  }
  const stacked =
    memberHeights.reduce((total, h) => total + h, 0) +
    COLUMN_GAP * (memberHeights.length - 1);
  return COLUMN_HEADER + stacked + COLUMN_PAD_Y * 2;
}

/** Where the nth member sits, relative to its column. */
export function memberOffset(memberHeights: number[], index: number): {
  x: number;
  y: number;
} {
  let y = COLUMN_HEADER + COLUMN_PAD_Y;
  for (let i = 0; i < index; i++) y += memberHeights[i] + COLUMN_GAP;
  return { x: COLUMN_PAD_X, y };
}

export const MEMBER_WIDTH = COLUMN_WIDTH - COLUMN_PAD_X * 2;

export interface ColumnLayout {
  /** Column placement id → its members, already in order. */
  members: Map<string, CardNode[]>;
  /** Node id → rendered geometry, for members and columns alike. */
  geometry: Map<string, { width: number; height: number }>;
}

/** Group members under their columns and work out everyone's size.
 *
 * Pure, and derived entirely from the placements, so it cannot drift from
 * what the server holds. */
/** Height a member should render at: what its content actually needs, when
 * that has been measured, otherwise its stored height.
 *
 * Render-only. The placement's own height is never touched, so pulling a
 * card back out of a column restores exactly the size it had before. */
export const MEMBER_MIN_HEIGHT = 56;
export const MEMBER_MAX_HEIGHT = 420;

function memberHeight(node: CardNode, measured: Record<string, number>): number {
  const fit = measured[node.id];
  if (!fit) return node.data.h;
  return Math.max(MEMBER_MIN_HEIGHT, Math.min(MEMBER_MAX_HEIGHT, Math.round(fit)));
}

export function layoutColumns(
  nodes: CardNode[],
  measured: Record<string, number> = {}
): ColumnLayout {
  const members = new Map<string, CardNode[]>();
  for (const node of nodes) {
    const parent = node.data.parentId;
    if (!parent) continue;
    const list = members.get(parent) ?? [];
    list.push(node);
    members.set(parent, list);
  }
  for (const list of members.values()) {
    list.sort((a, b) => (a.data.sort ?? 0) - (b.data.sort ?? 0));
  }

  const geometry = new Map<string, { width: number; height: number }>();
  for (const node of nodes) {
    if (isColumn(node)) {
      const kids = members.get(node.id) ?? [];
      geometry.set(node.id, {
        width: COLUMN_WIDTH,
        height: columnHeight(kids.map((k) => memberHeight(k, measured))),
      });
    } else if (node.data.parentId) {
      geometry.set(node.id, {
        width: MEMBER_WIDTH,
        height: memberHeight(node, measured),
      });
    } else {
      geometry.set(node.id, { width: node.data.w, height: node.data.h });
    }
  }
  return { members, geometry };
}

/** Which slot a pointer at this offset from the column's top would drop into. */
export function slotForOffset(memberHeights: number[], offsetY: number): number {
  let y = COLUMN_HEADER + COLUMN_PAD_Y;
  for (let i = 0; i < memberHeights.length; i++) {
    const middle = y + memberHeights[i] / 2;
    if (offsetY < middle) return i;
    y += memberHeights[i] + COLUMN_GAP;
  }
  return memberHeights.length;
}
