import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { RevealLink, RevealOut, Snapshot } from "../api/types";
import type { CardNode } from "./canvasStore";

export interface PortalData extends Record<string, unknown> {
  cardId: string;
  title: string | null;
  homeCanvasId: string | null;
  homeCanvasName: string | null;
  /** Links joining this card to the reveal, so it can be unlinked from here. */
  linkIds: string[];
}

export interface TombstoneData extends Record<string, unknown> {
  linkId: string;
  side: "source" | "target";
  snapshot: Snapshot;
  linkedAt: string;
  note: string | null;
}

export type PortalNode = Node<PortalData, "ghost">;
export type TombstoneNode = Node<TombstoneData, "tombstone">;

export interface RevealGraph {
  ghosts: PortalNode[];
  tombstones: TombstoneNode[];
  edges: Edge[];
  /** Node ids that are part of the reveal; everything else dims. */
  revealedNodeIds: Set<string>;
}

/** Portal chips are small: they are doors, not cards. */
const PORTAL_WIDTH = 184;
const PORTAL_HEIGHT = 52;
const GAP = 72;
const STACK_GAP = 10;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function center(box: Box): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** Pick the handle pair whose geometry points at the other card, so a line
 * always leaves toward its destination instead of looping back under its own
 * endpoints. */
function facingHandles(source: Box, target: Box): [string, string] {
  const a = center(source);
  const b = center(target);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ["right", "left"] : ["left", "right"];
  }
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

function linkColor(link: RevealLink): string {
  return `var(--link-${link.link_type ?? "untyped"})`;
}

interface Floating {
  id: string;
  kind: "portal" | "tombstone";
  cardId?: string;
  link?: RevealLink;
  side?: "source" | "target";
  anchorId: string | null;
  direction: "outgoing" | "incoming";
  /** Stable ordering key so chips never trade places while dragging. */
  sort: string;
}

/** Lay out everything that has no placement on this canvas.
 *
 * Each off-canvas endpoint renders as a portal chip pinned beside the card it
 * is linked to: outgoing to the right, incoming to the left, in a vertically
 * centred stack. Positions are a pure function of the anchor's live position
 * and a stable sort — no collision nudging — so chips follow a dragged card
 * exactly and never jitter or trade places mid-drag. */
