import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  useReactFlow,
  type Connection,
  type CoordinateExtent,
  type Edge,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
  type Viewport,
} from "@xyflow/react";
import { api } from "../api/client";
import type {
  CanvasAppearance,
  CanvasSummary,
  Card,
  CardPlacementInfo,
  CardType,
} from "../api/types";
import { URL_PATTERN, YOUTUBE_PATTERN } from "../lib/urls";
import {
  INBOX_TOUCH_DROP_EVENT,
  type InboxTouchDropDetail,
} from "../lib/inboxTouchDrag";
import {
  MAX_CANVAS_TEXT_SIZE,
  MIN_CANVAS_TEXT_SIZE,
} from "../lib/canvasTextSize";
import BoardPicker from "../components/BoardPicker";
import CardNode from "../components/CardNode";
import CanvasZone from "../components/CanvasZone";
import CheatSheet from "../components/CheatSheet";
import ColumnNode from "../components/ColumnNode";
import GhostNode from "../components/GhostNode";
import InboxPanel from "../components/InboxPanel";
import FocusShelf from "../components/FocusShelf";
import LinkPanel from "../components/LinkPanel";
import Lightbox from "../components/Lightbox";
import LinkEdge from "../components/LinkEdge";
import LinkPicker from "../components/LinkPicker";
import Logo from "../components/Logo";
import SearchOverlay from "../components/SearchOverlay";
import SuggestionsPanel from "../components/SuggestionsPanel";
import PortalEditor from "../components/PortalEditor";
import PublicLensDialog from "../components/PublicLensDialog";
import { PORTAL_REFRESH_EVENT } from "../components/PortalCardBody";
import TombstoneNode from "../components/TombstoneNode";
import { useCanvasStore, type CardNode as CardNodeType } from "../store/canvasStore";
import {
  MEMBER_WIDTH,
  layoutColumns,
  memberOffset,
  slotForOffset,
} from "../store/columnLayout";
import { confirmDialog, promptDialog } from "../store/dialogStore";
import { buildRevealGraph } from "../store/revealGraph";
import Icon, { type IconName } from "../components/Icon";
import { cycleTheme } from "../theme";
import "./canvasPage.css";

const nodeTypes = {
  card: CardNode,
  column: ColumnNode,
  ghost: GhostNode,
  tombstone: TombstoneNode,
};
const edgeTypes = { link: LinkEdge };

/** Rendered height of a card folded away by its hub. */
const COLLAPSED_HEIGHT = 46;
/** Temporary container treatment based on the flat-list design study.
 * Flip this to false to compare against the established column presentation
 * without deleting the experiment or disturbing any saved canvas data. */
const CONTAINER_LAYOUT_STUDY = true;

const CANVAS_APPEARANCES: Array<{ id: CanvasAppearance; label: string }> = [
  { id: "studio", label: "Studio" },
  { id: "pantry", label: "Pantry" },
  { id: "night_garden", label: "Night Garden" },
];

/** Where a node goes while its own menu is open, so nothing covers it. */
const MENU_LAYER = 5000;

/** What the toolbar offers, in the order it offers it. Each one is draggable
 * onto the board; `newCardOfType` decides what a dropped one starts as. */
const PRIMARY_TOOLS: { kind: CardType; label: string; icon: IconName }[] = [
  { kind: "text", label: "Note", icon: "note" },
  { kind: "document", label: "Document", icon: "document" },
  { kind: "checklist", label: "To-do", icon: "checklist" },
];

/** Structured, navigational and media cards are valuable but less frequent.
 * Keeping them in one fully labelled menu leaves the everyday writing tools
 * visible without turning every action into an unexplained icon. */
const MORE_TOOLS: { kind: CardType; label: string; icon: IconName }[] = [
  { kind: "table", label: "Table", icon: "table" },
  { kind: "audio", label: "Audio", icon: "audio" },
  { kind: "column", label: "Column", icon: "column" },
  { kind: "board", label: "Board", icon: "board" },
  { kind: "portal", label: "Portal", icon: "portal" },
];

/** How far two cards must genuinely overlap, on both axes, before dropping
 * one on the other links them. A corner graze is almost always someone
 * arranging a board rather than drawing a connection. */
const MIN_OVERLAP = 14;
const ALIGN_GUIDE_ENTER_PX = 3;
const ALIGN_GUIDE_RELEASE_PX = 6;
const ALIGN_GUIDE_REACH_PX = 140;
const ALIGN_GUIDE_DUAL_AXIS_PX = 1.25;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface AlignmentGuides {
  x: number | null;
  y: number | null;
  stroke: number;
}

interface AlignmentCandidate {
  coordinate: number;
  distance: number;
  targetId: string;
}

function minimapNodeColor(node: Node): string {
  const type = (node.data as CardNodeType["data"] | undefined)?.card?.type;
  return type ? `var(--cardtype-${type}, var(--minimap-node))` : "var(--minimap-node)";
}

/** Column geometry depends on membership and stored sizes, not x/y. xyflow
 * replaces the dragged node object on every pointer move, so keying the
 * layout directly on the nodes array rebuilt every stack on every frame. */
function sameColumnInputs(a: CardNodeType[], b: CardNodeType[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.data.card.type !== right.data.card.type ||
      left.data.parentId !== right.data.parentId ||
      left.data.sort !== right.data.sort ||
      left.data.w !== right.data.w ||
      left.data.h !== right.data.h
    ) {
      return false;
    }
  }
  return true;
}

function viewportKey(canvasId: string) {
  return `viewport:${canvasId}`;
}

function loadViewport(canvasId: string): Viewport {
  try {
    const raw = localStorage.getItem(viewportKey(canvasId));
    if (raw) return JSON.parse(raw) as Viewport;
  } catch {
    // fall through to the default
  }
  return { x: 0, y: 0, zoom: 1 };
}

