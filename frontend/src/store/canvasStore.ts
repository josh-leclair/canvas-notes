import { create } from "zustand";
import type { Node } from "@xyflow/react";
import { api } from "../api/client";
import {
  normaliseCanvasAppearance,
  readCanvasAppearance,
  rememberCanvasAppearance,
} from "../lib/canvasAppearance";
import {
  normaliseCanvasTextSize,
  readCanvasTextSize,
  rememberCanvasTextSize,
  type CanvasTextSize,
} from "../lib/canvasTextSize";
import {
  CANVAS_GROW_HEIGHT,
  CANVAS_GROW_MARGIN,
  CANVAS_GROW_WIDTH,
  initialCanvasSize,
} from "../lib/canvasBounds";
import type {
  BatchStatus,
  CanvasDetail,
  CanvasAppearance,
  Card,
  CardType,
  CompositionStatus,
  DailyCardResult,
  FocusItem,
  Link,
  LinkType,
  Placement,
  PlacementWithCard,
  RevealOut,
  Role,
  LinkHit,
  SearchHit,
  Zone,
} from "../api/types";

/** Undo covers placement geometry only: the things free placement makes easy
 * to do by accident. Content edits and deletions are not undoable. */
type GeometryUndo = {
  kind: "geometry";
  placementId: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

type UndoOp =
  | GeometryUndo
  | { kind: "geometry-group"; items: GeometryUndo[] }
  | { kind: "removed"; cardId: string; x: number; y: number; w: number; h: number };

const UNDO_LIMIT = 50;

/** A tall photo should not become a tower, and a panorama should not become a
 * sliver, so the fitted height is clamped at both ends. */
const IMAGE_MIN_HEIGHT = 120;
const IMAGE_MAX_HEIGHT = 460;

/** The picture's own proportions, read before it is uploaded. Returns null if
 * the browser cannot decode it, in which case the default box is used. */
async function imageShape(
  file: File
): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    const size = await new Promise<{ width: number; height: number } | null>(
      (resolve) => {
        const probe = new Image();
        probe.onload = () =>
          resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
        probe.onerror = () => resolve(null);
        probe.src = url;
      }
    );
    return size && size.width > 0 && size.height > 0 ? size : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Media opened for focused viewing, with the card rect it grew from. */
export type LightboxMedia =
  | {
      kind: "video";
      videoId: string;
      title: string | null;
      origin?: DOMRect | null;
    }
  | { kind: "image"; src: string; title: string | null; origin?: DOMRect | null };

export interface CardNodeData extends Record<string, unknown> {
  card: Card;
  w: number;
  h: number;
  /** Placement id; duplicated from node id for convenience in the node component. */
  placementId: string;
  /** Folded down to a title bar by one of its hubs. Render-only. */
  collapsed?: boolean;
  /** This card folds its own children away. */
  isHub?: boolean;
  childCount?: number;
  /** Placement id of the column this card sits in, if any. */
  parentId?: string | null;
  sort?: number;
  /** How many cards a column holds, for its header. */
  memberCount?: number;
  /** Y offset, in the column's own coordinates, where a card being dragged
   * over it would land. Null unless one is hovering. */
  dropY?: number | null;
}

export type CardNode = Node<CardNodeData, "card">;

function toNode(p: PlacementWithCard): CardNode {
  return {
    id: p.id,
    type: "card",
    position: { x: p.x, y: p.y },
    width: p.w,
    height: p.h,
    zIndex: p.z,
    data: {
      card: p.card,
      w: p.w,
      h: p.h,
      placementId: p.id,
      isHub: p.is_hub,
      parentId: p.parent_id,
      sort: p.sort,
    },
  };
}

interface CanvasState {
  canvasId: string | null;
  canvasName: string;
  canvasInfinite: boolean;
  canvasWidth: number;
  canvasHeight: number;
  canvasAppearance: CanvasAppearance;
  canvasTextSize: CanvasTextSize;
  role: Role;
  hasCover: boolean;
  /** Links with both endpoints on this canvas, for parent/child lookups. */
  canvasLinks: Link[];
  nodes: CardNode[];
  zones: Zone[];
  /** Selected placement ids. Real state, not CSS: the reveal hooks in here later. */
  selection: string[];
  /** Card ids requested by a document source chip. CanvasPage consumes this
   * once it can select and frame their placements. */
  pendingFocusCardIds: string[] | null;
  inbox: Card[];
  inboxOpen: boolean;
  dailyCardId: string | null;
  focusShelf: FocusItem[];
  /** Whether this instance has a generation endpoint. Features that need one
   * hide rather than erroring, so the menu has to know before offering. */
  generationAvailable: boolean;
  /** Placement id → the height that card's content actually needs, measured
   * from what is on screen. Render-only, for cards stacked in a column: the
   * stored placement height is never touched, so leaving a column restores
   * the size the card had before it joined. */
  memberHeights: Record<string, number>;
  /** Placement id of a just-created card that should open in edit mode. */
  editOnMount: string | null;
  toast: string | null;

  /** Active reveal, anchored at the position of the node it was rooted from. */
  reveal: RevealOut | null;
  revealAnchor: { x: number; y: number } | null;
  /** Link selected for editing in the link panel. */
  selectedLinkId: string | null;
  /** A link to open as soon as a reveal containing it arrives.
   *
   * Following a link result out of search means selecting one of its end
   * cards, and selecting a card loads a reveal — which clears the selected
   * link, because re-rooting the reveal somewhere else should not leave an
   * unrelated panel open. This is the exception, consumed once by the next
   * load, so the intent survives exactly one hop and no further. */
  focusLinkId: string | null;
  /** Card id of the card the "link to" picker is open for, if any. */
  linkPickerFor: string | null;
  /** Card the "place on another board" picker is open for, if any. */
  placeOnBoardFor: { cardId: string; title: string | null } | null;
  /** Placement whose ⋯ menu is open. Its node is lifted above the rest so a
   * neighbour — or a card stacked inside it — cannot cover the menu. */
  menuOpenFor: string | null;

  undoStack: UndoOp[];
  lightbox: LightboxMedia | null;
  searchOpen: boolean;
  searchHits: SearchHit[];
  searchLinkHits: LinkHit[];
  /** Placement ids matching the active search; null when no search is running. */
  searchMatches: string[] | null;

  loadCanvas: (canvasId: string) => Promise<void>;
  updateCanvasAppearance: (appearance: CanvasAppearance) => Promise<void>;
  updateCanvasTextSize: (size: CanvasTextSize) => void;
  growCanvasForContent: (right: number, bottom: number) => void;
  createZone: (zone: { name: string; x: number; y: number; w?: number; h?: number }) => Promise<void>;
  updateZone: (zoneId: string, patch: Partial<Pick<Zone, "name" | "x" | "y" | "w" | "h" | "sort">>) => Promise<void>;
  setZoneGeometry: (zoneId: string, patch: Partial<Pick<Zone, "x" | "y" | "w" | "h">>) => void;
  deleteZone: (zoneId: string) => Promise<void>;
  loadInbox: () => Promise<void>;
  loadCapabilities: () => Promise<void>;
  loadProductivity: () => Promise<void>;
  openDailyCard: (position: { x: number; y: number }) => Promise<void>;
  touchCard: (cardId: string) => Promise<void>;
  toggleFocus: (card: Card) => Promise<void>;
  reportMemberHeight: (placementId: string, height: number | null) => void;
  splitCard: (cardId: string) => Promise<void>;
  composeCards: (
    cardIds: string[],
    position: { x: number; y: number }
  ) => Promise<void>;
  refreshComposition: (cardId: string) => Promise<Card | undefined>;
  discardBatch: (batchId: string) => Promise<void>;
  clearInbox: () => Promise<void>;
  setNodes: (updater: (nodes: CardNode[]) => CardNode[]) => void;
  setSelection: (ids: string[]) => void;
  focusCards: (cardIds: string[]) => void;
  clearPendingFocus: () => void;
  setInboxOpen: (open: boolean) => void;
  clearEditOnMount: () => void;
  showToast: (message: string) => void;

  createCardAt: (
    x: number,
    y: number,
    body: string,
    editNow: boolean,
    type?: CardType,
    payload?: Record<string, unknown>,
    title?: string
  ) => Promise<Card | undefined>;
  createImageCard: (x: number, y: number, file: File) => Promise<void>;
  createFileCard: (x: number, y: number, file: File) => Promise<void>;
  createBoard: (x: number, y: number, name: string) => Promise<void>;
  createColumn: (x: number, y: number, title: string) => Promise<void>;
  /** Put a placement into a column at a given slot, or pull it out. */
  moveIntoColumn: (
    placementId: string,
    columnId: string | null,
    slot: number,
    droppedAt?: { x: number; y: number }
  ) => Promise<void>;
  moveManyIntoColumn: (
    placementIds: string[],
    columnId: string,
    slot: number
  ) => Promise<void>;
  placeInboxCard: (cardId: string, x: number, y: number) => Promise<void>;
  savePlacement: (placementId: string) => void;
  updateCard: (
    cardId: string,
    patch: {
      title?: string | null;
      body?: string | null;
      type?: CardType;
      payload?: Record<string, unknown>;
    }
  ) => Promise<void>;
  /** Replace a card's data everywhere from a server response (uploads, unfurl polls). */
  refreshCardFromServer: (cardId: string, card: Card) => Promise<void>;
  removePlacements: (placementIds: string[]) => Promise<void>;
  deleteCard: (cardId: string) => Promise<void>;

  loadReveal: (cardId: string, anchor: { x: number; y: number }) => Promise<void>;
  clearReveal: () => void;
  setSelectedLinkId: (linkId: string | null) => void;
  setFocusLink: (linkId: string | null) => void;
  setLinkPickerFor: (cardId: string | null) => void;
  setPlaceOnBoardFor: (
    request: { cardId: string; title: string | null } | null
  ) => void;
  setMenuOpenFor: (placementId: string | null) => void;
  createLink: (sourceCardId: string, targetCardId: string) => Promise<void>;
  updateLink: (
    linkId: string,
    patch: { link_type?: LinkType | null; note?: string | null }
  ) => Promise<void>;
  flipLink: (linkId: string) => Promise<void>;
  deleteLink: (linkId: string) => Promise<void>;
  toggleHub: (placementId: string) => Promise<void>;
  addGhostToCanvas: (cardId: string, x: number, y: number) => Promise<void>;
  recreateFromTombstone: (linkId: string, side: "source" | "target") => Promise<void>;

  pushUndo: (op: UndoOp) => void;
  undo: () => Promise<void>;
  openLightbox: (media: LightboxMedia) => void;
  closeLightbox: () => void;
  setSearchOpen: (open: boolean) => void;
  runSearch: (query: string, mode: string) => Promise<string[]>;
  clearSearch: () => void;
}

const saveTimers = new Map<string, number>();
const boundsSaveTimers = new Map<string, number>();
const touchedToday = new Set<string>();

export function localDay(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  canvasId: null,
  canvasName: "",
  canvasInfinite: true,
  canvasWidth: 1920,
  canvasHeight: 1080,
  canvasAppearance: "studio",
  canvasTextSize: 13,
  role: "owner",
  hasCover: false,
  canvasLinks: [],
  nodes: [],
  zones: [],
  selection: [],
  pendingFocusCardIds: null,
  undoStack: [],
  lightbox: null,
  searchOpen: false,
  searchHits: [],
  searchLinkHits: [],
  searchMatches: null,
  inbox: [],
  inboxOpen: localStorage.getItem("inboxOpen") !== "false",
  dailyCardId: null,
  focusShelf: [],
  generationAvailable: false,
  memberHeights: {},
  editOnMount: null,
  toast: null,
  reveal: null,
  revealAnchor: null,
  selectedLinkId: null,
  focusLinkId: null,
  linkPickerFor: null,
  placeOnBoardFor: null,
  menuOpenFor: null,

  loadCanvas: async (canvasId) => {
    const detail = await api.get<CanvasDetail>(`/api/canvases/${canvasId}`);
    const canvasAppearance = normaliseCanvasAppearance(
      detail.appearance ?? readCanvasAppearance(canvasId)
    );
    const switching = get().canvasId !== canvasId;
    const kept = new Set(switching ? [] : get().selection);
    const nodes = detail.placements.map((p) => {
      const node = toNode(p);
      return kept.has(node.id) ? { ...node, selected: true } : node;
    });
    set({
      canvasId,
      canvasName: detail.name,
      canvasInfinite: detail.is_infinite,
      canvasWidth: detail.width,
      canvasHeight: detail.height,
      canvasAppearance,
      canvasTextSize: readCanvasTextSize(canvasId),
      role: detail.role,
      hasCover: detail.has_cover,
      canvasLinks: detail.links,
      nodes,
      zones: detail.zones,
      selection: nodes.filter((n) => n.selected).map((n) => n.id),
      // Nothing from the previous board should survive the trip.
      ...(switching
        ? {
            undoStack: [],
            reveal: null,
            revealAnchor: null,
            selectedLinkId: null,
            searchHits: [],
            searchLinkHits: [],
            searchMatches: null,
            // The column menu renders in a portal now, so an open one would
            // otherwise float over the new board on arrival.
            menuOpenFor: null,
          }
        : {}),
    });
  },

  updateCanvasAppearance: async (appearance) => {
    const canvasId = get().canvasId;
    if (!canvasId) return;
    rememberCanvasAppearance(canvasId, appearance);
    set({ canvasAppearance: appearance });
    try {
      await api.patch(`/api/canvases/${canvasId}`, { appearance });
    } catch {
      // During the reversible UI study, the local choice still works against
      // a backend that has not received migration 0023 yet.
    }
  },

  updateCanvasTextSize: (size) => {
    const canvasId = get().canvasId;
    if (!canvasId) return;
    const next = normaliseCanvasTextSize(size);
    rememberCanvasTextSize(canvasId, next);
    set({ canvasTextSize: next });
  },

  growCanvasForContent: (right, bottom) => {
    const { canvasId, canvasInfinite, canvasWidth, canvasHeight, role } = get();
    if (!canvasId || canvasInfinite || role === "viewer") return;
    const width = right >= canvasWidth - CANVAS_GROW_MARGIN
      ? canvasWidth + CANVAS_GROW_WIDTH
      : canvasWidth;
    const height = bottom >= canvasHeight - CANVAS_GROW_MARGIN
      ? canvasHeight + CANVAS_GROW_HEIGHT
      : canvasHeight;
    if (width === canvasWidth && height === canvasHeight) return;

    set({ canvasWidth: width, canvasHeight: height });
    const prior = boundsSaveTimers.get(canvasId);
    if (prior !== undefined) window.clearTimeout(prior);
    boundsSaveTimers.set(canvasId, window.setTimeout(async () => {
      boundsSaveTimers.delete(canvasId);
      try {
        const saved = await api.patch<{ width: number; height: number }>(
          `/api/canvases/${canvasId}/bounds`,
          { width: get().canvasId === canvasId ? get().canvasWidth : width,
            height: get().canvasId === canvasId ? get().canvasHeight : height }
        );
        if (get().canvasId === canvasId) {
          set({
            canvasWidth: Math.max(get().canvasWidth, saved.width),
            canvasHeight: Math.max(get().canvasHeight, saved.height),
          });
        }
      } catch {
        // Keep the local expansion usable; a later edge approach will retry.
      }
    }, 450));
  },

  createZone: async (zone) => {
    const { canvasId, canvasInfinite, canvasWidth, canvasHeight } = get();
    if (!canvasId) return;
    const w = Math.min(zone.w ?? 720, canvasWidth);
    const h = Math.min(zone.h ?? 520, canvasHeight);
    const bounded = canvasInfinite ? zone : {
      ...zone,
      w,
      h,
      x: Math.max(0, Math.min(zone.x, canvasWidth - w)),
      y: Math.max(0, Math.min(zone.y, canvasHeight - h)),
    };
    const created = await api.post<Zone>(`/api/canvases/${canvasId}/zones`, bounded);
    set({ zones: [...get().zones, created] });
  },

  updateZone: async (zoneId, patch) => {
    const before = get().zones.find((zone) => zone.id === zoneId);
    if (!before) return;
    set({ zones: get().zones.map((zone) => zone.id === zoneId ? { ...zone, ...patch } : zone) });
    try {
      const updated = await api.patch<Zone>(`/api/zones/${zoneId}`, patch);
      set({ zones: get().zones.map((zone) => zone.id === zoneId ? updated : zone) });
    } catch (error) {
      set({ zones: get().zones.map((zone) => zone.id === zoneId ? before : zone) });
      get().showToast(error instanceof Error ? error.message : "Could not save the zone");
    }
  },

  setZoneGeometry: (zoneId, patch) => set({
    zones: get().zones.map((zone) => zone.id === zoneId ? { ...zone, ...patch } : zone),
  }),

  deleteZone: async (zoneId) => {
    const before = get().zones;
    set({ zones: before.filter((zone) => zone.id !== zoneId) });
    try {
      await api.delete(`/api/zones/${zoneId}`);
    } catch (error) {
      set({ zones: before });
      get().showToast(error instanceof Error ? error.message : "Could not delete the zone");
    }
  },

  loadInbox: async () => {
    const resp = await api.get<{ items: Card[] }>("/api/inbox?limit=100");
    set({ inbox: resp.items });
  },

  loadProductivity: async () => {
    const day = localDay();
    const [daily, focusShelf] = await Promise.all([
      api.get<DailyCardResult>(`/api/daily-cards/${day}`),
      api.get<FocusItem[]>("/api/focus-shelf"),
    ]);
    set({ dailyCardId: daily.card?.id ?? null, focusShelf });
  },

  openDailyCard: async (position) => {
    const { canvasId } = get();
    if (!canvasId) return;
    const result = await api.post<DailyCardResult>("/api/daily-cards/open", {
      day: localDay(),
      canvas_id: canvasId,
      x: position.x,
      y: position.y,
    });
    if (!result.card || !result.placement) return;
    let nodes = get().nodes;
    let node = nodes.find((item) => item.data.card.id === result.card!.id);
    if (!node) {
      node = toNode({
        ...result.placement,
        card: result.card,
      });
      nodes = [...nodes, node];
    }
    set({
      dailyCardId: result.card.id,
      nodes: nodes.map((item) => ({ ...item, selected: item.id === node!.id })),
      selection: [node.id],
      editOnMount: node.id,
      reveal: null,
      revealAnchor: null,
    });
  },

  touchCard: async (cardId) => {
    const { dailyCardId, canvasId } = get();
    if (!dailyCardId || cardId === dailyCardId) return;
    const key = `${localDay()}:${cardId}`;
    if (touchedToday.has(key)) return;
    touchedToday.add(key);
    try {
      const link = await api.post<Link | null>(`/api/daily-cards/${cardId}/touch`, {
        day: localDay(),
        canvas_id: canvasId,
      });
      if (!link || get().canvasLinks.some((item) => item.id === link.id)) return;
      const present = new Set(get().nodes.map((item) => item.data.card.id));
      if (link.source_card_id && link.target_card_id && present.has(link.source_card_id) && present.has(link.target_card_id)) {
        set({ canvasLinks: [...get().canvasLinks, link] });
      }
    } catch {
      touchedToday.delete(key);
    }
  },

  toggleFocus: async (card) => {
    const focused = get().focusShelf.some((item) => item.card.id === card.id);
    try {
      if (focused) {
        await api.delete(`/api/focus-shelf/${card.id}`);
        set({ focusShelf: get().focusShelf.filter((item) => item.card.id !== card.id) });
      } else {
        await api.put(`/api/focus-shelf/${card.id}`);
        const placements = await api.get<import("../api/types").CardPlacementInfo[]>(
          `/api/cards/${card.id}/placements`
        );
        set({ focusShelf: [...get().focusShelf, { card, placements }] });
        void get().touchCard(card.id);
      }
    } catch {
      get().showToast("Could not update the focus shelf");
    }
  },

  /** Ignores changes under a pixel. The measurement feeds the layout that
   * sizes the card being measured, so anything jittery here would re-render
   * for ever. */
  reportMemberHeight: (placementId, height) => {
    const current = get().memberHeights;
    if (height === null) {
      if (!(placementId in current)) return;
      const next = { ...current };
      delete next[placementId];
      set({ memberHeights: next });
      return;
    }
    const rounded = Math.round(height);
    if (Math.abs((current[placementId] ?? -1) - rounded) < 1) return;
    set({ memberHeights: { ...current, [placementId]: rounded } });
  },

  loadCapabilities: async () => {
    try {
      const status = await api.get<{ generation_configured: boolean }>(
        "/api/search/status"
      );
      set({ generationAvailable: status.generation_configured });
    } catch {
      set({ generationAvailable: false });
    }
  },

  /** Break a long card into inbox cards.
   *
   * The work happens on the worker, so this polls the batch rather than
   * guessing at a duration — a small model on CPU can take minutes. Nothing
   * is written to the canvas either way: the result is a pile of unplaced
   * cards waiting to be arranged. */
  splitCard: async (cardId) => {
    let batchId: string;
    try {
      const started = await api.post<{ batch_id: string }>(
        `/api/cards/${cardId}/split`
      );
      batchId = started.batch_id;
    } catch (err) {
      get().showToast(
        err instanceof Error ? err.message : "Could not split that card"
      );
      return;
    }

    get().showToast("Splitting… new cards will appear in your inbox.");
    const deadline = Date.now() + 5 * 60 * 1000;

    const poll = async () => {
      try {
        const status = await api.get<BatchStatus>(`/api/inbox/batches/${batchId}`);
        if (status.status === "queued" || status.status === "running") {
          if (Date.now() < deadline) window.setTimeout(poll, 2500);
          else get().showToast("The split is taking a long time; check the inbox later.");
          return;
        }
        await get().loadInbox();
        if (status.status === "error") {
          get().showToast("The model could not split that card.");
        } else if (status.cards.length === 0) {
          get().showToast("The model returned nothing usable. Nothing was added.");
        } else {
          get().setInboxOpen(true);
          get().showToast(
            `Added ${status.cards.length} card${
              status.cards.length === 1 ? "" : "s"
            } to your inbox.`
          );
        }
      } catch {
        get().showToast("Lost track of that split. Check the inbox.");
      }
    };
    window.setTimeout(poll, 2000);
  },

  composeCards: async (cardIds, position) => {
    const { canvasId } = get();
    if (!canvasId || cardIds.length < 2) return;
    let batchId: string;
    try {
      const started = await api.post<{ batch_id: string }>(
        `/api/canvases/${canvasId}/compose`,
        { card_ids: cardIds, x: position.x, y: position.y }
      );
      batchId = started.batch_id;
    } catch (err) {
      get().showToast(
        err instanceof Error ? err.message : "Could not start the document"
      );
      return;
    }

    get().showToast("Drafting a document from the selected cards…");
    const deadline = Date.now() + 5 * 60 * 1000;
    const poll = async () => {
      try {
        const status = await api.get<CompositionStatus>(
          `/api/compositions/${batchId}`
        );
        if (status.status === "queued" || status.status === "running") {
          if (Date.now() < deadline) window.setTimeout(poll, 2500);
          else get().showToast("The draft is taking a while; it may appear shortly.");
          return;
        }
        if (status.status === "error") {
          get().showToast("The model could not draft that document.");
          return;
        }
        if (!status.card || !status.placement) {
          get().showToast("The model returned no usable document.");
          return;
        }
        await get().loadCanvas(canvasId);
        const placementId = status.placement.id;
        set({ selection: [placementId], editOnMount: placementId });
        get().setNodes((nodes) =>
          nodes.map((node) => ({ ...node, selected: node.id === placementId }))
        );
        get().showToast("Document drafted from the selected cards.");
      } catch {
        get().showToast("Lost track of that draft. Reload the canvas in a moment.");
      }
    };
    window.setTimeout(poll, 2000);
  },

  refreshComposition: async (cardId) => {
    let batchId: string;
    try {
      const started = await api.post<{ batch_id: string }>(
        `/api/cards/${cardId}/refresh-composition`
      );
      batchId = started.batch_id;
    } catch (err) {
      get().showToast(
        err instanceof Error ? err.message : "Could not refresh the document"
      );
      return;
    }

    get().showToast("Refreshing changed source material…");
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      try {
        const status = await api.get<CompositionStatus>(
          `/api/compositions/${batchId}`
        );
        if (status.status === "queued" || status.status === "running") continue;
        if (status.status === "error" || !status.card) {
          get().showToast("The model could not refresh this document.");
          return;
        }
        await get().refreshCardFromServer(cardId, status.card);
        const refresh = (
          status.card.payload.living_document as {
            last_refresh?: {
              batch_id?: string;
              refreshed_blocks?: number;
              preserved_blocks?: number;
            };
          } | undefined
        )?.last_refresh;
        if (refresh?.batch_id !== batchId) {
          get().showToast("The model returned no usable refreshed document.");
          return;
        }
        const preserved = refresh?.preserved_blocks ?? 0;
        get().showToast(
          preserved > 0
            ? `Document refreshed; ${preserved} edited block${preserved === 1 ? " was" : "s were"} preserved.`
            : "Document refreshed from its source cards."
        );
        return status.card;
      } catch {
        get().showToast("Lost track of that refresh. Reload the canvas in a moment.");
        return;
      }
    }
    get().showToast("The refresh is taking a while; check the document shortly.");
  },

  discardBatch: async (batchId) => {
    const resp = await api.delete<{ discarded: number }>(
      `/api/inbox/batches/${batchId}`
    );
    await get().loadInbox();
    get().showToast(
      `Discarded ${resp.discarded} card${resp.discarded === 1 ? "" : "s"}.`
    );
  },

  clearInbox: async () => {
    const resp = await api.delete<{ discarded: number }>("/api/inbox");
    set({ inbox: [] });
    get().showToast(
      `Cleared ${resp.discarded} card${resp.discarded === 1 ? "" : "s"}.`
    );
  },

  setNodes: (updater) => set({ nodes: updater(get().nodes) }),

  setSelection: (ids) => set({ selection: ids }),

  focusCards: (cardIds) => set({ pendingFocusCardIds: cardIds }),

  clearPendingFocus: () => set({ pendingFocusCardIds: null }),

  setInboxOpen: (open) => {
    localStorage.setItem("inboxOpen", String(open));
    set({ inboxOpen: open });
  },

  clearEditOnMount: () => set({ editOnMount: null }),

  showToast: (message) => {
    set({ toast: message });
    window.setTimeout(() => {
      if (get().toast === message) set({ toast: null });
    }, 4000);
  },

  createCardAt: async (x, y, body, editNow, type = "text", payload = {}, title) => {
    const { canvasId } = get();
    if (!canvasId) return;
    const resp = await api.post<{ card: Card; placement: Placement }>("/api/cards", {
      type,
      title,
      body,
      payload,
      canvas_id: canvasId,
      x,
      y,
    });
    const node = toNode({
      id: resp.placement.id,
      x: resp.placement.x,
      y: resp.placement.y,
      w: resp.placement.w,
      h: resp.placement.h,
      z: resp.placement.z,
      is_hub: resp.placement.is_hub,
      parent_id: resp.placement.parent_id,
      sort: resp.placement.sort,
      card: resp.card,
    });
    // Clear any active reveal: a brand new card is not part of it, and
    // leaving the reveal up would render the card dimmed at birth.
    set({
      nodes: [...get().nodes, node],
      editOnMount: editNow ? resp.placement.id : null,
      reveal: null,
      revealAnchor: null,
      selectedLinkId: null,
      searchMatches: null,
      searchHits: [],
      searchLinkHits: [],
    });
    void get().touchCard(resp.card.id);
    return resp.card;
  },

  createColumn: async (x, y, title) => {
    await get().createCardAt(x, y, "", false, "column", {});
    const created = get().nodes[get().nodes.length - 1];
    if (created) await get().updateCard(created.data.card.id, { title });
  },

  moveIntoColumn: async (placementId, columnId, slot, droppedAt) => {
    const nodes = get().nodes;
    const moving = nodes.find((n) => n.id === placementId);
    if (!moving) return;

    // Everything already in the destination, minus the card being moved.
    const siblings = nodes
      .filter((n) => n.data.parentId === columnId && n.id !== placementId)
      .sort((a, b) => (a.data.sort ?? 0) - (b.data.sort ?? 0));
    const ordered = [
      ...siblings.slice(0, slot),
      moving,
      ...siblings.slice(slot),
    ];

    // Optimistic: reordering a stack should not wait on a round trip.
    set({
      nodes: nodes.map((n) => {
        const index = ordered.findIndex((o) => o.id === n.id);
        if (index === -1) return n;
        return {
          ...n,
          data: { ...n.data, parentId: columnId, sort: index },
          ...(n.id === placementId && !columnId && droppedAt
            ? { position: droppedAt }
            : {}),
        };
      }),
    });

    try {
      await Promise.all(
        ordered.map((node, index) =>
          api.patch(`/api/placements/${node.id}`, {
            ...(node.id === placementId
              ? columnId
                ? { parent_id: columnId }
                : { clear_parent: true, ...(droppedAt ?? {}) }
              : {}),
            sort: index,
          })
        )
      );
    } catch (err) {
      const { canvasId } = get();
      if (canvasId) await get().loadCanvas(canvasId);
      get().showToast(
        err instanceof Error ? err.message : "Could not move that card"
      );
    }
  },

  moveManyIntoColumn: async (placementIds, columnId, slot) => {
    const nodes = get().nodes;
    const movingIds = new Set(placementIds);
    const moving = placementIds
      .map((id) => nodes.find((node) => node.id === id))
      .filter((node): node is CardNode => Boolean(node));
    if (moving.length === 0) return;

    // Build the destination order once. Calling the single-card operation for
    // every selected card would rewrite every sibling after every insertion,
    // multiplying both renders and PATCH requests for larger groups.
    const siblings = nodes
      .filter(
        (node) => node.data.parentId === columnId && !movingIds.has(node.id)
      )
      .sort((a, b) => (a.data.sort ?? 0) - (b.data.sort ?? 0));
    const insertion = Math.max(0, Math.min(slot, siblings.length));
    const ordered = [
      ...siblings.slice(0, insertion),
      ...moving,
      ...siblings.slice(insertion),
    ];
    const orderById = new Map(ordered.map((node, index) => [node.id, index]));

    set({
      nodes: nodes.map((node) => {
        const index = orderById.get(node.id);
        if (index === undefined) return node;
        return {
          ...node,
          data: { ...node.data, parentId: columnId, sort: index },
        };
      }),
    });

    try {
      await Promise.all(
        ordered.map((node, index) =>
          api.patch(`/api/placements/${node.id}`, {
            ...(movingIds.has(node.id) ? { parent_id: columnId } : {}),
            sort: index,
          })
        )
      );
    } catch (err) {
      const { canvasId } = get();
      if (canvasId) await get().loadCanvas(canvasId);
      get().showToast(
        err instanceof Error ? err.message : "Could not move those cards"
      );
    }
  },

  createBoard: async (x, y, name) => {
    const { canvasId } = get();
    if (!canvasId) return;
    try {
      const size = initialCanvasSize();
      const resp = await api.post<{ card: Card; placement: Placement }>(
        `/api/canvases/${canvasId}/boards`,
        { name, x, y, width: size.width, height: size.height }
      );
      set({
        nodes: [
          ...get().nodes,
          toNode({
            id: resp.placement.id,
            x: resp.placement.x,
            y: resp.placement.y,
            w: resp.placement.w,
            h: resp.placement.h,
            z: resp.placement.z,
            is_hub: resp.placement.is_hub,
            parent_id: resp.placement.parent_id,
            sort: resp.placement.sort,
            card: resp.card,
          }),
        ],
        reveal: null,
        revealAnchor: null,
      });
      void get().touchCard(resp.card.id);
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : "Could not make that board");
    }
  },

  /** Any attachment as a card. Mirrors createImageCard, minus the shaping:
   * there is nothing to measure, so the default box is the right box. */
  createFileCard: async (x, y, file) => {
    const { canvasId } = get();
    if (!canvasId) return;
    try {
      const resp = await api.post<{ card: Card; placement: Placement }>("/api/cards", {
        type: "file",
        canvas_id: canvasId,
        x,
        y,
      });
      const form = new FormData();
      form.append("file", file);
      const upload = await fetch(`/api/cards/${resp.card.id}/file`, {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (!upload.ok) {
        const data = await upload.json().catch(() => null);
        // A file card with no file is worse than no card at all.
        await api.delete(`/api/cards/${resp.card.id}`);
        get().showToast(data?.error?.message ?? "Could not upload that file");
        return;
      }
      const card = (await upload.json()) as Card;
      set({
        nodes: [
          ...get().nodes,
          toNode({
            id: resp.placement.id,
            x: resp.placement.x,
            y: resp.placement.y,
            w: resp.placement.w,
            h: resp.placement.h,
            z: resp.placement.z,
            is_hub: resp.placement.is_hub,
            parent_id: resp.placement.parent_id,
            sort: resp.placement.sort,
            card,
          }),
        ],
        reveal: null,
        revealAnchor: null,
      });
      get().savePlacement(resp.placement.id);
      void get().touchCard(card.id);
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : "Could not add the file");
    }
  },

  createImageCard: async (x, y, file) => {
    const { canvasId } = get();
    if (!canvasId) return;
    // Size the card to the picture rather than dropping the picture into a
    // fixed box, so there are no letterbox bars to explain away.
    const shape = await imageShape(file);
    try {
      const resp = await api.post<{ card: Card; placement: Placement }>("/api/cards", {
        type: "image",
        canvas_id: canvasId,
        x,
        y,
      });
      const form = new FormData();
      form.append("file", file);
      const upload = await fetch(`/api/cards/${resp.card.id}/image`, {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (!upload.ok) {
        const data = await upload.json().catch(() => null);
        // A card with no image is worse than no card at all.
        await api.delete(`/api/cards/${resp.card.id}`);
        get().showToast(data?.error?.message ?? "Could not upload that image");
        return;
      }
      const card = (await upload.json()) as Card;
      const width = resp.placement.w;
      const height = shape
        ? Math.round(
            Math.min(
              IMAGE_MAX_HEIGHT,
              Math.max(IMAGE_MIN_HEIGHT, (width * shape.height) / shape.width)
            )
          )
        : resp.placement.h;
      set({
        nodes: [
          ...get().nodes,
          toNode({
            id: resp.placement.id,
            x: resp.placement.x,
            y: resp.placement.y,
            w: width,
            h: height,
            z: resp.placement.z,
            is_hub: resp.placement.is_hub,
            parent_id: resp.placement.parent_id,
            sort: resp.placement.sort,
            card,
          }),
        ],
        reveal: null,
        revealAnchor: null,
      });
      if (height !== resp.placement.h) get().savePlacement(resp.placement.id);
      void get().touchCard(card.id);
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : "Could not add the image");
    }
  },

  placeInboxCard: async (cardId, x, y) => {
    const { canvasId, inbox } = get();
    if (!canvasId) return;
    const card = inbox.find((c) => c.id === cardId);
    if (!card) return;
    // Optimistic: leave the panel immediately, return on failure.
    set({ inbox: inbox.filter((c) => c.id !== cardId) });
    try {
      const placement = await api.post<Placement>(
        `/api/canvases/${canvasId}/placements`,
        { card_id: cardId, x, y }
      );
      set({
        nodes: [
          ...get().nodes,
          toNode({
            id: placement.id,
            x: placement.x,
            y: placement.y,
            w: placement.w,
            h: placement.h,
            z: placement.z,
            is_hub: placement.is_hub,
            parent_id: placement.parent_id,
            sort: placement.sort,
            card,
          }),
        ],
      });
      void get().touchCard(cardId);
    } catch (err) {
      set({ inbox: [card, ...get().inbox] });
      get().showToast(
        err instanceof Error ? err.message : "Could not place the card"
      );
    }
  },

  savePlacement: (placementId) => {
    // Debounced 200ms, fired on drop — never during the drag.
    const existing = saveTimers.get(placementId);
    if (existing !== undefined) window.clearTimeout(existing);
    saveTimers.set(
      placementId,
      window.setTimeout(async () => {
        saveTimers.delete(placementId);
        const node = get().nodes.find((n) => n.id === placementId);
        if (!node) return;
        const before = { ...node.position, w: node.data.w, h: node.data.h };
        try {
          await api.patch(`/api/placements/${placementId}`, {
            x: node.position.x,
            y: node.position.y,
            w: node.data.w,
            h: node.data.h,
          });
          void get().touchCard(node.data.card.id);
        } catch {
          // Rollback: reload authoritative state and say so.
          const { canvasId } = get();
          if (canvasId) await get().loadCanvas(canvasId);
          get().showToast(
            `Could not save a card position (was at ${Math.round(before.x)}, ${Math.round(before.y)})`
          );
        }
      }, 200)
    );
  },

  updateCard: async (cardId, patch) => {
    const updated = await api.patch<Card>(`/api/cards/${cardId}`, patch);
    set({
      nodes: get().nodes.map((n) =>
        n.data.card.id === cardId ? { ...n, data: { ...n.data, card: updated } } : n
      ),
      inbox: get().inbox.map((c) => (c.id === cardId ? updated : c)),
      focusShelf: get().focusShelf.map((item) =>
        item.card.id === cardId ? { ...item, card: updated } : item
      ),
    });
    void get().touchCard(cardId);
    // Inline card references are graph links derived by the backend from the
    // body. Refresh just the relationship state after a body save so a new
    // reference appears (or a removed one disappears) without reloading the
    // canvas and disturbing an open document editor.
    if ("body" in patch && get().canvasId) {
      const detail = await api.get<CanvasDetail>(`/api/canvases/${get().canvasId}`);
      set({ canvasLinks: detail.links });
      const { reveal, revealAnchor } = get();
      if (reveal && revealAnchor) {
        await get().loadReveal(reveal.root_card_id, revealAnchor);
      }
    }
  },

  refreshCardFromServer: async (cardId, card) => {
    set({
      nodes: get().nodes.map((n) =>
        n.data.card.id === cardId ? { ...n, data: { ...n.data, card } } : n
      ),
      inbox: get().inbox.map((c) => (c.id === cardId ? card : c)),
      focusShelf: get().focusShelf.map((item) =>
        item.card.id === cardId ? { ...item, card } : item
      ),
    });
  },

  removePlacements: async (placementIds) => {
    const removed = get().nodes.filter((n) => placementIds.includes(n.id));
    for (const node of removed) {
      get().pushUndo({
        kind: "removed",
        cardId: node.data.card.id,
        x: node.position.x,
        y: node.position.y,
        w: node.data.w,
        h: node.data.h,
      });
    }
    set({
      nodes: get().nodes.filter((n) => !placementIds.includes(n.id)),
      selection: [],
    });
    try {
      await Promise.all(
        placementIds.map((id) => api.delete(`/api/placements/${id}`))
      );
      await get().loadInbox();
    } catch {
      set({ nodes: [...get().nodes, ...removed] });
      get().showToast("Could not remove a card from the canvas");
    }
  },

  deleteCard: async (cardId) => {
    await api.delete(`/api/cards/${cardId}`);
    set({
      nodes: get().nodes.filter((n) => n.data.card.id !== cardId),
      inbox: get().inbox.filter((c) => c.id !== cardId),
      focusShelf: get().focusShelf.filter((item) => item.card.id !== cardId),
      dailyCardId: get().dailyCardId === cardId ? null : get().dailyCardId,
      canvasLinks: get().canvasLinks.filter(
        (link) =>
          link.source_card_id !== cardId && link.target_card_id !== cardId
      ),
      selection: [],
      reveal: null,
      revealAnchor: null,
    });
  },

  loadReveal: async (cardId, anchor) => {
    const { canvasId } = get();
    const qs = canvasId ? `?canvas_id=${canvasId}` : "";
    try {
      const reveal = await api.get<RevealOut>(`/api/cards/${cardId}/reveal${qs}`);
      const wanted = get().focusLinkId;
      set({
        reveal,
        revealAnchor: anchor,
        selectedLinkId:
          wanted && reveal.links.some((l) => l.id === wanted) ? wanted : null,
        focusLinkId: null,
      });
    } catch {
      set({ reveal: null, revealAnchor: null });
    }
  },

  clearReveal: () =>
    set({ reveal: null, revealAnchor: null, selectedLinkId: null }),

  setSelectedLinkId: (linkId) => set({ selectedLinkId: linkId }),

  setFocusLink: (linkId) => set({ focusLinkId: linkId }),

  setLinkPickerFor: (cardId) => set({ linkPickerFor: cardId }),

  setPlaceOnBoardFor: (request) => set({ placeOnBoardFor: request }),

  setMenuOpenFor: (placementId) => set({ menuOpenFor: placementId }),

  createLink: async (sourceCardId, targetCardId) => {
    const { canvasId } = get();
    try {
      const link = await api.post<Link>("/api/links", {
        source_card_id: sourceCardId,
        target_card_id: targetCardId,
        created_on_canvas_id: canvasId,
      });
      // Keep the canvas's link list current, otherwise child counts — and so
      // the hub control — stay stale until the page is reloaded.
      const onCanvas = new Set(get().nodes.map((n) => n.data.card.id));
      if (onCanvas.has(sourceCardId) && onCanvas.has(targetCardId)) {
        set({ canvasLinks: [...get().canvasLinks, link] });
      }
      void get().touchCard(sourceCardId);
      void get().touchCard(targetCardId);
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : "Could not create the link");
      return;
    }
    const { reveal, revealAnchor } = get();
    if (reveal && revealAnchor) {
      await get().loadReveal(reveal.root_card_id, revealAnchor);
    }
  },

  updateLink: async (linkId, patch) => {
    await api.patch(`/api/links/${linkId}`, patch);
    const { reveal, revealAnchor } = get();
    if (reveal && revealAnchor) {
      await get().loadReveal(reveal.root_card_id, revealAnchor);
    }
  },

  flipLink: async (linkId) => {
    try {
      await api.post(`/api/links/${linkId}/flip`, {});
    } catch (err) {
      get().showToast(
        err instanceof Error ? err.message : "Could not turn that link around"
      );
      return;
    }
    /* The canvas's own copy has to turn around too. Child counts, and so
     * which cards a hub folds away, are read off the direction of these. */
    set({
      canvasLinks: get().canvasLinks.map((l) =>
        l.id === linkId
          ? {
              ...l,
              source_card_id: l.target_card_id,
              target_card_id: l.source_card_id,
              source_snapshot: l.target_snapshot,
              target_snapshot: l.source_snapshot,
            }
          : l
      ),
    });
    const { reveal, revealAnchor } = get();
    if (reveal && revealAnchor) {
      await get().loadReveal(reveal.root_card_id, revealAnchor);
    }
  },

  deleteLink: async (linkId) => {
    await api.delete(`/api/links/${linkId}`);
    const { reveal, revealAnchor } = get();
    set({
      selectedLinkId: null,
      canvasLinks: get().canvasLinks.filter((l) => l.id !== linkId),
    });
    if (reveal && revealAnchor) {
      await get().loadReveal(reveal.root_card_id, revealAnchor);
    }
  },

  toggleHub: async (placementId) => {
    const node = get().nodes.find((n) => n.id === placementId);
    if (!node) return;
    const next = !node.data.isHub;
    // Optimistic: folding a group should feel instant.
    set({
      nodes: get().nodes.map((n) =>
        n.id === placementId ? { ...n, data: { ...n.data, isHub: next } } : n
      ),
    });
    try {
      await api.patch(`/api/placements/${placementId}`, { is_hub: next });
    } catch (err) {
      set({
        nodes: get().nodes.map((n) =>
          n.id === placementId ? { ...n, data: { ...n.data, isHub: !next } } : n
        ),
      });
      get().showToast(
        err instanceof Error ? err.message : "Could not change that card"
      );
    }
  },

  addGhostToCanvas: async (cardId, x, y) => {
    const { canvasId, reveal, revealAnchor } = get();
    if (!canvasId) return;
    try {
      const placement = await api.post<Placement>(
        `/api/canvases/${canvasId}/placements`,
        { card_id: cardId, x, y }
      );
      const entry = reveal?.cards[cardId];
      if (entry) {
        set({
          nodes: [
            ...get().nodes,
            toNode({
              id: placement.id,
              x: placement.x,
              y: placement.y,
              w: placement.w,
              h: placement.h,
              z: placement.z,
              is_hub: placement.is_hub,
              parent_id: placement.parent_id,
              sort: placement.sort,
              card: entry.card,
            }),
          ],
        });
      } else {
        await get().loadCanvas(canvasId);
      }
      if (reveal && revealAnchor) {
        await get().loadReveal(reveal.root_card_id, revealAnchor);
      }
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : "Could not add the card");
    }
  },

  recreateFromTombstone: async (linkId, side) => {
    const { reveal, revealAnchor } = get();
    try {
      const resp = await api.post<{ card: Card }>(
        `/api/links/${linkId}/recreate?side=${side}`
      );
      // The recreated card is unplaced; surface it in the inbox and refresh
      // the reveal so the tombstone becomes a ghost.
      await get().loadInbox();
      if (reveal && revealAnchor) {
        await get().loadReveal(reveal.root_card_id, revealAnchor);
      }
      get().showToast(`Recreated "${resp.card.title ?? "card"}" — it's in your inbox`);
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : "Could not recreate the card");
    }
  },

  pushUndo: (op) => {
    const stack = [...get().undoStack, op];
    set({ undoStack: stack.slice(-UNDO_LIMIT) });
  },

  undo: async () => {
    const stack = [...get().undoStack];
    const op = stack.pop();
    if (!op) {
      get().showToast("Nothing to undo");
      return;
    }
    set({ undoStack: stack });

    if (op.kind === "geometry") {
      const node = get().nodes.find((n) => n.id === op.placementId);
      if (!node) return;
      set({
        nodes: get().nodes.map((n) =>
          n.id === op.placementId
            ? {
                ...n,
                position: { x: op.x, y: op.y },
                width: op.w,
                height: op.h,
                data: { ...n.data, w: op.w, h: op.h },
              }
            : n
        ),
      });
      try {
        await api.patch(`/api/placements/${op.placementId}`, {
          x: op.x,
          y: op.y,
          w: op.w,
          h: op.h,
        });
      } catch {
        get().showToast("Could not undo that move");
      }
      return;
    }

    if (op.kind === "geometry-group") {
      const byId = new Map(op.items.map((item) => [item.placementId, item]));
      set({
        nodes: get().nodes.map((node) => {
          const item = byId.get(node.id);
          return item
            ? {
                ...node,
                position: { x: item.x, y: item.y },
                width: item.w,
                height: item.h,
                data: { ...node.data, w: item.w, h: item.h },
              }
            : node;
        }),
      });
      try {
        await Promise.all(
          op.items.map((item) =>
            api.patch(`/api/placements/${item.placementId}`, {
              x: item.x,
              y: item.y,
              w: item.w,
              h: item.h,
            })
          )
        );
      } catch {
        get().showToast("Could not undo that arrangement");
      }
      return;
    }

    // Restoring a removed placement makes a new one at the old geometry.
    const { canvasId } = get();
    if (!canvasId) return;
    try {
      const placement = await api.post<Placement>(
        `/api/canvases/${canvasId}/placements`,
        { card_id: op.cardId, x: op.x, y: op.y }
      );
      await api.patch(`/api/placements/${placement.id}`, { w: op.w, h: op.h });
      await get().loadCanvas(canvasId);
      await get().loadInbox();
    } catch {
      get().showToast("Could not restore that card");
    }
  },

  openLightbox: (media) => set({ lightbox: media }),

  closeLightbox: () => set({ lightbox: null }),

  setSearchOpen: (open) => {
    set({ searchOpen: open });
    if (!open) get().clearSearch();
  },

  runSearch: async (query, mode) => {
    if (!query.trim()) {
      set({ searchHits: [], searchLinkHits: [], searchMatches: null });
      return [];
    }
    const data = await api.get<{ hits: SearchHit[]; link_hits: LinkHit[] }>(
      `/api/search?q=${encodeURIComponent(query)}&mode=${mode}`
    );
    const { canvasId } = get();
    // Matching cards on this canvas light up in place; the rest are listed.
    const matches = data.hits
      .flatMap((hit) => hit.placements)
      .filter((p) => p.canvas_id === canvasId)
      .map((p) => p.id);
    set({
      searchHits: data.hits,
      searchLinkHits: data.link_hits ?? [],
      searchMatches: matches,
    });
    return matches;
  },

  clearSearch: () =>
    set({ searchHits: [], searchLinkHits: [], searchMatches: null }),
}));