export function buildRevealGraph(
  reveal: RevealOut,
  anchor: { x: number; y: number },
  nodes: CardNode[]
): RevealGraph {
  const placementNodeIds = new Set(nodes.map((n) => n.id));
  const nodeIdForCard = new Map<string, string>();
  const boxes = new Map<string, Box>();

  for (const node of nodes) {
    boxes.set(node.id, {
      x: node.position.x,
      y: node.position.y,
      w: node.data.w,
      h: node.data.h,
    });
  }

  for (const [cardId, entry] of Object.entries(reveal.cards)) {
    if (entry.placement && placementNodeIds.has(entry.placement.id)) {
      nodeIdForCard.set(cardId, entry.placement.id);
    }
  }

  const floating: Floating[] = [];

  for (const [cardId, entry] of Object.entries(reveal.cards)) {
    if (nodeIdForCard.has(cardId)) continue;
    const id = `ghost-${cardId}`;
    nodeIdForCard.set(cardId, id);
    floating.push({
      id,
      kind: "portal",
      cardId,
      anchorId: null,
      direction: "outgoing",
      sort: (entry.card.title ?? "") + cardId,
    });
  }

  for (const link of reveal.links) {
    if (link.source_card_id === null) {
      floating.push({
        id: `tomb-${link.id}-source`,
        kind: "tombstone",
        link,
        side: "source",
        anchorId: null,
        direction: "incoming",
        sort: "tomb" + link.id,
      });
    }
    if (link.target_card_id === null) {
      floating.push({
        id: `tomb-${link.id}-target`,
        kind: "tombstone",
        link,
        side: "target",
        anchorId: null,
        direction: "outgoing",
        sort: "tomb" + link.id,
      });
    }
  }

  const byId = new Map(floating.map((f) => [f.id, f]));

  // A chip hangs off whatever it is linked to: outgoing beside its source,
  // incoming beside its target. Two passes so endpoints reached only through
  // another off-canvas card resolve too.
  for (let pass = 0; pass < 2; pass++) {
    for (const link of reveal.links) {
      const sourceId = link.source_card_id
        ? nodeIdForCard.get(link.source_card_id)
        : `tomb-${link.id}-source`;
      const targetId = link.target_card_id
        ? nodeIdForCard.get(link.target_card_id)
        : `tomb-${link.id}-target`;
      if (!sourceId || !targetId) continue;

      const anchorReady = (id: string) =>
        !byId.has(id) || byId.get(id)!.anchorId !== null;

      // Note the explicit existence check: `item?.anchorId == null` is also
      // true when there is no item at all, which would assign to undefined.
      const floatingTarget = byId.get(targetId);
      if (floatingTarget && floatingTarget.anchorId === null && anchorReady(sourceId)) {
        floatingTarget.anchorId = sourceId;
        floatingTarget.direction = "outgoing";
      }
      const floatingSource = byId.get(sourceId);
      if (floatingSource && floatingSource.anchorId === null && anchorReady(targetId)) {
        floatingSource.anchorId = targetId;
        floatingSource.direction = "incoming";
      }
    }
  }

  const rootNodeId = nodeIdForCard.get(reveal.root_card_id) ?? null;
  const stacks = new Map<string, Floating[]>();
  for (const item of floating) {
    const anchorId =
      (item.anchorId && boxes.has(item.anchorId) ? item.anchorId : rootNodeId) ?? "";
    item.anchorId = anchorId || null;
    const key = `${anchorId}|${item.direction}`;
    (stacks.get(key) ?? stacks.set(key, []).get(key)!).push(item);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [key, items] of stacks) {
    items.sort((a, b) => a.sort.localeCompare(b.sort));
    const [anchorId, direction] = key.split("|");
    const anchorBox = boxes.get(anchorId) ?? { x: anchor.x, y: anchor.y, w: 280, h: 180 };
    const totalHeight =
      items.length * PORTAL_HEIGHT + (items.length - 1) * STACK_GAP;
    const startY = anchorBox.y + anchorBox.h / 2 - totalHeight / 2;
    const x =
      direction === "outgoing"
        ? anchorBox.x + anchorBox.w + GAP
        : anchorBox.x - GAP - PORTAL_WIDTH;

    items.forEach((item, index) => {
      const y = startY + index * (PORTAL_HEIGHT + STACK_GAP);
      positions.set(item.id, { x, y });
      boxes.set(item.id, { x, y, w: PORTAL_WIDTH, h: PORTAL_HEIGHT });
    });
  }

  const ghosts: PortalNode[] = [];
  const tombstones: TombstoneNode[] = [];

  for (const item of floating) {
    const position = positions.get(item.id) ?? { x: anchor.x, y: anchor.y };
    const common = {
      position,
      draggable: false,
      width: PORTAL_WIDTH,
      height: PORTAL_HEIGHT,
      // Above cards: a door in front of the wall, never behind it.
      zIndex: 1200,
    };
    if (item.kind === "portal") {
      const entry = reveal.cards[item.cardId!];
      ghosts.push({
        id: item.id,
        type: "ghost",
        selectable: false,
        ...common,
        data: {
          cardId: item.cardId!,
          title: entry.card.title ?? entry.card.body?.slice(0, 60) ?? null,
          homeCanvasId: entry.home_canvas_id,
          homeCanvasName: entry.home_canvas_name,
          linkIds: reveal.links
            .filter(
              (l) =>
                l.source_card_id === item.cardId || l.target_card_id === item.cardId
            )
            .map((l) => l.id),
        },
      });
    } else {
      const link = item.link!;
      tombstones.push({
        id: item.id,
        type: "tombstone",
        selectable: false,
        ...common,
        data: {
          linkId: link.id,
          side: item.side!,
          snapshot:
            item.side === "source" ? link.source_snapshot : link.target_snapshot,
          linkedAt: link.created_at,
          note: link.note,
        },
      });
    }
  }

  const edges: Edge[] = [];
  for (const link of reveal.links) {
    const sourceId = link.source_card_id
      ? nodeIdForCard.get(link.source_card_id)
      : `tomb-${link.id}-source`;
    const targetId = link.target_card_id
      ? nodeIdForCard.get(link.target_card_id)
      : `tomb-${link.id}-target`;
    if (!sourceId || !targetId) continue;

    const sourceBox = boxes.get(sourceId);
    const targetBox = boxes.get(targetId);
    const [sourceHandle, targetHandle] =
      sourceBox && targetBox ? facingHandles(sourceBox, targetBox) : ["right", "left"];

    const color = linkColor(link);
    const hop2 = link.hop >= 2;
    edges.push({
      id: link.id,
      type: "link",
      source: sourceId,
      target: targetId,
      sourceHandle: `${sourceHandle}-source`,
      targetHandle: `${targetHandle}-target`,
      // Arrowheads never flip: they always point source to target.
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: {
        stroke: color,
        strokeWidth: hop2 ? 1.4 : 2.2,
        opacity: hop2 ? 0.45 : 1,
      },
      data: { link },
    });
  }

  const revealedNodeIds = new Set<string>([
    ...nodeIdForCard.values(),
    ...tombstones.map((t) => t.id),
  ]);

  return { ghosts, tombstones, edges, revealedNodeIds };
}