function CanvasInner({ canvasId }: { canvasId: string }) {
  const canvasName = useCanvasStore((s) => s.canvasName);
  const canvasInfinite = useCanvasStore((s) => s.canvasInfinite);
  const canvasWidth = useCanvasStore((s) => s.canvasWidth);
  const canvasHeight = useCanvasStore((s) => s.canvasHeight);
  const canvasAppearance = useCanvasStore((s) => s.canvasAppearance);
  const updateCanvasAppearance = useCanvasStore((s) => s.updateCanvasAppearance);
  const canvasTextSize = useCanvasStore((s) => s.canvasTextSize);
  const updateCanvasTextSize = useCanvasStore((s) => s.updateCanvasTextSize);
  const role = useCanvasStore((s) => s.role);
  const nodes = useCanvasStore((s) => s.nodes);
  const zones = useCanvasStore((s) => s.zones);
  const setNodes = useCanvasStore((s) => s.setNodes);
  const selection = useCanvasStore((s) => s.selection);
  const setSelection = useCanvasStore((s) => s.setSelection);
  const pendingFocusCardIds = useCanvasStore((s) => s.pendingFocusCardIds);
  const clearPendingFocus = useCanvasStore((s) => s.clearPendingFocus);
  const loadCanvas = useCanvasStore((s) => s.loadCanvas);
  const loadInbox = useCanvasStore((s) => s.loadInbox);
  const loadCapabilities = useCanvasStore((s) => s.loadCapabilities);
  const loadProductivity = useCanvasStore((s) => s.loadProductivity);
  const generationAvailable = useCanvasStore((s) => s.generationAvailable);
  const composeCards = useCanvasStore((s) => s.composeCards);
  const createCardAt = useCanvasStore((s) => s.createCardAt);
  const createImageCard = useCanvasStore((s) => s.createImageCard);
  const createFileCard = useCanvasStore((s) => s.createFileCard);
  const createBoard = useCanvasStore((s) => s.createBoard);
  const createColumn = useCanvasStore((s) => s.createColumn);
  const createZone = useCanvasStore((s) => s.createZone);
  const moveIntoColumn = useCanvasStore((s) => s.moveIntoColumn);
  const moveManyIntoColumn = useCanvasStore((s) => s.moveManyIntoColumn);
  const showToast = useCanvasStore((s) => s.showToast);
  const placeInboxCard = useCanvasStore((s) => s.placeInboxCard);
  const savePlacement = useCanvasStore((s) => s.savePlacement);
  const removePlacements = useCanvasStore((s) => s.removePlacements);
  const reveal = useCanvasStore((s) => s.reveal);
  const revealAnchor = useCanvasStore((s) => s.revealAnchor);
  const loadReveal = useCanvasStore((s) => s.loadReveal);
  const clearReveal = useCanvasStore((s) => s.clearReveal);
  const setSelectedLinkId = useCanvasStore((s) => s.setSelectedLinkId);
  const createLink = useCanvasStore((s) => s.createLink);
  const toast = useCanvasStore((s) => s.toast);
  const pushUndo = useCanvasStore((s) => s.pushUndo);
  const undo = useCanvasStore((s) => s.undo);
  const searchMatches = useCanvasStore((s) => s.searchMatches);
  const setSearchOpen = useCanvasStore((s) => s.setSearchOpen);
  const canvasLinks = useCanvasStore((s) => s.canvasLinks);
  const menuOpenFor = useCanvasStore((s) => s.menuOpenFor);
  const setMenuOpenFor = useCanvasStore((s) => s.setMenuOpenFor);
  const growCanvasForContent = useCanvasStore((s) => s.growCanvasForContent);
  const canvasExtent = useMemo<CoordinateExtent | undefined>(
    () => canvasInfinite ? undefined : [[0, 0], [canvasWidth, canvasHeight]],
    [canvasInfinite, canvasWidth, canvasHeight]
  );

  const readOnly = role === "viewer";
  const [cheatOpen, setCheatOpen] = useState(false);
  const [publicLensOpen, setPublicLensOpen] = useState(false);
  const [portalAt, setPortalAt] = useState<{ x: number; y: number } | null>(null);
  // Transient drag state: the card a drop would link, and the column it would
  // drop into. What un-dims is derived from these, not from distance.
  const [linkTarget, setLinkTarget] = useState<string | null>(null);
  const [columnTarget, setColumnTarget] = useState<
    { id: string; slot: number; movingIds: string[] } | null
  >(null);
  const [dragging, setDragging] = useState(false);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuides | null>(
    null
  );

  const { screenToFlowPosition, fitView, getZoom, getViewport } = useReactFlow();
  const [searchParams, setSearchParams] = useSearchParams();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const moreToolsRef = useRef<HTMLDetailsElement>(null);
  const appearancePickerRef = useRef<HTMLDetailsElement>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const touchSelection = useRef<{
    pointerId: number;
    nodeId: string;
    startX: number;
    startY: number;
    timer: number;
    activated: boolean;
    desired: string[] | null;
    selectionBefore: string[];
  } | null>(null);

  useEffect(() => {
    const closeAppearancePicker = (event: PointerEvent) => {
      const picker = appearancePickerRef.current;
      const target = event.target;
      if (picker?.open && target instanceof Element && !picker.contains(target)) {
        picker.open = false;
      }
    };
    document.addEventListener("pointerdown", closeAppearancePicker, true);
    return () => document.removeEventListener("pointerdown", closeAppearancePicker, true);
  }, []);
  useEffect(() => () => {
    if (touchSelection.current) window.clearTimeout(touchSelection.current.timer);
    touchSelection.current = null;
  }, []);
  // Geometry captured at drag start, so undo has somewhere to go back to.
  const dragOrigin = useRef<Map<string, { x: number; y: number; w: number; h: number }>>(
    new Map()
  );
  // xyflow can emit several pointer events between paints. Targeting once per
  // animation frame keeps dense canvases from doing redundant full scans.
  const hitTestFrame = useRef<number | null>(null);
  const alignmentGuideLock = useRef<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  });

  useEffect(() => {
    loadCanvas(canvasId);
    loadInbox();
    loadCapabilities();
    loadProductivity();
  }, [canvasId, loadCanvas, loadInbox, loadCapabilities, loadProductivity]);

  // Finite boards are really auto-growing workspaces. Approaching either far
  // edge adds one modest strip; leaving ample breathing room stops growth.
  useEffect(() => {
    if (canvasInfinite) return;
    let right = 0;
    let bottom = 0;
    for (const node of nodes) {
      if (node.data.parentId) continue;
      right = Math.max(right, node.position.x + node.data.w);
      bottom = Math.max(bottom, node.position.y + node.data.h);
    }
    for (const zone of zones) {
      right = Math.max(right, zone.x + zone.w);
      bottom = Math.max(bottom, zone.y + zone.h);
    }
    growCanvasForContent(right, bottom);
  }, [canvasInfinite, nodes, zones, growCanvasForContent]);

  // Boards this one sits inside. A canvas can be placed on more than one, so
  // this is a set of ways in rather than a single path.
  const [parents, setParents] = useState<CanvasSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .get<CanvasSummary[]>(`/api/canvases/${canvasId}/parents`)
      .then((rows) => {
        if (!cancelled) setParents(rows);
      })
      .catch(() => setParents([]));
    return () => {
      cancelled = true;
    };
  }, [canvasId]);

  // Arriving from a reference on another canvas: centre on the card that was
  // being followed and select it, so the trail does not go cold on landing.
  const followCardId = searchParams.get("card");
  const followed = useRef<string | null>(null);
  useEffect(() => {
    // Clearing the query parameter completes one trip. Reset the latch so the
    // same reference can be followed again later from another card.
    if (!followCardId) {
      followed.current = null;
      return;
    }
    if (nodes.length === 0) return;
    if (followed.current === followCardId) return;
    const node = nodes.find((n) => n.data.card.id === followCardId);
    if (!node) return;
    // Latch before touching state: this effect watches `nodes`, and it edits
    // them, so without the guard it re-enters itself.
    followed.current = followCardId;
    setSelection([node.id]);
    setNodes((current) =>
      current.map((n) => (n.selected === (n.id === node.id) ? n : { ...n, selected: n.id === node.id }))
    );
    fitView({ nodes: [{ id: node.id }], padding: 0.45, duration: 400, maxZoom: 1.2 });
    setSearchParams({}, { replace: true });
  }, [followCardId, nodes, fitView, setSelection, setNodes, setSearchParams]);

  // A source chip in a living document closes the editor, then leaves this
  // request behind. Resolve card identity to the placements on this canvas,
  // select them, and frame them as one group.
  useEffect(() => {
    if (!pendingFocusCardIds) return;
    const wanted = new Set(pendingFocusCardIds);
    const targets = nodes.filter((node) => wanted.has(node.data.card.id));
    clearPendingFocus();
    if (targets.length === 0) {
      showToast("That source card is no longer on this canvas.");
      return;
    }
    const placementIds = targets.map((node) => node.id);
    setSelection(placementIds);
    setNodes((current) =>
      current.map((node) => ({ ...node, selected: placementIds.includes(node.id) }))
    );
    fitView({
      nodes: targets.map((node) => ({ id: node.id })),
      padding: 0.35,
      duration: 400,
      maxZoom: 1.15,
    });
  }, [
    pendingFocusCardIds,
    nodes,
    clearPendingFocus,
    showToast,
    setSelection,
    setNodes,
    fitView,
  ]);

  // Selecting exactly one card roots the reveal there. Deselection clears it,
  // except when the deselection came from clicking an edge: the link panel
  // needs the reveal (and the edge) to stay alive.
  useEffect(() => {
    if (selection.length === 1) {
      const node = nodes.find((n) => n.id === selection[0]);
      if (node) {
        loadReveal(node.data.card.id, node.position);
        return;
      }
    }
    if (!useCanvasStore.getState().selectedLinkId) {
      clearReveal();
    }
    // Positions change on drag; only re-root when the selection itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, loadReveal, clearReveal]);

  // While any card is waiting on a job (unfurl, transcript), refresh quietly.
  useEffect(() => {
    const waiting = nodes.some(
      (n) =>
        n.data.card.payload.unfurl_status === "queued" ||
        n.data.card.payload.spotify_status === "queued" ||
        n.data.card.payload.youtube_status === "queued" ||
        n.data.card.payload.transcript_status === "queued"
    );
    if (!waiting) return;
    const timer = window.setTimeout(() => loadCanvas(canvasId), 3000);
    return () => window.clearTimeout(timer);
  }, [nodes, canvasId, loadCanvas]);

  const graph = useMemo(
    () =>
      reveal && revealAnchor ? buildRevealGraph(reveal, revealAnchor, nodes) : null,
    [reveal, revealAnchor, nodes]
  );

  /** Hub cards fold their children down to titles until the hub is selected.
   * Children are the targets of the hub's outgoing links on this canvas —
   * the same parent/child direction the reveal uses. */
  const { collapsedCardIds, childCountByCard } = useMemo(() => {
    const childrenOf = new Map<string, string[]>();
    for (const link of canvasLinks) {
      if (!link.source_card_id || !link.target_card_id) continue;
      const list = childrenOf.get(link.source_card_id) ?? [];
      list.push(link.target_card_id);
      childrenOf.set(link.source_card_id, list);
    }

    const hubCardIds = new Set(
      nodes.filter((n) => n.data.isHub).map((n) => n.data.card.id)
    );
    const selectedCardIds = new Set(
      nodes.filter((n) => selection.includes(n.id)).map((n) => n.data.card.id)
    );
    const collapsed = new Set<string>();
    for (const hubId of hubCardIds) {
      // Selecting the hub opens it, which is the whole gesture.
      if (selectedCardIds.has(hubId)) continue;
      for (const childId of childrenOf.get(hubId) ?? []) {
        if (!hubCardIds.has(childId)) collapsed.add(childId);
      }
    }
    const counts = new Map<string, number>();
    for (const [parent, kids] of childrenOf) counts.set(parent, kids.length);
    return { collapsedCardIds: collapsed, childCountByCard: counts };
  }, [canvasLinks, nodes, selection]);

  /** Who each card on this canvas is already linked to, by card id.
   *
   * Keyed by card rather than by placement deliberately: `nodes` is rebuilt
   * on every frame of a drag and this is not, so the adjacency is resolved to
   * node ids only at the moment something needs lighting up. Direction does
   * not matter here — a neighbour is a neighbour whichever way the arrow
   * points. */
  const neighbourCardIds = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const join = (a: string, b: string) => {
      const set = map.get(a) ?? new Set<string>();
      set.add(b);
      map.set(a, set);
    };
    for (const link of canvasLinks) {
      if (!link.source_card_id || !link.target_card_id) continue;
      join(link.source_card_id, link.target_card_id);
      join(link.target_card_id, link.source_card_id);
    }
    return map;
  }, [canvasLinks]);

  const memberHeights = useCanvasStore((s) => s.memberHeights);
  const columnLayoutCache = useRef<{
    nodes: CardNodeType[];
    heights: Record<string, number>;
    layout: ReturnType<typeof layoutColumns>;
  } | null>(null);
  const columns = useMemo(() => {
    const cached = columnLayoutCache.current;
    if (
      cached &&
      cached.heights === memberHeights &&
      sameColumnInputs(cached.nodes, nodes)
    ) {
      return cached.layout;
    }
    const layout = layoutColumns(nodes, memberHeights);
    columnLayoutCache.current = { nodes, heights: memberHeights, layout };
    return layout;
  }, [nodes, memberHeights]);
  const positionedNodeCache = useRef(
    new Map<string, { input: Node; signature: string; output: Node }>()
  );
  const decoratedNodeCache = useRef(
    new Map<string, { input: Node; signature: string; output: Node }>()
  );

  /** The rectangle a card actually occupies on screen right now.
   *
   * Not `data.w/h`, which is only the size stored on the placement. A folded
   * card is a title bar. A card in a column is drawn at whatever its content
   * needs, and narrower still while it is showing a one-line preview — none
   * of which is written back to the placement, because leaving a column has
   * to restore the size the card had before it joined.
   *
   * Using the stored size here gave a previewed card a hit box three times
   * its drawn height, so dragging past the empty space underneath it fired
   * the link gesture against a card that was nowhere near the cursor. The
   * column layout already computes what everything is really drawn at. */
  /** Where a card actually sits on the board, in world coordinates.
   *
   * A card in a column is *drawn* at its column's position plus its slot
   * offset, but the position stored on its placement is wherever it sat
   * before it joined — untouched, so that leaving the column restores it.
   * Reading that stored position back as though it were the live one put a
   * card's hit box somewhere it had not been for some time, which is how a
   * drag at the bottom of the canvas could link to a card in a column at the
   * top. The drag code already resolved this for the card being dragged; it
   * never did for the cards being dragged *at*. */
  const worldPosition = useCallback(
    (node: CardNodeType, byId: Map<string, CardNodeType>) => {
      const parentId = node.data.parentId;
      const kids = parentId ? columns.members.get(parentId) : null;
      if (!parentId || !kids) return node.position;
      const parent = byId.get(parentId);
      if (!parent) return node.position;
      const index = Math.max(
        kids.findIndex((k) => k.id === node.id),
        0
      );
      const offset = memberOffset(
        kids.map((k) => columns.geometry.get(k.id)?.height ?? k.data.h),
        index
      );
      return {
        x: parent.position.x + offset.x,
        y: parent.position.y + offset.y,
      };
    },
    [columns]
  );

  const effectiveSize = useCallback(
    (node: CardNodeType) => {
      if (collapsedCardIds.has(node.data.card.id)) {
        return { w: node.data.w, h: COLLAPSED_HEIGHT };
      }
      const drawn = columns.geometry.get(node.id);
      return { w: drawn?.width ?? node.data.w, h: drawn?.height ?? node.data.h };
    },
    [collapsedCardIds, columns]
  );

  /** Apply column membership: a column becomes a parent node sized to its
   * contents, and its members become children positioned relative to it.
   * xyflow needs parents to come first in the array. */
  const applyColumns = useCallback(
    (list: Node[]): Node[] => {
      const out: Node[] = [];
      const memberNodes: Node[] = [];
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const nextCache = new Map<
        string,
        { input: Node; signature: string; output: Node }
      >();

      const reuse = (input: Node, signature: string, output: () => Node): Node => {
        const cached = positionedNodeCache.current.get(input.id);
        if (cached?.input === input && cached.signature === signature) {
          nextCache.set(input.id, cached);
          return cached.output;
        }
        const entry = { input, signature, output: output() };
        nextCache.set(input.id, entry);
        return entry.output;
      };

      for (const node of list) {
        const source = byId.get(node.id);
        if (!source) {
          out.push(node);
          continue;
        }
        const size = columns.geometry.get(node.id);
        const isCol = source.data.card.type === "column";

        if (isCol) {
          const kids = columns.members.get(node.id) ?? [];
          const stationaryKids =
            columnTarget?.id === node.id
              ? kids.filter((kid) => !columnTarget.movingIds.includes(kid.id))
              : kids;
          const zIndex = node.id === menuOpenFor ? MENU_LAYER : -1;
          const dropY =
            columnTarget?.id === node.id
              ? memberOffset(
                  stationaryKids.map(
                    (kid) => columns.geometry.get(kid.id)?.height ?? kid.data.h
                  ),
                  columnTarget.slot
                ).y
              : null;
          const signature = `column:${size?.width}:${size?.height}:${zIndex}:${kids.length}:${dropY}`;
          out.push(
            reuse(node, signature, () => ({
              ...node,
              type: "column",
              width: size?.width,
              height: size?.height,
              // Normally behind its members, so the stack reads as contents;
              // lifted right up while its own menu is open, or the cards inside
              // it cover the dropdown.
              zIndex,
              data: {
                ...node.data,
                memberCount: kids.length,
                // Only present while a card is hovering over this column.
                dropY,
              },
            }))
          );
          continue;
        }

        const parentId = source.data.parentId;
        if (parentId && columns.members.has(parentId)) {
          const kids = columns.members.get(parentId)!;
          const index = kids.findIndex((k) => k.id === node.id);
          const offset = memberOffset(
            kids.map((k) => columns.geometry.get(k.id)?.height ?? k.data.h),
            Math.max(index, 0)
          );
          const className = [node.className, "is-column-member"]
            .filter(Boolean)
            .join(" ");
          const signature = `member:${parentId}:${offset.x}:${offset.y}:${size?.height}:${className}`;
          memberNodes.push(
            reuse(node, signature, () => ({
              ...node,
              parentId,
              // No `extent: "parent"`. The column decides where a card lands
              // on drop, so the drag itself is left free.
              position: offset,
              width: MEMBER_WIDTH,
              height: size?.height,
              className,
            }))
          );
          continue;
        }
        out.push(node);
      }
      positionedNodeCache.current = nextCache;
      return [...out, ...memberNodes];
    },
    [nodes, columns, menuOpenFor, columnTarget]
  );

  const renderNodes: Node[] = useMemo(() => {
    const nextDecorated = new Map<
      string,
      { input: Node; signature: string; output: Node }
    >();
    // Return the identical object when nothing changed: handing xyflow a new
    // node object makes it reset that node's measured internals.
    const decorate = (node: Node, className?: string): Node => {
      const next =
        [
          className,
          node.id === linkTarget ? "is-link-target" : null,
          node.id === columnTarget?.id ? "is-column-target" : null,
        ]
          .filter(Boolean)
          .join(" ") || undefined;

      const data = node.data as CardNodeType["data"];
      const collapsed = collapsedCardIds.has(data.card.id);
      const kids = childCountByCard.get(data.card.id) ?? 0;
      const lifted = node.id === menuOpenFor;
      const signature = `${next ?? ""}:${collapsed ? 1 : 0}:${kids}:${lifted ? 1 : 0}`;
      const cached = decoratedNodeCache.current.get(node.id);
      if (cached?.input === node && cached.signature === signature) {
        nextDecorated.set(node.id, cached);
        return cached.output;
      }

      const output =
        node.className === next &&
        data.collapsed === collapsed &&
        data.childCount === kids &&
        !lifted
          ? node
          : {
              ...node,
              className: next,
              // Render-only height: the placement keeps its real size, so
              // expanding restores it and nothing is persisted.
              height: collapsed ? COLLAPSED_HEIGHT : data.h,
              ...(lifted ? { zIndex: MENU_LAYER } : {}),
              data: { ...data, collapsed, childCount: kids },
            };
      const entry = { input: node, signature, output };
      nextDecorated.set(node.id, entry);
      return output;
    };

    const finish = (list: Node[]): Node[] => {
      decoratedNodeCache.current = nextDecorated;
      return applyColumns(list);
    };

    // Search takes precedence over the reveal: both dim, and running one
    // while the other is showing would be unreadable.
    if (searchMatches !== null) {
      const matches = new Set(searchMatches);
      return finish(
        nodes.map((n) =>
          decorate(n, matches.has(n.id) ? "search-match" : "search-dimmed")
        )
      );
    }
    if (!graph) return finish(nodes.map((n) => decorate(n)));


    const lit = new Set(graph.revealedNodeIds);

    /* What a drop would do, rather than what it is passing. Proximity used to
     * un-dim anything within 420px, which meant dragging across a busy board
     * lit most of it and said nothing about the outcome; the light now means
     * "this is what the drop acts on".
     *
     * The target's own neighbours come up with it, because joining a card
     * means joining what it is already part of, and seeing that
     * neighbourhood is the point of the reveal being on in the first place.
     * One hop only — the same link would otherwise walk the whole component
     * and un-dim the board. */
    if (linkTarget) {
      lit.add(linkTarget);
      const targetCardId = nodes.find((n) => n.id === linkTarget)?.data.card.id;
      const neighbours = targetCardId
        ? neighbourCardIds.get(targetCardId)
        : undefined;
      if (neighbours) {
        for (const n of nodes) {
          if (neighbours.has(n.data.card.id)) lit.add(n.id);
        }
      }
    }
    // A column being dropped into is the same kind of statement about the
    // drop, so it lights the same way. Its members follow through the
    // containment pass below.
    if (columnTarget) lit.add(columnTarget.id);

    // A column and the cards stacked in it are one object on screen, so
    // anything lighting either lights both. Otherwise linking to a column
    // dims its own contents, and revealing a card inside one leaves it
    // glowing in a greyed-out frame.
    const seeded = new Set(lit);
    for (const node of nodes) {
      const parent = node.data.parentId;
      if (!parent) continue;
      if (seeded.has(parent)) lit.add(node.id);
      if (seeded.has(node.id)) lit.add(parent);
    }

    const dimmed = nodes.map((n) =>
      lit.has(n.id) ? decorate(n) : decorate(n, "reveal-dimmed")
    );
    return [...finish(dimmed), ...graph.ghosts, ...graph.tombstones];
  }, [
    nodes,
    graph,
    searchMatches,
    neighbourCardIds,
    linkTarget,
    collapsedCardIds,
    childCountByCard,
    applyColumns,
    columnTarget,
    menuOpenFor,
  ]);

  const edges: Edge[] = graph?.edges ?? [];

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Only position and selection are written back.
      //
      // Dimension changes must NOT be: xyflow measures a node, we store the
      // result, that makes a new node object, xyflow measures again — an
      // infinite loop that ends in "Maximum update depth exceeded" and a
      // blank page. Card size belongs to the placement, and collapsing a hub
      // changes a node's rendered height deliberately, so measurements are
      // never something to persist.
      const relevant = changes.filter(
        (c) => c.type === "position" || c.type === "select"
      );
      if (relevant.length === 0) return;

      // Ghost and tombstone nodes are ephemeral render artifacts; only
      // changes to real placements reach the store.
      setNodes((current) => {
        const known = new Set(current.map((n) => n.id));
        const mine = relevant.filter(
          (c) => !("id" in c) || known.has((c as { id: string }).id)
        );
        if (mine.length === 0) return current;
        return applyNodeChanges(mine, current) as CardNodeType[];
      });
    },
    [setNodes]
  );

  const onSelectionChange = useCallback(
    ({ nodes: selected }: OnSelectionChangeParams) => {
      // Anything backed by a placement counts, which is the test — not the
      // node type. Filtering on `type === "card"` silently dropped columns:
      // selecting one never reached the store, so no reveal was ever rooted
      // there and a link to a column was created and then never drawn. What
      // has to stay out is the scenery — portals and tombstones — which have
      // no placement behind them.
      const placements = new Set(useCanvasStore.getState().nodes.map((n) => n.id));
      setSelection(selected.filter((n) => placements.has(n.id)).map((n) => n.id));
    },
    [setSelection]
  );

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      // Clicking any card during a search leaves search behind and resumes
      // normal operation, rather than stranding you on a dimmed card.
      if (useCanvasStore.getState().searchMatches !== null) {
        setSearchOpen(false);
      }
      // Clicking a revealed ghost re-roots the reveal there: walking the
      // graph one step at a time is the breadcrumb.
      if (node.type === "ghost") {
        loadReveal((node.data as { cardId: string }).cardId, node.position);
      }
    },
    [loadReveal, setSearchOpen]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const cardIdOf = (nodeId: string): string | null => {
        if (nodeId.startsWith("ghost-")) return nodeId.slice("ghost-".length);
        const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
        return node ? node.data.card.id : null;
      };
      const source = connection.source && cardIdOf(connection.source);
      const target = connection.target && cardIdOf(connection.target);
      if (source && target && source !== target) {
        createLink(source, target);
      }
    },
    [createLink]
  );

  const onNodeDragStart = useCallback(
    (_event: MouseEvent | TouchEvent, __: Node, dragged: Node[]) => {
      setDragging(true);
      setAlignmentGuides(null);
      alignmentGuideLock.current = { x: null, y: null };

      dragOrigin.current.clear();
      for (const node of dragged) {
        const existing = useCanvasStore
          .getState()
          .nodes.find((n) => n.id === node.id);
        if (existing) {
          dragOrigin.current.set(node.id, {
            x: existing.position.x,
            y: existing.position.y,
            w: existing.data.w,
            h: existing.data.h,
          });
        }
      }
    },
    []
  );

  const onNodeDrag = useCallback(
    (event: MouseEvent | TouchEvent, node: Node, dragged: Node[]) => {
      const all = useCanvasStore.getState().nodes;
      // Targeting follows the cursor, not the card's centre. A tall card over
      // a short column has its centre below the column entirely, so centre
      // hit-testing made empty columns nearly impossible to drop into.
      const point =
        "touches" in event ? event.touches[0] : (event as MouseEvent);
      const pointer = screenToFlowPosition({
        x: point?.clientX ?? 0,
        y: point?.clientY ?? 0,
      });
      if (hitTestFrame.current !== null) return;
      hitTestFrame.current = window.requestAnimationFrame(() => {
        hitTestFrame.current = null;
      });

      const moving = new Set(dragged.map((n) => n.id));
      const byId = new Map(all.map((candidate) => [candidate.id, candidate]));
      const self = byId.get(node.id);
      if (!self) return;

      // A card inside a column reports its position relative to that column,
      // so it has to be put back into world space before it can be compared
      // with anything else.
      const parent = self.data.parentId
        ? byId.get(self.data.parentId)
        : null;
      const origin = parent
        ? {
            x: parent.position.x + node.position.x,
            y: parent.position.y + node.position.y,
          }
        : node.position;

      // The live drag position, not the stored one, and the height the card
      // is actually drawn at.
      const mySize = effectiveSize(self);
      const me: Rect = {
        x: origin.x,
        y: origin.y,
        w: mySize.w,
        h: mySize.h,
      };

      let over: string | null = null;
      let bestOverlap = 0;
      const zoom = getZoom();
      const enterTolerance = ALIGN_GUIDE_ENTER_PX / zoom;
      const releaseTolerance = ALIGN_GUIDE_RELEASE_PX / zoom;
      const reach = ALIGN_GUIDE_REACH_PX / zoom;
      const viewport = getViewport();
      const wrapper = wrapperRef.current?.getBoundingClientRect();
      const visible = wrapper
        ? {
            left: -viewport.x / zoom,
            top: -viewport.y / zoom,
            right: (wrapper.width - viewport.x) / zoom,
            bottom: (wrapper.height - viewport.y) / zoom,
          }
        : null;
      const xCandidates: AlignmentCandidate[] = [];
      const yCandidates: AlignmentCandidate[] = [];
      const myX = [me.x, me.x + me.w / 2, me.x + me.w];
      const myY = [me.y, me.y + me.h / 2, me.y + me.h];
      for (const other of all) {
        if (moving.has(other.id)) continue;
        const theirSize = effectiveSize(other);
        const theirAt = worldPosition(other, byId);
        const theirs: Rect = {
          x: theirAt.x,
          y: theirAt.y,
          w: theirSize.w,
          h: theirSize.h,
        };
        // Guides belong to top-level objects. Including every member of a
        // column produced a comb of near-identical lines around the stack.
        const isVisible =
          !visible ||
          (theirs.x < visible.right &&
            theirs.x + theirs.w > visible.left &&
            theirs.y < visible.bottom &&
            theirs.y + theirs.h > visible.top);
        if (!other.data.parentId && isVisible) {
          const theirX = [theirs.x, theirs.x + theirs.w / 2, theirs.x + theirs.w];
          const theirY = [theirs.y, theirs.y + theirs.h / 2, theirs.y + theirs.h];
          const verticalGap = Math.max(
            0,
            Math.max(me.y, theirs.y) - Math.min(me.y + me.h, theirs.y + theirs.h)
          );
          const horizontalGap = Math.max(
            0,
            Math.max(me.x, theirs.x) - Math.min(me.x + me.w, theirs.x + theirs.w)
          );
          if (verticalGap <= reach) {
            // Left aligns with left, centre with centre, and right with right.
            // Comparing every anchor with every other anchor made almost any
            // nearby placement qualify for something and caused rapid guide
            // switching while moving through a cluster.
            for (let index = 0; index < myX.length; index++) {
              xCandidates.push({
                coordinate: theirX[index],
                distance: Math.abs(myX[index] - theirX[index]),
                targetId: other.id,
              });
            }
          }
          if (horizontalGap <= reach) {
            for (let index = 0; index < myY.length; index++) {
              yCandidates.push({
                coordinate: theirY[index],
                distance: Math.abs(myY[index] - theirY[index]),
                targetId: other.id,
              });
            }
          }
        }
        /* A container and its contents are one object as far as this
         * gesture goes. A column always covers every card inside it, and a
         * card in a column is always covered by it, so without this the
         * overlap test fires constantly for a pair that is already related
         * by containment. */
        const related =
          other.data.parentId === self.id || self.data.parentId === other.id;

        // Linking needs the cards themselves to overlap, not just the cursor
        // to be inside the other one. Pointer containment fires while the two
        // are still visibly apart — you grab a card by its edge and the
        // cursor arrives long before the card does — and that only gets worse
        // once cards are being placed close together on purpose. When several
        // overlap, the one covered most wins.
        const overlapX =
          Math.min(me.x + me.w, theirs.x + theirs.w) - Math.max(me.x, theirs.x);
        const overlapY =
          Math.min(me.y + me.h, theirs.y + theirs.h) - Math.max(me.y, theirs.y);
        if (
          !related &&
          other.data.card.type !== "column" &&
          !(
            other.data.card.type === "portal" &&
            other.data.card.payload.scope !== "canvas"
          ) &&
          overlapX >= MIN_OVERLAP &&
          overlapY >= MIN_OVERLAP &&
          overlapX * overlapY > bestOverlap
        ) {
          bestOverlap = overlapX * overlapY;
          over = other.id;
        }
      }
      // A column under the pointer takes precedence over linking: dropping
      // into a stack is the more likely intent when one is there.
      let column: { id: string; slot: number; movingIds: string[] } | null = null;
      const movableIntoColumn = new Set(
        dragged
          .map((candidate) => byId.get(candidate.id))
          .filter(
            (candidate): candidate is CardNodeType =>
              candidate !== undefined &&
              candidate.data.card.type !== "column" &&
              !(
                candidate.data.parentId && moving.has(candidate.data.parentId)
              )
          )
          .map((candidate) => candidate.id)
      );
      // Keep mixed selections atomic. A group of cards may enter a column;
      // a selection containing a column remains a free-moving canvas group
      // instead of partially moving some objects and nesting others.
      if (movableIntoColumn.size === dragged.length) {
        for (const other of all) {
          if (other.data.card.type !== "column" || moving.has(other.id)) continue;
          const size = columns.geometry.get(other.id);
          if (!size) continue;
          const box: Rect = {
            x: other.position.x,
            y: other.position.y,
            w: size.width,
            h: size.height,
          };
          if (
            pointer.x >= box.x &&
            pointer.x <= box.x + box.w &&
            pointer.y >= box.y &&
            pointer.y <= box.y + box.h
          ) {
            const kids = (columns.members.get(other.id) ?? []).filter(
              (kid) => !movableIntoColumn.has(kid.id)
            );
            column = {
              id: other.id,
              slot: slotForOffset(
                kids.map((k) => columns.geometry.get(k.id)?.height ?? k.data.h),
                pointer.y - box.y
              ),
              movingIds: [...movableIntoColumn],
            };
            break;
          }
        }
      }

      setColumnTarget((current) => {
        if (!current || !column) return current === column ? current : column;
        return current.id === column.id &&
          current.slot === column.slot &&
          current.movingIds.length === column.movingIds.length &&
          current.movingIds.every((id, index) => id === column.movingIds[index])
          ? current
          : column;
      });
      setLinkTarget(dragged.length === 1 && !column ? over : null);
      const pickGuide = (
        candidates: AlignmentCandidate[],
        locked: number | null
      ): AlignmentCandidate | null => {
        if (locked !== null) {
          const same = candidates
            .filter((candidate) => Math.abs(candidate.coordinate - locked) < 0.5)
            .sort((a, b) => a.distance - b.distance)[0];
          if (same && same.distance <= releaseTolerance) return same;
        }
        const closest = candidates.sort((a, b) => a.distance - b.distance)[0];
        return closest && closest.distance <= enterTolerance ? closest : null;
      };
      let pickedX = pickGuide(xCandidates, alignmentGuideLock.current.x);
      let pickedY = pickGuide(yCandidates, alignmentGuideLock.current.y);

      // Two axes are useful only for a deliberate near-perfect alignment to
      // the same object. Otherwise show the stronger relationship rather than
      // flashing an X guide for one card and a Y guide for another.
      const dualAxisTolerance = ALIGN_GUIDE_DUAL_AXIS_PX / zoom;
      if (
        pickedX &&
        pickedY &&
        (pickedX.targetId !== pickedY.targetId ||
          pickedX.distance > dualAxisTolerance ||
          pickedY.distance > dualAxisTolerance)
      ) {
        // Once an axis is showing, keep it until its wider release threshold
        // is crossed. Without this, sub-pixel distance changes can make two
        // equally close axes trade places every frame.
        if (
          alignmentGuideLock.current.x !== null &&
          alignmentGuideLock.current.y === null
        ) {
          pickedY = null;
        } else if (
          alignmentGuideLock.current.y !== null &&
          alignmentGuideLock.current.x === null
        ) {
          pickedX = null;
        } else if (pickedX.distance <= pickedY.distance) pickedY = null;
        else pickedX = null;
      }
      const guideX = pickedX?.coordinate ?? null;
      const guideY = pickedY?.coordinate ?? null;
      alignmentGuideLock.current = { x: guideX, y: guideY };
      const nextGuides =
        guideX === null && guideY === null
          ? null
          : { x: guideX, y: guideY, stroke: 1.5 / zoom };
      setAlignmentGuides((current) =>
        current?.x === nextGuides?.x &&
        current?.y === nextGuides?.y &&
        current?.stroke === nextGuides?.stroke
          ? current
          : nextGuides
      );
    },
    [
      effectiveSize,
      worldPosition,
      columns,
      screenToFlowPosition,
      getZoom,
      getViewport,
    ]
  );

  // One PATCH per moved card, on drop. Multi-drag produces one call per card.
  const onNodeDragStop = useCallback(
    (_: unknown, __: Node, dragged: Node[]) => {
      if (hitTestFrame.current !== null) {
        window.cancelAnimationFrame(hitTestFrame.current);
        hitTestFrame.current = null;
      }

      const droppedOn = linkTarget;
      const intoColumn = columnTarget;
      setLinkTarget(null);
      setColumnTarget(null);
      setAlignmentGuides(null);
      alignmentGuideLock.current = { x: null, y: null };
      setDragging(false);

      // Dropped into a stack. Selected cards enter as one ordered block;
      // columns, and members carried by a selected column, remain intact.
      if (intoColumn) {
        const live = useCanvasStore.getState().nodes;
        const byId = new Map(live.map((candidate) => [candidate.id, candidate]));
        const moving = new Set(dragged.map((candidate) => candidate.id));
        const eligible = dragged
          .map((candidate) => byId.get(candidate.id))
          .filter(
            (candidate): candidate is CardNodeType =>
              candidate !== undefined &&
              candidate.data.card.type !== "column" &&
              !(
                candidate.data.parentId && moving.has(candidate.data.parentId)
              )
          )
          .sort((a, b) => {
            const aAt = worldPosition(a, byId);
            const bAt = worldPosition(b, byId);
            return aAt.y - bAt.y || aAt.x - bAt.x;
          });
        if (eligible.length > 0) {
          dragOrigin.current.clear();
          void moveManyIntoColumn(
            eligible.map((candidate) => candidate.id),
            intoColumn.id,
            intoColumn.slot
          );
          return;
        }
      }

      // A single member dropped outside its stack leaves it.
      if (dragged.length === 1 && dragged[0].type !== "column") {
        const node = dragged[0];
        const source = useCanvasStore.getState().nodes.find((n) => n.id === node.id);
        if (source) {
          if (source.data.parentId) {
            // Left the column: keep it where it was let go, in world space.
            const parent = useCanvasStore
              .getState()
              .nodes.find((n) => n.id === source.data.parentId);
            const world = parent
              ? {
                  x: parent.position.x + node.position.x,
                  y: parent.position.y + node.position.y,
                }
              : node.position;
            dragOrigin.current.clear();
            moveIntoColumn(node.id, null, 0, world);
            return;
          }
        }
      }

      /* A card dropped onto another card is a link gesture, not a move: make
       * the link and put the card back where it came from.
       *
       * Cards only. A column is a container, and moving one necessarily lays
       * it over its own members — treating that as a drop-on-target linked
       * the column to whatever it was holding and then sprang it back to
       * where it started, so a column could not be moved at all. Dragging a
       * column somewhere is a move, always; to link one, use its anchors. */
      const draggedCard =
        dragged.length === 1 &&
        useCanvasStore.getState().nodes.find((n) => n.id === dragged[0].id);
      const portalTarget = droppedOn
        ? useCanvasStore.getState().nodes.find((n) => n.id === droppedOn)
        : null;
      if (
        droppedOn &&
        draggedCard &&
        portalTarget?.data.card.type === "portal" &&
        draggedCard.data.card.type !== "column"
      ) {
        const before = dragOrigin.current.get(dragged[0].id);
        dragOrigin.current.clear();
        if (before) {
          setNodes((current) =>
            current.map((node) =>
              node.id === draggedCard.id
                ? { ...node, position: { x: before.x, y: before.y } }
                : node
            )
          );
        }
        void api
          .post(
            `/api/cards/${portalTarget.data.card.id}/portal/items/${draggedCard.data.card.id}`,
            {}
          )
          .then(() => {
            showToast(`Added to “${portalTarget.data.card.title ?? "portal"}”`);
            window.dispatchEvent(
              new CustomEvent(PORTAL_REFRESH_EVENT, {
                detail: { portalId: portalTarget.data.card.id },
              })
            );
          })
          .catch((error) =>
            showToast(error instanceof Error ? error.message : "Could not add that card")
          );
        return;
      }
      if (droppedOn && draggedCard && draggedCard.data.card.type !== "column") {
        const source = useCanvasStore
          .getState()
          .nodes.find((n) => n.id === dragged[0].id);
        const target = useCanvasStore.getState().nodes.find((n) => n.id === droppedOn);
        const before = dragOrigin.current.get(dragged[0].id);
        dragOrigin.current.clear();
        if (source && target && before) {
          setNodes((current) =>
            current.map((n) =>
              n.id === source.id ? { ...n, position: { x: before.x, y: before.y } } : n
            )
          );
          createLink(source.data.card.id, target.data.card.id);
          showToast(`Linked to “${target.data.card.title ?? "that card"}”`);
          return;
        }
      }

      const live = useCanvasStore.getState().nodes;
      const undoItems: Array<{
        kind: "geometry";
        placementId: string;
        x: number;
        y: number;
        w: number;
        h: number;
      }> = [];
      for (const node of dragged) {
        // Anything backed by a real placement gets saved — cards and columns
        // alike. Checking the node type instead silently dropped every column
        // move, since a column renders as its own node type.
        const source = live.find((n) => n.id === node.id);
        if (!source) continue; // portals and echoes have nothing to save
        // A card inside a column is positioned by the column, and its stored
        // x/y are deliberately left alone so leaving restores them.
        if (source.data.parentId) continue;

        const before = dragOrigin.current.get(node.id);
        if (before && (before.x !== node.position.x || before.y !== node.position.y)) {
          undoItems.push({ kind: "geometry", placementId: node.id, ...before });
        }
        savePlacement(node.id);
      }
      if (undoItems.length === 1) pushUndo(undoItems[0]);
      else if (undoItems.length > 1) {
        pushUndo({ kind: "geometry-group", items: undoItems });
      }
      dragOrigin.current.clear();
    },
    [
      savePlacement,
      pushUndo,
      linkTarget,
      // Without these the handler closes over a stale target and every drop
      // looks like "not over a column", which ejected members instead of
      // reordering them and never let a card join one.
      columnTarget,
      moveIntoColumn,
      moveManyIntoColumn,
      worldPosition,
      createLink,
      setNodes,
      showToast,
    ]
  );

  const onMoveEnd = useCallback(
    (_: unknown, viewport: Viewport) => {
      localStorage.setItem(viewportKey(canvasId), JSON.stringify(viewport));
    },
    [canvasId]
  );

  const fitToRevealed = useCallback(() => {
    if (!graph) return;
    fitView({
      nodes: [...graph.revealedNodeIds].map((id) => ({ id })),
      padding: 0.2,
      duration: 300,
    });
  }, [graph, fitView]);

  const removeSelected = useCallback(async () => {
    if (selection.length === 0) return;
    if (selection.length === 1) {
      const node = nodes.find((n) => n.id === selection[0]);
      if (!node) return;
      const placements = await api.get<CardPlacementInfo[]>(
        `/api/cards/${node.data.card.id}/placements`
      );
      if (placements.length <= 1) {
        const ok = await confirmDialog({
          title: "Remove from this canvas?",
          body: "This card lives nowhere else, so it will move back to your inbox. Its content is kept.",
          confirmLabel: "Remove",
        });
        if (!ok) return;
      }
    } else {
      const ok = await confirmDialog({
        title: `Remove ${selection.length} cards from this canvas?`,
        body: "Any that live nowhere else move back to your inbox. Nothing is deleted.",
        confirmLabel: "Remove",
      });
      if (!ok) return;
    }
    await removePlacements(selection);
  }, [selection, nodes, removePlacements]);

  // Delete removes from canvas. Deleting the card itself is menu-only:
  // the destructive action should not sit under the obvious key.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = target.closest("input, textarea, [contenteditable]");

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (typing) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (!readOnly) undo();
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setCheatOpen((v) => !v);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (!readOnly) removeSelected();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [removeSelected, undo, setSearchOpen, readOnly]);

  // Paste onto the canvas: a URL becomes a link (or YouTube) card, anything
  // else becomes a text card at the cursor.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable]")) return;
      if (useCanvasStore.getState().role === "viewer") return;
      const at = lastPointer.current;
      const pos = at
        ? screenToFlowPosition(at)
        : screenToFlowPosition(centerOfWrapper());

      // An image on the clipboard becomes an image card.
      const imageItem = Array.from(e.clipboardData?.items ?? []).find((item) =>
        item.type.startsWith("image/")
      );
      if (imageItem) {
        const file = imageItem.getAsFile();
        if (file) {
          e.preventDefault();
          createImageCard(pos.x, pos.y, file);
          return;
        }
      }

      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (!text) return;
      if (URL_PATTERN.test(text)) {
        const type: CardType = YOUTUBE_PATTERN.test(text) ? "youtube" : "link";
        createCardAt(pos.x, pos.y, "", false, type, { url: text });
      } else {
        createCardAt(pos.x, pos.y, text, false);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [screenToFlowPosition, createCardAt, createImageCard]);

  function centerOfWrapper() {
    const rect = wrapperRef.current?.getBoundingClientRect();
    return rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  function applyTouchSelection(ids: string[]) {
    const wanted = new Set(ids);
    setSelection(ids);
    setNodes((current) => current.map((node) => ({
      ...node,
      selected: wanted.has(node.id),
    })));
  }

  function beginTouchSelection(event: React.PointerEvent) {
    if (readOnly || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("button, a, input, textarea, [contenteditable], .nodrag")) return;
    const nodeElement = target.closest<HTMLElement>(".react-flow__node[data-id]");
    const nodeId = nodeElement?.dataset.id;
    if (!nodeId || !useCanvasStore.getState().nodes.some((node) => node.id === nodeId)) return;

    if (touchSelection.current) window.clearTimeout(touchSelection.current.timer);
    const session = {
      pointerId: event.pointerId,
      nodeId,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
      activated: false,
      desired: null as string[] | null,
      selectionBefore: [...useCanvasStore.getState().selection],
    };
    session.timer = window.setTimeout(() => {
      if (touchSelection.current !== session) return;
      const selected = new Set(session.selectionBefore);
      if (selected.has(nodeId)) selected.delete(nodeId);
      else selected.add(nodeId);
      session.desired = [...selected];
      session.activated = true;
      applyTouchSelection(session.desired);
    }, 420);
    touchSelection.current = session;
  }

  function moveTouchSelection(event: React.PointerEvent) {
    const session = touchSelection.current;
    if (!session || session.pointerId !== event.pointerId || session.activated) return;
    if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) <= 9) return;
    window.clearTimeout(session.timer);
    touchSelection.current = null;
  }

  function finishTouchSelection(event: React.PointerEvent) {
    const session = touchSelection.current;
    if (!session || session.pointerId !== event.pointerId) return;
    window.clearTimeout(session.timer);
    touchSelection.current = null;
    if (!session.activated || !session.desired) return;
    // React Flow completes its ordinary tap selection on release. Reapply the
    // authored multi-selection immediately afterward so it wins that race.
    window.setTimeout(() => applyTouchSelection(session.desired!), 0);
  }

  function cancelTouchSelection(event: React.PointerEvent) {
    const session = touchSelection.current;
    if (!session || session.pointerId !== event.pointerId) return;
    window.clearTimeout(session.timer);
    touchSelection.current = null;
  }

  function onDoubleClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("react-flow__pane") || readOnly) return;
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    createCardAt(pos.x, pos.y, "", true);
  }

  function onDrop(e: React.DragEvent) {
    if (readOnly) return;
    // Top-left corner at the drop point, so whatever lands sits under the
    // cursor rather than somewhere it has to be found and moved.
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });

    const cardId = e.dataTransfer.getData("application/x-canvas-card");
    if (cardId) {
      e.preventDefault();
      const rawCard = e.dataTransfer.getData("application/x-canvas-card-data");
      if (!rawCard) {
        placeInboxCard(cardId, pos.x, pos.y);
        return;
      }
      try {
        const card = JSON.parse(rawCard) as Card;
        void api
          .post(`/api/canvases/${canvasId}/placements`, {
            card_id: card.id,
            x: pos.x,
            y: pos.y,
          })
          .then(() => {
            showToast(`Placed “${card.title ?? "card"}” here`);
            return loadCanvas(canvasId);
          })
          .catch((error) =>
            showToast(error instanceof Error ? error.message : "Could not place that card")
          );
      } catch {
        showToast("Could not read that portal card");
      }
      return;
    }

    const kind = e.dataTransfer.getData("application/x-canvas-new");
    if (kind) {
      e.preventDefault();
      newCardOfType(kind as CardType, pos.x, pos.y);
    }
  }

  useEffect(() => {
    function onInboxTouchDrop(event: Event) {
      if (readOnly) return;
      const { cardId, clientX, clientY } = (event as CustomEvent<InboxTouchDropDetail>).detail;
      const target = document.elementFromPoint(clientX, clientY);
      // Releasing over the actual flow surface counts. Releasing back on the
      // inbox or over toolbar controls simply cancels the drag.
      if (!target?.closest(".react-flow") || target.closest(".inbox-panel, .canvas-toolbar")) {
        return;
      }
      const pos = screenToFlowPosition({ x: clientX, y: clientY });
      void placeInboxCard(cardId, pos.x, pos.y);
    }
    window.addEventListener(INBOX_TOUCH_DROP_EVENT, onInboxTouchDrop);
    return () => window.removeEventListener(INBOX_TOUCH_DROP_EVENT, onInboxTouchDrop);
  }, [readOnly, placeInboxCard, screenToFlowPosition]);

  /** Everything the toolbar can drop, and what it starts life as.
   *
   * Dragging rather than clicking is the point: a card made from a button has
   * to appear *somewhere*, and the middle of the screen is usually on top of
   * something else. Dropped, it lands where it was aimed. */
  async function newCardOfType(kind: CardType, x: number, y: number) {
    if (kind === "checklist") {
      createCardAt(x, y, "", true, "checklist", { items: [{ text: "", done: false }] });
      return;
    }
    if (kind === "table") {
      createCardAt(x, y, "", false, "table", {
        rows: [
          ["", "", ""],
          ["", "", ""],
          ["", "", ""],
        ],
        header: true,
      });
      return;
    }
    if (kind === "column") {
      const title = await promptDialog({
        title: "New column",
        label: "Title",
        placeholder: "Filming",
        confirmLabel: "Create column",
      });
      if (title) createColumn(x, y, title);
      return;
    }
    if (kind === "board") {
      const name = await promptDialog({
        title: "New board",
        label: "Name",
        placeholder: "Storyboard",
        confirmLabel: "Create board",
      });
      if (name) createBoard(x, y, name);
      return;
    }
    if (kind === "portal") {
      setPortalAt({ x, y });
      return;
    }
    // Notes open for quick capture; documents open directly into their full
    // writing surface instead of leaving a blank card that needs a second
    // interaction.
    createCardAt(x, y, "", kind === "text" || kind === "document", kind);
  }

  function composeSelection() {
    const selected = nodes.filter((node) => selection.includes(node.id));
    if (selected.length < 2) return;
    const cardIds = [...new Set(selected.map((node) => node.data.card.id))];
    if (cardIds.length < 2) return;
    const right = Math.max(
      ...selected.map((node) => node.position.x + (node.width ?? node.data.w))
    );
    const top = Math.min(...selected.map((node) => node.position.y));
    composeCards(cardIds, { x: right + 70, y: top });
  }

  function tidySelection() {
    const selectedIds = new Set(selection);
    const selected = nodes
      .filter((node) => selectedIds.has(node.id) && !node.data.parentId)
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    if (selected.length < 2) return;

    const gap = 32;
    const obstacleGap = 20;
    const left = Math.min(...selected.map((node) => node.position.x));
    const top = Math.min(...selected.map((node) => node.position.y));
    const area = selected.reduce((total, node) => {
      const size = effectiveSize(node);
      return total + (size.w + gap) * (size.h + gap);
    }, 0);
    // A slightly landscape packing target suits the canvas and avoids a tall
    // single-file result when cards have very different shapes.
    const targetWidth = Math.max(360, Math.sqrt(area * 1.55));
    const local = new Map<string, { x: number; y: number; w: number; h: number }>();
    let x = 0;
    let y = 0;
    let rowHeight = 0;

    for (const node of selected) {
      const size = effectiveSize(node);
      if (x > 0 && x + size.w > targetWidth) {
        x = 0;
        y += rowHeight + gap;
        rowHeight = 0;
      }
      local.set(node.id, { x, y, w: size.w, h: size.h });
      x += size.w + gap;
      rowHeight = Math.max(rowHeight, size.h);
    }

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const obstacles = nodes
      .filter((node) => !selectedIds.has(node.id) && !node.data.parentId)
      .map((node) => {
        const size = effectiveSize(node);
        const at = worldPosition(node, byId);
        return { x: at.x, y: at.y, w: size.w, h: size.h };
      });
    const overlaps = (
      a: { x: number; y: number; w: number; h: number },
      b: { x: number; y: number; w: number; h: number }
    ) =>
      a.x < b.x + b.w + obstacleGap &&
      a.x + a.w + obstacleGap > b.x &&
      a.y < b.y + b.h + obstacleGap &&
      a.y + a.h + obstacleGap > b.y;
    const clearAt = (anchorX: number, anchorY: number) => {
      for (const item of local.values()) {
        const placed = {
          x: anchorX + item.x,
          y: anchorY + item.y,
          w: item.w,
          h: item.h,
        };
        if (obstacles.some((obstacle) => overlaps(placed, obstacle))) return false;
      }
      return true;
    };

    // Search outward from the selection's current corner. Tidy stays local,
    // but will move the group as a unit rather than laying it over cards that
    // were deliberately left out of the selection.
    const step = 48;
    const candidates: { x: number; y: number; distance: number }[] = [];
    for (let dx = -20; dx <= 20; dx++) {
      for (let dy = -20; dy <= 20; dy++) {
        candidates.push({
          x: left + dx * step,
          y: top + dy * step,
          distance: dx * dx + dy * dy,
        });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const anchor = candidates.find((candidate) => clearAt(candidate.x, candidate.y));
    if (!anchor) {
      showToast("Could not find clear space near those cards");
      return;
    }

    const positions = new Map<string, { x: number; y: number }>();
    for (const [id, item] of local) {
      positions.set(id, { x: anchor.x + item.x, y: anchor.y + item.y });
    }

    const moved = selected.filter((node) => {
      const next = positions.get(node.id)!;
      return node.position.x !== next.x || node.position.y !== next.y;
    });
    if (moved.length === 0) return;
    const undoItems = moved.map((node) => ({
        kind: "geometry",
        placementId: node.id,
        x: node.position.x,
        y: node.position.y,
        w: node.data.w,
        h: node.data.h,
      }) as const);
    pushUndo(
      undoItems.length === 1
        ? undoItems[0]
        : { kind: "geometry-group", items: undoItems }
    );
    setNodes((current) =>
      current.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position } : node;
      })
    );
    moved.forEach((node) => savePlacement(node.id));
    showToast(`Tidied ${moved.length} card${moved.length === 1 ? "" : "s"}`);
  }

  return (
    <div
      ref={wrapperRef}
      className={`canvas-page canvas-appearance-${canvasAppearance} ${
        CONTAINER_LAYOUT_STUDY ? "container-layout-study" : ""
      } ${dragging ? "is-dragging" : ""}`}
      style={
        {
          "--card-copy-size": `${canvasTextSize}px`,
          "--card-copy-medium": `${Math.max(8, canvasTextSize - 1)}px`,
          "--card-copy-small": `${Math.max(8, canvasTextSize - 2)}px`,
          "--card-copy-tiny": `${Math.max(8, canvasTextSize - 2.5)}px`,
          "--card-copy-micro": `${Math.max(7, canvasTextSize - 4)}px`,
          "--card-copy-table": `${Math.max(9, canvasTextSize - 0.5)}px`,
        } as CSSProperties
      }
      onPointerMove={(e) => {
        lastPointer.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerDownCapture={beginTouchSelection}
      onPointerMoveCapture={moveTouchSelection}
      onPointerUpCapture={finishTouchSelection}
      onPointerCancelCapture={cancelTouchSelection}
      onContextMenuCapture={(event) => {
        if (touchSelection.current?.activated) event.preventDefault();
      }}
      onDoubleClick={onDoubleClick}
      onDragOver={(e) => {
        const types = e.dataTransfer.types;
        if (
          types.includes("application/x-canvas-card") ||
          types.includes("application/x-canvas-new")
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = types.includes("application/x-canvas-new")
            ? "copy"
            : "move";
        }
      }}
      onDrop={onDrop}
    >
      <header className="canvas-toolbar">
        <div className="toolbar-group">
          <Link to="/" className="canvas-back" title="All boards">
            <Logo size={20} />
          </Link>
          {parents.map((parent) => (
            <Link key={parent.id} to={`/c/${parent.id}`} className="crumb">
              {parent.name}
              <span className="crumb-sep">›</span>
            </Link>
          ))}
          <span className="canvas-title">{canvasName}</span>
          {role === "owner" && (
            <details ref={appearancePickerRef} className="toolbar-more appearance-picker">
              <summary title="Change this canvas's visual style">
                <Icon name="theme" />
                {CANVAS_APPEARANCES.find((item) => item.id === canvasAppearance)?.label}
              </summary>
              <div className="toolbar-more-menu appearance-picker-menu">
                {CANVAS_APPEARANCES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={canvasAppearance === option.id ? "is-active" : ""}
                    onClick={(event) => {
                      void updateCanvasAppearance(option.id);
                      event.currentTarget.closest("details")?.removeAttribute("open");
                    }}
                  >
                    <span className={`mood-dot appearance-${option.id}`} />
                    {option.label}
                  </button>
                ))}
              </div>
            </details>
          )}
          <div className="toolbar-text-stepper" title="Card body text size">
            <Icon name="textStyle" />
            <button
              type="button"
              onClick={() => updateCanvasTextSize(canvasTextSize - 1)}
              disabled={canvasTextSize <= MIN_CANVAS_TEXT_SIZE}
              aria-label="Decrease card text size"
              title="Decrease card text size"
            >
              −
            </button>
            <output aria-live="polite" title={`${canvasTextSize} pixels`}>{canvasTextSize}</output>
            <button
              type="button"
              onClick={() => updateCanvasTextSize(canvasTextSize + 1)}
              disabled={canvasTextSize >= MAX_CANVAS_TEXT_SIZE}
              aria-label="Increase card text size"
              title="Increase card text size"
            >
              +
            </button>
          </div>
          {readOnly && <span className="role-badge">view only</span>}
          {role === "owner" && (
            <button
              className="tool icon-only"
              onClick={() => setPublicLensOpen(true)}
              title="Share a public view"
              aria-label="Share a public view"
            >
              <Icon name="share" />
            </button>
          )}
        </div>

        {!readOnly && (
          <div className="toolbar-group">
            {selection.filter((id) => {
              const node = nodes.find((candidate) => candidate.id === id);
              return node && !node.data.parentId;
            }).length >= 2 && (
              <button
                className="tool"
                onClick={tidySelection}
                title="Arrange selected cards into a compact grid"
              >
                <Icon name="table" /> Tidy
              </button>
            )}
            {generationAvailable && selection.length >= 2 && (
              <button
                className="tool"
                onClick={composeSelection}
                title="Draft a document from the selected cards"
              >
                <Icon name="document" /> Draft selected
              </button>
            )}
            {/* Drag one onto the board to place it where you want it; a click
                still works and drops it in the middle of the view. Checklists
                and tables arrive usable rather than empty. */}
            {PRIMARY_TOOLS.map((tool) => (
              <button
                key={tool.kind}
                className="tool is-draggable"
                draggable
                title={`${tool.label} — drag onto the board`}
                aria-label={tool.label}
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-canvas-new", tool.kind);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => {
                  const pos = screenToFlowPosition(centerOfWrapper());
                  newCardOfType(tool.kind, pos.x, pos.y);
                }}
              >
                <Icon name={tool.icon} /> {tool.label}
              </button>
            ))}
            <details className="toolbar-more" ref={moreToolsRef}>
              <summary className="tool" title="More card types and canvas objects">
                <Icon name="more" /> More
              </summary>
              <div className="toolbar-more-menu">
                {MORE_TOOLS.map((tool) => (
                  <button
                    key={tool.kind}
                    type="button"
                    className="toolbar-more-item is-draggable"
                    draggable
                    title={`${tool.label} — drag onto the board`}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/x-canvas-new", tool.kind);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => {
                      const pos = screenToFlowPosition(centerOfWrapper());
                      newCardOfType(tool.kind, pos.x, pos.y);
                      if (moreToolsRef.current) moreToolsRef.current.open = false;
                    }}
                  >
                    <Icon name={tool.icon} /> {tool.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="toolbar-more-item"
                  onClick={async () => {
                    if (moreToolsRef.current) moreToolsRef.current.open = false;
                    const name = await promptDialog({
                      title: "New zone",
                      label: "Name",
                      confirmLabel: "Create zone",
                    });
                    if (!name) return;
                    const center = screenToFlowPosition(centerOfWrapper());
                    await createZone({ name, x: center.x - 360, y: center.y - 260 });
                  }}
                >
                  <span className="tool-glyph">▱</span> Zone
                </button>
                <label className="toolbar-more-item toolbar-more-file">
                  <Icon name="image" /> Image
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const pos = screenToFlowPosition(centerOfWrapper());
                        createImageCard(pos.x, pos.y, file);
                      }
                      e.target.value = "";
                      if (moreToolsRef.current) moreToolsRef.current.open = false;
                    }}
                  />
                </label>
                <label className="toolbar-more-item toolbar-more-file">
                  <Icon name="file" /> File
                  <input
                    type="file"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const pos = screenToFlowPosition(centerOfWrapper());
                        createFileCard(pos.x, pos.y, file);
                      }
                      e.target.value = "";
                      if (moreToolsRef.current) moreToolsRef.current.open = false;
                    }}
                  />
                </label>
              </div>
            </details>
          </div>
        )}

        <div className="toolbar-group">
          <button className="tool" onClick={() => setSearchOpen(true)} title="Search (Ctrl+F)">
            <Icon name="search" /> Search
          </button>
          {graph && (
            <button className="tool" onClick={fitToRevealed} title="Frame the revealed cards">
              <Icon name="expand" /> Fit
            </button>
          )}
          <button
            className="tool"
            onClick={() => setCheatOpen(true)}
            title="Gestures and shortcuts (?)"
          >
            <span aria-hidden="true">?</span> Help
          </button>
          <button
            className="tool"
            onClick={() => cycleTheme()}
            title="Switch theme"
          >
            <Icon name="theme" /> Theme
          </button>
        </div>
      </header>

      {!readOnly && <InboxPanel />}
      <FocusShelf />
      <SearchOverlay />
      <SuggestionsPanel />
      {portalAt && (
        <PortalEditor
          currentCanvasId={canvasId}
          onClose={() => setPortalAt(null)}
          onSave={async (title, config) => {
            try {
              await createCardAt(
                portalAt.x,
                portalAt.y,
                "",
                false,
                "portal",
                config as unknown as Record<string, unknown>,
                title
              );
              setPortalAt(null);
            } catch (error) {
              showToast(error instanceof Error ? error.message : "Could not create the portal");
            }
          }}
        />
      )}

      <ReactFlow
        nodes={renderNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onSelectionChange={onSelectionChange}
        onNodeClick={onNodeClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        nodesDraggable={!readOnly}
        onEdgeClick={(_, edge) => setSelectedLinkId(edge.id)}
        onPaneClick={() => {
          if (moreToolsRef.current) moreToolsRef.current.open = false;
          if (appearancePickerRef.current) appearancePickerRef.current.open = false;
          setSelectedLinkId(null);
          setMenuOpenFor(null);
          clearReveal();
        }}
        onMoveStart={() => {
          if (moreToolsRef.current) moreToolsRef.current.open = false;
          if (appearancePickerRef.current) appearancePickerRef.current.open = false;
        }}
        onMoveEnd={onMoveEnd}
        nodeTypes={nodeTypes}
        nodeExtent={canvasExtent}
        translateExtent={canvasExtent}
        defaultViewport={loadViewport(canvasId)}
        minZoom={0.1}
        maxZoom={2.5}
        panOnDrag
        panActivationKeyCode="Space"
        selectionKeyCode="Shift"
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={26}
          size={1.6}
          color="var(--canvas-dots)"
        />
        {!canvasInfinite && (
          <ViewportPortal>
            <div
              className="canvas-boundary"
              style={{ width: canvasWidth, height: canvasHeight }}
              aria-hidden="true"
            />
          </ViewportPortal>
        )}
        {zones.length > 0 && (
          <ViewportPortal>
            {zones.map((zone) => <CanvasZone key={zone.id} zone={zone} readOnly={readOnly} />)}
          </ViewportPortal>
        )}
        {alignmentGuides && (
          <ViewportPortal>
            {alignmentGuides.x !== null && (
              <div
                className="canvas-alignment-guide is-vertical"
                style={{
                  left: alignmentGuides.x,
                  width: alignmentGuides.stroke,
                }}
              />
            )}
            {alignmentGuides.y !== null && (
              <div
                className="canvas-alignment-guide is-horizontal"
                style={{
                  top: alignmentGuides.y,
                  height: alignmentGuides.stroke,
                }}
              />
            )}
          </ViewportPortal>
        )}
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          bgColor="var(--minimap-bg)"
          maskColor="var(--minimap-mask)"
          maskStrokeColor="var(--border-strong)"
          maskStrokeWidth={1}
          nodeColor={minimapNodeColor}
          nodeStrokeColor="var(--minimap-node-stroke)"
          nodeStrokeWidth={1.5}
          nodeBorderRadius={2}
        />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>

      <LinkPicker />
      <BoardPicker />
      <LinkPanel />
      {publicLensOpen && (
        <PublicLensDialog
          canvasId={canvasId}
          canvasName={canvasName}
          nodes={nodes}
          links={canvasLinks}
          selection={selection}
          appearance={canvasAppearance}
          textSize={canvasTextSize}
          onClose={() => setPublicLensOpen(false)}
          onNotice={showToast}
        />
      )}
      {cheatOpen && <CheatSheet onClose={() => setCheatOpen(false)} />}
      <Lightbox />

      {toast && <div className="canvas-toast">{toast}</div>}
    </div>
  );
}

export default function CanvasPage() {
  const { canvasId } = useParams<{ canvasId: string }>();
  if (!canvasId) return null;
  // Keyed by canvas: stepping through a portal to another board must start a
  // fresh flow. Without this, React reuses the instance, `defaultViewport` is
  // never re-read, and you arrive still panned to the previous canvas's
  // coordinates — looking at empty space until a reload.
  return (
    <ReactFlowProvider key={canvasId}>
      <CanvasInner canvasId={canvasId} />
    </ReactFlowProvider>
  );
}
