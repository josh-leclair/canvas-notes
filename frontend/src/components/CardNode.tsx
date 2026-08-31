import { memo, useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, useStore, type NodeProps } from "@xyflow/react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Card, CardPlacementInfo, CardType } from "../api/types";
import { taskProgress, toggleTaskLine } from "../lib/tasks";
import { tintGradient } from "../lib/tint";
import {
  URL_PATTERN,
  YOUTUBE_PATTERN,
  isSpotifyUrl,
  withoutAttachmentUrls,
} from "../lib/urls";
import CardMarkdown from "./CardMarkdown";
import AudioViewer from "./AudioViewer";
import DocumentEditor from "./DocumentEditor";
import ChecklistCardBody from "./ChecklistCardBody";
import TableCardBody from "./TableCardBody";
import ColourPicker from "./ColourPicker";
import {
  axesFor,
  hasAccent,
  huesForAppearance,
  paintOf,
  paintStyle,
  withPaint,
  type Axis,
  type PaintValue,
} from "./cardPaint";
import Icon from "./Icon";
import ImageCropper, { type Crop } from "./ImageCropper";
import { couldHaveAlpha, detectAlpha, knownAlpha } from "../lib/imageAlpha";
import EditorToolbar from "./EditorToolbar";
import CardReferencePicker from "./CardReferencePicker";
import PortalCardBody from "./PortalCardBody";
import { useCanvasStore, type CardNode as CardNodeType } from "../store/canvasStore";
import { confirmDialog } from "../store/dialogStore";
import AudioCardBody from "./AudioCardBody";
import SideHandles from "./SideHandles";
import SpotifyAttachment from "./SpotifyAttachment";
import YouTubeAttachment from "./YouTubeAttachment";
import FloatingCardMenu from "./FloatingCardMenu";
import { CARD_OVERVIEW_ZOOM } from "../lib/canvasBounds";
import "./cardNode.css";

/** xyflow zooms the canvas on wheel unless an element opts out with the
 * `nowheel` class. Applying it always would leave short cards swallowing the
 * gesture and doing nothing, so it goes on only while the content actually
 * has somewhere to scroll. */
function useScrollable() {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setScrollable(el.scrollHeight > el.clientHeight + 1);
    check();
    const resize = new ResizeObserver(check);
    resize.observe(el);
    // Markdown can reflow without the box itself changing size.
    const mutate = new MutationObserver(check);
    mutate.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutate.disconnect();
    };
  });

  return { ref, nowheel: scrollable ? " nowheel" : "" };
}

/** Mirrors MIN_SPLIT_CHARS in backend/app/generate.py. Below it there is
 * nothing to break up, so the menu does not offer an action that would only
 * come back as an error. */
const MIN_SPLIT_CHARS = 200;

/** The text a split would work from, matching splittable_text() on the
 * server: what the card says, not what it is called. */
function splittableLength(card: Card): number {
  const payload = card.payload as {
    transcript?: string;
    unfurl?: { description?: string };
  };
  return (
    (card.body?.length ?? 0) +
    (payload.transcript?.length ?? 0) +
    (payload.unfurl?.description?.length ?? 0)
  );
}

/** How small each kind of card may be dragged.
 *
 * A board tile is one row — an icon beside a name — so holding it to the
 * 100px floor meant for prose left it mostly empty space. */
const MIN_SIZE: Partial<Record<CardType, { width: number; height: number }>> = {
  board: { width: 180, height: 76 },
  checklist: { width: 180, height: 70 },
  table: { width: 180, height: 60 },
  link: { width: 160, height: 84 },
  audio: { width: 180, height: 92 },
  // A glyph with a name under it, so it wants to be tallish rather than wide.
  file: { width: 128, height: 118 },
  portal: { width: 260, height: 180 },
};
const DEFAULT_MIN = { width: 160, height: 100 };


interface UnfurlProduct {
  price?: string;
  currency?: string;
  brand?: string;
  availability?: string;
  rating?: string;
  rating_count?: string;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
  CAD: "CA$",
  AUD: "A$",
  JPY: "¥",
};

function priceLabel(product: UnfurlProduct): string | null {
  if (!product.price) return null;
  const code = product.currency ?? "";
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${product.price}` : `${product.price} ${code}`.trim();
}

export function LinkCardBody({
  card,
  onMediaLoad,
  onCardReference,
  externalLinksNewTab = false,
}: {
  card: Card;
  onMediaLoad?: () => void;
  onCardReference?: (cardId: string) => void;
  externalLinksNewTab?: boolean;
}) {
  const url = card.payload.url as string | undefined;
  const unfurl = card.payload.unfurl as
    | {
        title?: string;
        description?: string;
        image?: string;
        site_name?: string;
        final_url?: string;
        product?: UnfurlProduct;
      }
    | undefined;
  const status = card.payload.unfurl_status as string | undefined;
  const product = unfurl?.product;
  // Where the link actually landed, so a shortener shows its destination
  // rather than its own domain.
  let host = "";
  try {
    const resolved = unfurl?.final_url ?? url;
    host = resolved ? new URL(resolved).hostname.replace(/^www\./, "") : "";
  } catch {
    host = "";
  }
  return (
    <div className="link-card">
      {unfurl?.image && (
        <img
          className="link-card-image"
          src={unfurl.image}
          alt=""
          onLoad={onMediaLoad}
        />
      )}
      <div className="link-card-text">
        <a
          className="link-card-title nodrag"
          href={url}
          target="_blank"
          rel="noreferrer noopener"
        >
          {card.title ?? unfurl?.title ?? url ?? "Link"}
        </a>
        {product && (priceLabel(product) || product.rating || product.brand) && (
          <div className="link-card-facts">
            {priceLabel(product) && (
              <span className="link-card-price">{priceLabel(product)}</span>
            )}
            {product.rating && (
              <span className="link-card-rating">
                ★ {product.rating}
                {product.rating_count && ` (${product.rating_count})`}
              </span>
            )}
            {product.brand && !priceLabel(product) && (
              <span className="link-card-brand">{product.brand}</span>
            )}
            {product.availability === "OutOfStock" && (
              <span className="link-card-oos">out of stock</span>
            )}
          </div>
        )}
        {unfurl?.description && (
          <div className="link-card-description">{unfurl.description}</div>
        )}
        <div className="link-card-host">
          {/* Most pages have no og:image, which left link cards as a wall of
              text. A favicon is nearly always there and is enough to make
              the source recognisable at a glance. */}
          {host && !unfurl?.image && (
            <img
              className="link-card-favicon"
              src={`https://${host}/favicon.ico`}
              alt=""
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          )}
          <span>{unfurl?.site_name ?? host}</span>
          {status === "queued" && <span> · unfurling…</span>}
          {status === "error" && <span> · could not unfurl</span>}
        </div>
        {card.body && (
          <div className="card-body">
            <CardMarkdown
              body={card.body}
              onCardReference={onCardReference}
              externalLinksNewTab={externalLinksNewTab}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** A YouTube card is always a static thumbnail.
 *
 * Nothing plays inline: an iframe swallows every click in its area, which
 * both made videos trivial to start by accident and left only a sliver of
 * card to grab. The whole card is draggable, and only the play badge — a
 * small, deliberate target — opens the video in the lightbox. */
function YouTubeCardBody({ card }: { card: Card }) {
  const openLightbox = useCanvasStore((s) => s.openLightbox);
  const videoId = card.payload.video_id as string | undefined;
  if (!videoId) return <LinkCardBody card={card} />;

  return (
    <div className="youtube-card">
      <div className="youtube-thumb">
        <img src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`} alt="" />
        <button
          className="youtube-play nodrag"
          title="Play video"
          onClick={(e) => {
            e.stopPropagation();
            openLightbox({
              kind: "video",
              videoId,
              title: card.title ?? null,
              origin: (e.currentTarget as HTMLElement)
                .closest(".react-flow__node")
                ?.getBoundingClientRect(),
            });
          }}
        >
          <Icon name="play" size={20} />
        </button>
      </div>
      <CardCaption card={card} />
    </div>
  );
}

/** Title and body beneath a media card.
 *
 * Optional, and quiet when absent. Only a text card is *about* its title and
 * body; on a photograph or a recording they are a caption, and a caption that
 * nobody wrote should take up no room and draw no chrome. */
function CardCaption({ card }: { card: Card }) {
  if (!card.title && !card.body) return null;
  // A caption holding nothing but a URL reads as machine output at full
  // length. Show where it goes instead, and keep it clickable.
  const bare = card.body?.trim() ?? "";
  let bareHost = "";
  if (/^https?:\/\/\S+$/.test(bare)) {
    try {
      bareHost = new URL(bare).hostname.replace(/^www\./, "");
    } catch {
      bareHost = "";
    }
  }
  return (
    <div className="card-caption">
      {card.title && <div className="card-title">{card.title}</div>}
      {bareHost ? (
        <a
          className="card-caption-link nodrag"
          href={bare}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(e) => e.stopPropagation()}
        >
          {bareHost}
        </a>
      ) : (
        card.body && (
          <div className="card-body">
            <CardMarkdown body={card.body} />
          </div>
        )
      )}
    </div>
  );
}

export function imageSrcOf(card: Card): string | null {
  const fileId = card.payload.image_file_id as string | undefined;
  return fileId ? `/api/files/${fileId}` : null;
}

function ImageCardBody({
  card,
  onAlpha,
}: {
  card: Card;
  onAlpha: (transparent: boolean) => void;
}) {
  const openLightbox = useCanvasStore((s) => s.openLightbox);
  const src = imageSrcOf(card);
  if (!src) {
    return <div className="image-card-missing">No image attached</div>;
  }
  const crop = card.payload.crop as Crop | undefined;
  // The crop is applied in CSS against the untouched file: the image is blown
  // up so the chosen rectangle fills the frame, and the rest overflows out of
  // it. Nothing is re-encoded, so reverting is just dropping the payload key.
  const cropped: React.CSSProperties | undefined = crop
    ? {
        position: "absolute",
        width: `${100 / crop.w}%`,
        height: `${100 / crop.h}%`,
        left: `${(-crop.x * 100) / crop.w}%`,
        top: `${(-crop.y * 100) / crop.h}%`,
        objectFit: "fill",
        maxWidth: "none",
      }
    : undefined;
  return (
    <div className="image-card">
      <div
        className={`image-card-frame ${crop ? "is-cropped" : ""}`}
        style={{ "--image-src": `url(${src})` } as React.CSSProperties}
      >
        <img
          src={src}
          alt={card.title ?? ""}
          style={cropped}
          /* Measured when the picture appears, so the card losing its frame
           * happens in the same moment the image arrives rather than as a
           * second change a beat later. */
          onLoad={(e) => {
            if (couldHaveAlpha(card.payload.image_mime as string | undefined)) {
              onAlpha(detectAlpha(e.currentTarget, src));
            }
          }}
        />
        <button
          className="image-expand nodrag"
          title="Enlarge"
          onClick={(e) => {
            e.stopPropagation();
            openLightbox({
              kind: "image",
              src,
              title: card.title ?? null,
              origin: (e.currentTarget as HTMLElement)
                .closest(".react-flow__node")
                ?.getBoundingClientRect(),
            });
          }}
        >
          <Icon name="expand" />
        </button>
      </div>
      <CardCaption card={card} />
    </div>
  );
}

function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Any attachment, as an object on the canvas.
 *
 * Shaped like the document icon, because it is the same kind of thing: a
 * glyph with its name under it and one number of context. There is nothing
 * to preview — the whole point of this card is the files that are neither a
 * picture nor a recording — so the icon *is* the card rather than a badge
 * pinned to the left of a strip of text. The extension is written across the
 * glyph the way a real file icon carries it. */
function FileCardBody({ card }: { card: Card }) {
  const fileId = card.payload.file_id as string | undefined;
  const name = (card.payload.file_name as string | undefined) ?? "Attachment";
  const bytes = card.payload.file_bytes as number | undefined;
  if (!fileId) {
    return <div className="image-card-missing">No file attached</div>;
  }
  const extension = name.includes(".") ? name.split(".").pop()!.toUpperCase() : "FILE";
  return (
    <div className="file-card">
      <div className="file-card-badge" title={extension}>
        <Icon name="file" className="file-card-glyph" />
        <span className="file-card-ext">{extension.slice(0, 4)}</span>
      </div>
      <div className="file-card-text">
        <div className="file-card-name" title={name}>
          {name}
        </div>
        <div className="file-card-meta">{humanBytes(bytes ?? 0)}</div>
      </div>
      {/* Bottom right, clear of the ⋯ menu that sits in the top corner. */}
      <a
        className="file-card-download nodrag"
        href={`/api/files/${fileId}`}
        download={name}
        title={`Download ${name}`}
        aria-label={`Download ${name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <Icon name="download" size={17} />
      </a>
    </div>
  );
}

/** A board card: the whole tile is a door into another canvas.
 *
 * Borrowed from Milanote's board tiles — a coloured icon, the board's name,
 * and how much is inside — because it reads as a container at a glance and
 * survives being small. */
function BoardCardBody({ card }: { card: Card }) {
  const navigate = useNavigate();
  const board = card.board;

  if (!board) {
    return (
      <div className="board-card is-missing">
        <span className="board-icon board-icon-missing">✕</span>
        <span className="board-text">
          <span className="board-name">{card.title ?? "Board"}</span>
          <span className="board-count">no longer available</span>
        </span>
      </div>
    );
  }

  // The tile is drag surface, like every other card. Opening is the chevron,
  // or a double-click — a whole-card click handler would leave nothing to
  // grab, which is what happened to image cards.
  return (
    <div
      className="board-card"
      title={`Open “${board.name}” — double-click, or use the arrow`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        navigate(`/c/${board.canvas_id}`);
      }}
    >
      <span
        className="board-icon"
        style={
          board.has_cover
            ? { backgroundImage: `url(/api/canvases/${board.canvas_id}/cover)` }
            : { background: tintGradient(board.canvas_id) }
        }
      >
        {!board.has_cover && <span className="board-glyph">▦</span>}
      </span>
      <span className="board-text">
        <span className="board-name">{board.name}</span>
        <span className="board-count">
          {board.card_count} {board.card_count === 1 ? "card" : "cards"}
          {board.role !== "owner" && " · shared"}
        </span>
      </span>
      <button
        className="board-chevron nodrag"
        title={`Open “${board.name}”`}
        onClick={(e) => {
          e.stopPropagation();
          navigate(`/c/${board.canvas_id}`);
        }}
      >
        ›
      </button>
    </div>
  );
}

function CardNodeImpl({ id, data, selected }: NodeProps<CardNodeType>) {
  const { card } = data;
  const zoom = useStore((s) => s.transform[2]);
  const editOnMount = useCanvasStore((s) => s.editOnMount);
  const clearEditOnMount = useCanvasStore((s) => s.clearEditOnMount);
  const updateCard = useCanvasStore((s) => s.updateCard);
  const savePlacement = useCanvasStore((s) => s.savePlacement);
  const setNodes = useCanvasStore((s) => s.setNodes);
  const removePlacements = useCanvasStore((s) => s.removePlacements);
  const deleteCard = useCanvasStore((s) => s.deleteCard);
  const setLinkPickerFor = useCanvasStore((s) => s.setLinkPickerFor);
  const setPlaceOnBoardFor = useCanvasStore((s) => s.setPlaceOnBoardFor);
  const showToast = useCanvasStore((s) => s.showToast);
  const pushUndo = useCanvasStore((s) => s.pushUndo);
  const toggleHub = useCanvasStore((s) => s.toggleHub);
  const toggleFocus = useCanvasStore((s) => s.toggleFocus);
  const focused = useCanvasStore((s) =>
    s.focusShelf.some((item) => item.card.id === card.id)
  );
  const role = useCanvasStore((s) => s.role);
  const canvasAppearance = useCanvasStore((s) => s.canvasAppearance);
  const canvasTextSize = useCanvasStore((s) => s.canvasTextSize);
  const readOnly = role === "viewer";
  const resizeOrigin = useRef<
    { kind: "geometry"; placementId: string; x: number; y: number; w: number; h: number }[]
  >([]);
  const resizeGroup = useRef<string[]>([]);

  const content = useScrollable();
  const minSizeRef = useRef(100);
  const [cropping, setCropping] = useState(false);
  const [writing, setWriting] = useState(false);
  const [listening, setListening] = useState(false);
  const [editing, setEditing] = useState(false);
  const [checklistFocusRequest, setChecklistFocusRequest] = useState(0);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [referenceAt, setReferenceAt] = useState<{ from: number; to: number } | null>(
    null
  );
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Menu open state lives in the store so the canvas can lift this node above
  // its neighbours while the dropdown is showing.
  const menuOpenFor = useCanvasStore((s) => s.menuOpenFor);
  const setMenuOpenFor = useCanvasStore((s) => s.setMenuOpenFor);
  const generationAvailable = useCanvasStore((s) => s.generationAvailable);
  const splitCard = useCanvasStore((s) => s.splitCard);
  const reportMemberHeight = useCanvasStore((s) => s.reportMemberHeight);
  const selection = useCanvasStore((s) => s.selection);
  const touchCard = useCanvasStore((s) => s.touchCard);
  const menuOpen = menuOpenFor === id;
  const closeMenu = () => setMenuOpenFor(null);

  useEffect(() => {
    if (editOnMount === id) {
      if (card.type === "checklist") setChecklistFocusRequest((request) => request + 1);
      else if (card.type === "document") setWriting(true);
      else startEditing();
      clearEditOnMount();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editOnMount, id]);

  useEffect(() => {
    if (editing) bodyRef.current?.focus();
  }, [editing]);

  /* A card stacked in a column is sized to its content rather than to
   * whatever height it happened to have on the open canvas, so a one-line
   * link and a long note do not both take the same slab of space.
   *
   * The measurement sums the content's children, which do not depend on the
   * height being set — measuring the scroll box instead would feed its own
   * result back in and never settle. `chrome` is the card's padding and
   * borders, which move with the box, so the total converges after one pass
   * and the store drops sub-pixel changes on the floor. */
  /** What this card's height would have to be to show all of it. Measured
   * from the content's children rather than the scroll box, whose height is
   * the very thing being decided. */
  const contentHeight = useCallback((): number | null => {
    const el = content.ref.current;
    const box = el?.closest(".card-node") as HTMLElement | null;
    if (!el || !box) return null;
    const style = getComputedStyle(el);
    const gap = parseFloat(style.rowGap) || 0;
    const kids = Array.from(el.children) as HTMLElement[];
    const stacked =
      kids.reduce((total, kid) => total + kid.offsetHeight, 0) +
      Math.max(0, kids.length - 1) * gap +
      (parseFloat(style.paddingTop) || 0) +
      (parseFloat(style.paddingBottom) || 0);
    return stacked + (box.offsetHeight - el.offsetHeight);
  }, [content.ref]);

  /** Shrink a free-standing card to its content. Column members do this
   * automatically; out on the canvas the size is the user's business, so it
   * stays a deliberate action. */
  const fitToContent = useCallback(() => {
    const wanted = contentHeight();
    if (!wanted) return;
    const height = Math.round(Math.max(minSizeRef.current, Math.min(560, wanted)));
    setNodes((nodes) =>
      nodes.map((n) => (n.id === id ? { ...n, height, data: { ...n.data, h: height } } : n))
    );
    savePlacement(id);
  }, [contentHeight, id, setNodes, savePlacement]);

  /** Documents switch between their two looks by size, because the size is
   *  what the card queries to decide. "Fit to content" cannot mean anything
   *  for a document — the content is a whole document — so these stand in its
   *  place and are the same two presets the container query is cut for. */
  const setCardSize = useCallback(
    (width: number, height: number) => {
      setNodes((nodes) =>
        nodes.map((n) =>
          n.id === id
            ? { ...n, width, height, data: { ...n.data, w: width, h: height } }
            : n
        )
      );
      savePlacement(id);
    },
    [id, setNodes, savePlacement]
  );

  const unfurlStatus = card.payload.unfurl_status;
  const spotifyStatus = card.payload.spotify_status;
  const autoFitMedia = useRef(false);
  useEffect(() => {
    if (data.parentId) return;
    /* A checklist and a table are *always* the size of what is in them:
     * adding an item or a row grows the card, removing one shrinks it, and
     * there is nothing to resize by hand. Every other type is fitted once,
     * when its content first arrives, and is the user's to size after that. */
    const alwaysFits = card.type === "checklist" || card.type === "table";
    const fitsOnce =
      card.type === "file" ||
      (card.type === "text" && spotifyStatus === "done") ||
      ((card.type === "link" || card.type === "youtube") &&
        unfurlStatus === "done");
    if (!alwaysFits && !fitsOnce) return;

    const wanted = contentHeight();
    if (!wanted) return;

    if (alwaysFits) {
      // A pixel or two of slack, or a rounding difference would have the
      // card and the measurement pushing each other back and forth for ever.
      if (Math.abs(Math.round(wanted) - Math.round(data.h)) <= 2) return;
      fitToContent();
      return;
    }

    // 180 is the placement default, so any other height is one somebody
    // chose. There is no "already done" flag on purpose: a canvas reload can
    // land after the fit and restore the default, and the guard above means
    // this simply fits it again rather than leaving a card half-sized.
    if (Math.round(data.h) !== 180) return;
    autoFitMedia.current = true;
    fitToContent();
    // card.body is in here as the content signal. For a checklist or a table
    // it is the mirror the server regenerates, so it changes on every item or
    // row — without it this effect never re-ran when the card grew, because
    // none of its other dependencies move when you add a line.
  }, [
    unfurlStatus,
    spotifyStatus,
    card.type,
    card.body,
    data.h,
    data.parentId,
    fitToContent,
    contentHeight,
    canvasTextSize,
  ]);

  const fitLoadedMedia = useCallback(() => {
    if (!autoFitMedia.current) return;
    requestAnimationFrame(fitToContent);
  }, [fitToContent]);

  const inColumn = Boolean(data.parentId);
  const spotifyLink = card.type === "link" && isSpotifyUrl(card.payload.url);
  const compactSpotify = spotifyLink && (
    (inColumn && !selected) || (!inColumn && card.payload.spotify_display === "compact")
  );
  /* A stack is a list of things, not a wall of prose. A text card in a column
   * shows its title and the first line of its body; clicking it opens the
   * rest in place. Nothing is stored for this — the clamp changes the
   * content's height, the same measurement that sizes column members picks
   * that up, and the column reflows around it. */
  const previewInColumn =
    inColumn && !selected && card.type === "text" &&
    card.payload.display !== "heading";

  useEffect(() => {
    if (!inColumn) {
      reportMemberHeight(id, null);
      return;
    }
    const el = content.ref.current;
    const box = el?.closest(".card-node") as HTMLElement | null;
    if (!el || !box) return;

    const measure = () => reportMemberHeight(id, contentHeight());

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    Array.from(el.children).forEach((kid) => observer.observe(kid));
    return () => observer.disconnect();
    // previewInColumn is in here on purpose: expanding a card changes how
    // tall its content is, and that has to be measured again rather than
    // waited for.
  }, [inColumn, previewInColumn, id, reportMemberHeight, card.body, card.title, content.ref]);

  function startEditing() {
    setDraftTitle(card.title ?? "");
    setDraftBody(card.body ?? "");
    setEditing(true);
  }

  function beginEditing() {
    closeMenu();
    if (card.type === "checklist") {
      setChecklistFocusRequest((request) => request + 1);
      return;
    }
    startEditing();
  }

  /** Double-click edits any card type. Interactive controls inside a card
   * (play, expand, audio transport) stop propagation, so they never trip it. */
  function editOnDoubleClick(e: React.MouseEvent) {
    if (readOnly) return;
    e.stopPropagation();
    // A document opens its own surface rather than turning the card into a
    // textarea: the whole point of the mode is that the card is the wrong
    // shape for what is in it.
    if (isDocument) setWriting(true);
    else startEditing();
  }

  async function save() {
    setEditing(false);
    const title = draftTitle.trim() === "" ? null : draftTitle.trim();
    const body = draftBody;
    if (title === card.title && body === card.body) return;
    try {
      // A text card whose body is just a URL becomes a link/YouTube card.
      const trimmed = body.trim();
      if (card.type === "text" && URL_PATTERN.test(trimmed)) {
        await updateCard(card.id, {
          title,
          body: null,
          type: YOUTUBE_PATTERN.test(trimmed) ? "youtube" : "link",
          payload: { url: trimmed },
        });
        return;
      }
      await updateCard(card.id, { title, body });
    } catch {
      showToast("Could not save the card");
    }
  }

  function pickReference(target: Card) {
    if (!referenceAt) return;
    const label = (target.title ?? "Untitled")
      .replace(/\s+/g, " ")
      .replace(/([\\\[\]])/g, "\\$1");
    const token = `[${label}](card:${target.id})`;
    const next =
      draftBody.slice(0, referenceAt.from) + token + draftBody.slice(referenceAt.to);
    const caret = referenceAt.from + token.length;
    setDraftBody(next);
    setReferenceAt(null);
    void touchCard(target.id);
    requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(caret, caret);
    });
  }

  async function removeFromCanvas() {
    closeMenu();
    const placements = await api.get<CardPlacementInfo[]>(
      `/api/cards/${card.id}/placements`
    );
    if (placements.length <= 1) {
      const ok = await confirmDialog({
        title: "Remove from this canvas?",
        body: "This card lives nowhere else, so it will move back to your inbox. Its content is kept.",
        confirmLabel: "Remove",
      });
      if (!ok) return;
    }
    await removePlacements([id]);
  }

  async function destroyCard() {
    closeMenu();
    const placements = await api.get<CardPlacementInfo[]>(
      `/api/cards/${card.id}/placements`
    );
    const others = placements
      .filter((p) => p.id !== id)
      .map((p) => p.canvas_name);
    const ok = await confirmDialog({
      title: `Delete “${card.title ?? "this card"}” permanently?`,
      body:
        others.length > 0
          ? "This cannot be undone. It will be removed from every canvas it appears on:"
          : "This cannot be undone. To keep the card, remove it from this canvas instead.",
      details: others,
      confirmLabel: "Delete card",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteCard(card.id);
    } catch {
      showToast("Could not delete the card");
    }
  }

  // The spine, glyph and low-zoom slab all take their colour from here. A
  // card the user has painted overrides its type colour, since a deliberate
  // choice should win over a default.
  const isHeading = card.payload.display === "heading";
  const isDocument = card.type === "document";
  /* A heading is sized against the card, but a long title at the same size as
   * a one-word one wraps to four lines and stops being a heading. Shrink it
   * in proportion to how much there is to fit; CSS cannot count characters,
   * so the ratio is handed over as a variable. */
  const headingFit = isHeading
    ? Math.min(1, 20 / Math.max((card.title ?? "").length, 1))
    : null;
  /* A cut-out sits on the canvas rather than on a card, so a transparent
   * image drops the surface behind it. Seeded from the cache rather than
   * false: the answer for a given file never changes, and starting at false
   * every time would put the frame back for a frame on every revisit. */
  const [imageTransparent, setImageTransparent] = useState(
    () => knownAlpha(imageSrcOf(card) ?? "") ?? false
  );

  const paint = paintOf(card);
  const axes = axesFor(card);
  /* The type's own colour is only a default for the accent, and only for the
   * kinds of card that wear one. A note stays bare until you give it one. */
  /* An icon is an icon: below this it stops being a card and becomes a glyph
   * with a name under it. Decided here rather than in a container query,
   * because a container query can only style a container's *descendants* —
   * and everything that has to go is on the card itself. */
  const asIcon =
    (isDocument || card.type === "file") &&
    (data.w <= 190 || data.h <= 150);
  const wearsAccent = hasAccent(card, paint.accent) && !asIcon;
  /* An icon has no bar to put the accent on, so the accent becomes the glyph
   * itself — and the type's own colour is not substituted in, because an
   * unchosen icon should read as a plain grey file rather than as one that
   * has been given a colour. */
  const accent = {
    ...paintStyle(paint),
    ...(paint.accent || asIcon
      ? {}
      : { "--card-accent": `var(--cardtype-${card.type})` }),
  } as React.CSSProperties;
  /* Counted off the markdown, so the syntax a document is stored in does not
   * inflate the number the card shows. */
  const documentWords = isDocument
    ? (card.body ?? "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[#*_`>~\-]/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length
    : 0;
  const minSize = MIN_SIZE[card.type] ?? DEFAULT_MIN;
  minSizeRef.current = minSize.height;
  const progress = taskProgress(card.body);

  async function applyCrop(next: Crop | null) {
    setCropping(false);
    const payload = { ...card.payload };
    if (next) payload.crop = next;
    else delete payload.crop;
    try {
      await updateCard(card.id, { payload });
    } catch {
      showToast("Could not crop that image");
      return;
    }
    // Reshape the card to the crop, or the picked rectangle would be squeezed
    // back into the old proportions. Falls back to the natural image when the
    // crop is removed.
    const natural = await new Promise<{ w: number; h: number } | null>((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
      probe.onerror = () => resolve(null);
      probe.src = `/api/files/${card.payload.image_file_id}`;
    });
    if (!natural || !natural.w) return;
    const ratio = next
      ? (natural.h * next.h) / (natural.w * next.w)
      : natural.h / natural.w;
    const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
    if (!node) return;
    const height = Math.round(
      Math.min(560, Math.max(90, node.data.w * ratio))
    );
    setNodes((nodes) =>
      nodes.map((n) =>
        n.id === id
          ? { ...n, height, data: { ...n.data, h: height } }
          : n
      )
    );
    savePlacement(id);
  }

  /** Cards a size change should carry to.
   *
   * Only when more than one is selected, and never a column or a card inside
   * one: both of those are sized by the stack they belong to, so writing a
   * size onto them would be overwritten on the next layout pass anyway. */
  const sizeGroup = useCallback((): string[] => {
    if (selection.length < 2 || !selection.includes(id)) return [id];
    const all = useCanvasStore.getState().nodes;
    return selection.filter((placementId) => {
      const node = all.find((n) => n.id === placementId);
      return (
        node && node.data.card.type !== "column" && !node.data.parentId
      );
    });
  }, [selection, id]);

  /** Apply one size to every card in the group, each held to its own type's
   * minimum so a board tile is not squeezed to the floor meant for prose. */
  const applySize = useCallback(
    (width: number, height: number, ids: string[]) => {
      const targets = new Set(ids);
      setNodes((nodes) =>
        nodes.map((n) => {
          if (!targets.has(n.id)) return n;
          const floor = MIN_SIZE[n.data.card.type] ?? DEFAULT_MIN;
          const w = Math.max(width, floor.width);
          const h = Math.max(height, floor.height);
          return { ...n, width: w, height: h, data: { ...n.data, w, h } };
        })
      );
      ids.forEach(savePlacement);
    },
    [setNodes, savePlacement]
  );

  async function toggleDocument() {
    closeMenu();
    try {
      await updateCard(card.id, { type: isDocument ? "text" : "document" });
    } catch {
      showToast("Could not change that card");
    }
  }

  async function toggleHeading() {
    closeMenu();
    const payload = { ...card.payload };
    if (isHeading) delete payload.display;
    else payload.display = "heading";
    try {
      await updateCard(card.id, { payload });
    } catch {
      showToast("Could not change that card");
    }
  }

  async function setPaint(axis: Axis, next: PaintValue | null) {
    closeMenu();
    const payload = withPaint(card.payload, axis, next);
    try {
      await updateCard(card.id, { payload });
    } catch {
      showToast("Could not change the colour");
    }
  }

  async function toggleSpotifyDisplay() {
    closeMenu();
    const payload = { ...card.payload };
    payload.spotify_display = compactSpotify ? "artwork" : "compact";
    try {
      await updateCard(card.id, { payload });
      requestAnimationFrame(fitToContent);
    } catch {
      showToast("Could not change the Spotify card layout");
    }
  }

  async function toggleTask(line: number) {
    if (readOnly || !card.body) return;
    const next = toggleTaskLine(card.body, line);
    if (next === card.body) return;
    try {
      await updateCard(card.id, { body: next });
    } catch {
      showToast("Could not update that task");
    }
  }

  // Folded away by a hub: a title bar holding its place until the hub opens.
  if (data.collapsed) {
    return (
      <>
        <SideHandles connectable={!readOnly} inColumn={Boolean(data.parentId)} />
        <div className="card-node card-collapsed" style={accent}>
          {/* The space this card takes back when it unfolds, shown while
              something is being dragged so you can park around it. */}
          <span className="collapsed-reserve" style={{ height: data.h }} />
          <span className="collapsed-dot" />
          <span className="collapsed-title">
            {card.title ?? card.body?.slice(0, 60) ?? "Untitled"}
          </span>
        </div>
      </>
    );
  }

  /* Keep column members in their normal representation at every zoom. Their
   * compact preview is part of the container layout, not merely a visual
   * detail: replacing it with the low-zoom slab drops the preview class and
   * disconnects the content-height observer. When the full card mounts again
   * after zooming in, the stack can therefore retain the expanded height.
   * Free-standing cards can degrade safely because their geometry is fixed. */
  if (zoom < CARD_OVERVIEW_ZOOM && !inColumn) {
    return (
      <>
        <SideHandles connectable={!readOnly} inColumn={Boolean(data.parentId)} />
        <div className="card-node card-degraded" style={accent}>
          <span>{card.title ?? card.body?.slice(0, 40) ?? ""}</span>
        </div>
      </>
    );
  }

  return (
    // Handles and the resizer live outside the card box on purpose: the card
    // clips its overflow to keep media inside its rounded corners, which
    // would otherwise cut the grab targets in half.
    <>
      <SideHandles connectable={!readOnly} inColumn={inColumn} />
      <NodeResizer
        isVisible={
          selected &&
          !readOnly &&
          card.type !== "table" &&
          card.type !== "checklist"
        }
        minWidth={minSize.width}
        minHeight={minSize.height}
        // z-index keeps the corners grabbable above card content: media
        // cards fill their whole box, and would otherwise swallow the drag.
        // Small and round: the handles sit on top of the card art, so they
        // should read as grips rather than four blue slabs.
        handleStyle={{
          width: 9,
          height: 9,
          borderRadius: 999,
          borderWidth: 2,
          zIndex: 20,
        }}
        lineStyle={{ borderWidth: 3, opacity: 0, zIndex: 19 }}
        onResizeStart={() => {
          const all = useCanvasStore.getState().nodes;
          // Every card the drag will touch, so undo puts all of them back.
          resizeGroup.current = sizeGroup();
          resizeOrigin.current = resizeGroup.current
            .map((placementId) => all.find((n) => n.id === placementId))
            .filter((n): n is CardNodeType => Boolean(n))
            .map((n) => ({
              kind: "geometry" as const,
              placementId: n.id,
              x: n.position.x,
              y: n.position.y,
              w: n.data.w,
              h: n.data.h,
            }));
        }}
        onResize={(_, params) => {
          // The card under the cursor keeps the exact drag; the rest of the
          // selection follows it to the same size.
          const group = resizeGroup.current.length ? resizeGroup.current : [id];
          const targets = new Set(group);
          setNodes((nodes) =>
            nodes.map((n) => {
              if (!targets.has(n.id)) return n;
              const floor = MIN_SIZE[n.data.card.type] ?? DEFAULT_MIN;
              const w = n.id === id ? params.width : Math.max(params.width, floor.width);
              const h = n.id === id ? params.height : Math.max(params.height, floor.height);
              return { ...n, width: w, height: h, data: { ...n.data, w, h } };
            })
          );
        }}
        onResizeEnd={() => {
          // Only the cards that actually changed, the way a multi-drag only
          // records the ones that actually moved.
          const live = useCanvasStore.getState().nodes;
          for (const before of resizeOrigin.current) {
            const now = live.find((n) => n.id === before.placementId);
            if (now && (now.data.w !== before.w || now.data.h !== before.h)) {
              pushUndo(before);
            }
          }
          resizeOrigin.current = [];
          (resizeGroup.current.length ? resizeGroup.current : [id]).forEach(
            savePlacement
          );
          resizeGroup.current = [];
        }}
      />

      {writing && (
        <DocumentEditor card={card} onClose={() => setWriting(false)} />
      )}
      {listening && (
        <AudioViewer card={card} onClose={() => setListening(false)} />
      )}

      {cropping && (
        <ImageCropper
          src={`/api/files/${card.payload.image_file_id}`}
          initial={(card.payload.crop as Crop | undefined) ?? null}
          onCancel={() => setCropping(false)}
          onApply={applyCrop}
        />
      )}

      {referenceAt && (
        <CardReferencePicker
          sourceCardId={card.id}
          nearby={useCanvasStore.getState().nodes.map((node) => node.data.card)}
          onPick={pickReference}
          onClose={() => {
            setReferenceAt(null);
            requestAnimationFrame(() => bodyRef.current?.focus());
          }}
        />
      )}

      {/* Outside the card box: it clips its overflow for rounded media, which
          would cut the dropdown off on a small card. */}
      <div className="card-menu-anchor">
        <button
          ref={menuButtonRef}
          className="card-menu-button nodrag"
          onClick={(e) => {
            e.stopPropagation();
            const next = menuOpen ? null : id;
            setMenuOpenFor(next);
          }}
        >
          <Icon name="more" />
        </button>
        <FloatingCardMenu
          anchorRef={menuButtonRef}
          open={menuOpen}
          onClose={closeMenu}
          appearance={canvasAppearance}
        >
            {!readOnly && card.type !== "portal" && (
              <button onClick={beginEditing}>
                {card.type === "text"
                  ? "Edit"
                  : card.type === "checklist"
                    ? "Edit to-do list"
                  : card.type === "audio"
                    ? "Rename"
                    : "Edit title and text"}
              </button>
            )}
            <button
              onClick={() => {
                closeMenu();
                setLinkPickerFor(card.id);
              }}
            >
              Link to…
            </button>
            <button
              onClick={() => {
                closeMenu();
                toggleFocus(card);
              }}
            >
              {focused ? "Remove from focus" : "Add to focus"}
            </button>
            {/* Not gated on readOnly: the new cards are yours and this one is
                never touched, so viewing is enough — same as linking. */}
            {generationAvailable && splittableLength(card) >= MIN_SPLIT_CHARS && (
              <button
                onClick={() => {
                  closeMenu();
                  splitCard(card.id);
                }}
              >
                Split into cards…
              </button>
            )}
            {!readOnly && card.type === "text" && (
              <button onClick={toggleHeading}>
                {isHeading ? "Make a note" : "Make a heading"}
              </button>
            )}
            {!readOnly && (card.type === "text" || isDocument) && !isHeading && (
              <button onClick={toggleDocument}>
                {isDocument ? "Make a note" : "Make a document"}
              </button>
            )}
            {!readOnly && isDocument && (
              <button
                onClick={() => {
                  closeMenu();
                  setWriting(true);
                }}
              >
                Open for writing
              </button>
            )}
            {card.type === "audio" && (
              <button
                onClick={() => {
                  closeMenu();
                  setListening(true);
                }}
              >
                Open transcript
              </button>
            )}
            {!readOnly && spotifyLink && !inColumn && (
              <button onClick={toggleSpotifyDisplay}>
                {compactSpotify ? "Show album artwork" : "Show compact Spotify link"}
              </button>
            )}
            {!readOnly && !inColumn && isDocument && (
              <button
                onClick={() => {
                  closeMenu();
                  setCardSize(150, 132);
                }}
              >
                Show as icon
              </button>
            )}
            {!readOnly && !inColumn && isDocument && (
              <button
                onClick={() => {
                  closeMenu();
                  setCardSize(300, 380);
                }}
              >
                Show as page
              </button>
            )}
            {!readOnly && !inColumn && !isDocument && card.type !== "portal" && (
              <button
                onClick={() => {
                  closeMenu();
                  fitToContent();
                }}
              >
                Fit to content
              </button>
            )}
            {/* Only worth offering when there is something to match to. The
                card whose menu this is sets the size, so which one wins is
                the one you opened. */}
            {!readOnly && sizeGroup().length > 1 && (
              <button
                onClick={() => {
                  closeMenu();
                  const group = sizeGroup();
                  const all = useCanvasStore.getState().nodes;
                  resizeOrigin.current = group
                    .map((placementId) => all.find((n) => n.id === placementId))
                    .filter((n): n is CardNodeType => Boolean(n))
                    .map((n) => ({
                      kind: "geometry" as const,
                      placementId: n.id,
                      x: n.position.x,
                      y: n.position.y,
                      w: n.data.w,
                      h: n.data.h,
                    }));
                  resizeOrigin.current
                    .filter((before) => before.w !== data.w || before.h !== data.h)
                    .forEach(pushUndo);
                  resizeOrigin.current = [];
                  applySize(data.w, data.h, group);
                }}
              >
                Match size to this ({sizeGroup().length})
              </button>
            )}
            {!readOnly && card.type === "image" && Boolean(card.payload.image_file_id) && (
              <button
                onClick={() => {
                  closeMenu();
                  setCropping(true);
                }}
              >
                Crop image…
              </button>
            )}
            {!readOnly && (
              <button
                onClick={() => {
                  closeMenu();
                  setPlaceOnBoardFor({ cardId: card.id, title: card.title });
                }}
              >
                Place on another board…
              </button>
            )}
            {!readOnly && (
              <>
                <div className="card-menu-sep" />
                <ColourPicker
                  axes={axes}
                  paint={paint}
                  hues={huesForAppearance(canvasAppearance)}
                  onPick={setPaint}
                />
                <div className="card-menu-sep" />
                <button onClick={removeFromCanvas}>Remove from canvas</button>
                <button className="menu-danger" onClick={destroyCard}>
                  Delete card…
                </button>
              </>
            )}
        </FloatingCardMenu>
      </div>

      <div
        className={`card-node ${selected ? "is-selected" : ""} ${
          paint.fill ? "is-painted" : ""
        } ${wearsAccent ? "has-accent" : ""} ${asIcon ? "is-icon" : ""} ${
          inColumn ? "is-member" : ""
        } ${
          isHeading ? "is-heading" : ""
        } ${imageTransparent ? "is-cutout" : ""} type-${card.type} ${
          (data.childCount ?? 0) > 0 ? "has-pip" : ""
        } ${previewInColumn ? "is-preview" : ""} ${
          isDocument ? "is-document" : ""
        }`}
        style={
          headingFit === null
            ? accent
            : ({ ...accent, "--heading-fit": headingFit } as React.CSSProperties)
        }
      >
      {(data.childCount ?? 0) > 0 && (
        <button
          className={`hub-pip nodrag ${data.isHub ? "is-hub" : ""}`}
          title={
            data.isHub
              ? "Hub: children fold away unless this card is selected"
              : `Fold this card's ${data.childCount} ${
                  data.childCount === 1 ? "child" : "children"
                } away`
          }
          onClick={(e) => {
            e.stopPropagation();
            toggleHub(id);
          }}
        >
          {data.isHub ? "▾" : "▸"} {data.childCount}
        </button>
      )}

      {editing ? (
        <div
          className="card-editor nodrag nowheel"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setEditing(false);
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
        >
          <input
            placeholder="Title"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={(e) => {
              if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null))
                save();
            }}
          />
          {/* An audio card has no body to write, so it gets the title field
              and nothing else — the card shows a transcript, and a prose box
              underneath it would be writing into a space that never appears. */}
          {card.type !== "audio" && (
            <>
              {card.type !== "text" && card.type !== "link" && (
                <EditorToolbar
                  textarea={bodyRef}
                  value={draftBody}
                  onChange={setDraftBody}
                  onReference={() => {
                    const from = bodyRef.current?.selectionStart ?? draftBody.length;
                    const to = bodyRef.current?.selectionEnd ?? from;
                    setReferenceAt({ from, to });
                  }}
                />
              )}
              <textarea
                ref={bodyRef}
                className="nowheel"
                placeholder="Write something…"
                value={draftBody}
                onChange={(e) => {
                  const next = e.target.value;
                  const caret = e.target.selectionStart;
                  setDraftBody(next);
                  if (caret >= 2 && next.slice(caret - 2, caret) === "[[") {
                    setReferenceAt({ from: caret - 2, to: caret });
                  }
                }}
                onBlur={(e) => {
                  if (referenceAt) return;
                  if (
                    !e.currentTarget.parentElement?.contains(
                      e.relatedTarget as Node | null
                    )
                  )
                    save();
                }}
              />
            </>
          )}
        </div>
      ) : card.type === "link" && compactSpotify ? (
        <div
          ref={content.ref}
          className={`card-content media-card-content${content.nowheel}`}
          onDoubleClick={editOnDoubleClick}
        >
          <SpotifyAttachment card={card} standalone={!inColumn} />
        </div>
      ) : card.type === "link" ? (
        <div
          ref={content.ref}
          className={`card-content${content.nowheel}`}
          onDoubleClick={editOnDoubleClick}
        >
          <LinkCardBody card={card} onMediaLoad={fitLoadedMedia} />
        </div>
      ) : card.type === "youtube" ? (
        <div
          ref={content.ref}
          className={`card-content card-content-flush${content.nowheel}`}
          onDoubleClick={editOnDoubleClick}
        >
          <YouTubeCardBody card={card} />
        </div>
      ) : card.type === "portal" ? (
        <div
          ref={content.ref}
          className="card-content card-content-flush"
        >
          <PortalCardBody card={card} readOnly={readOnly} />
        </div>
      ) : card.type === "board" ? (
        <div
          ref={content.ref}
          className={`card-content card-content-flush${content.nowheel}`}
        >
          <BoardCardBody card={card} />
        </div>
      ) : card.type === "image" ? (
        <div
          ref={content.ref}
          className={`card-content card-content-flush${content.nowheel}`}
          onDoubleClick={editOnDoubleClick}
        >
          <ImageCardBody card={card} onAlpha={setImageTransparent} />
        </div>
      ) : card.type === "checklist" ? (
        <div ref={content.ref} className={`card-content${content.nowheel}`}>
          <ChecklistCardBody
            card={card}
            readOnly={readOnly}
            focusRequest={checklistFocusRequest}
          />
        </div>
      ) : card.type === "table" ? (
        <div ref={content.ref} className={`card-content${content.nowheel}`}>
          {card.title && <div className="card-title">{card.title}</div>}
          <TableCardBody card={card} selected={selected} />
        </div>
      ) : card.type === "file" ? (
        <div
          ref={content.ref}
          className={`card-content${content.nowheel}`}
          onDoubleClick={editOnDoubleClick}
        >
          <FileCardBody card={card} />
        </div>
      ) : card.type === "audio" ? (
        <div
          ref={content.ref}
          className={`card-content${content.nowheel}`}
          onDoubleClick={() => setListening(true)}
        >
          {card.title && <div className="card-title">{card.title}</div>}
          {/* No body. What an audio card has to say is the transcript, and a
              second block of prose under it was a text card's habit showing
              through — it also gave the card something else to be sized by. */}
          <AudioCardBody card={card} />
        </div>
      ) : isDocument ? (
        /* A document card is a look at the document, not a window onto it:
         * no scrolling, and the last lines fade out to say there is more.
         * The footer names what it is, which is what makes it obvious the
         * card can be opened rather than read in place. */
        <div
          ref={content.ref}
          className="card-content doc-card"
          onDoubleClick={() => setWriting(true)}
        >
          <div className="doc-card-page">
            <CardMarkdown body={card.body ?? ""} />
          </div>
          <div className="doc-card-foot">
            <Icon name="document" className="doc-card-icon" />
            <div className="doc-card-meta">
              <span className="doc-card-name">{card.title || "Untitled"}</span>
              <span className="doc-card-words">
                {documentWords} word{documentWords === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        </div>
      ) : (
        // Double-click to edit; a plain drag anywhere on the card moves it.
        <div
          ref={content.ref}
          className={`card-content${content.nowheel}`}
          onDoubleClick={editOnDoubleClick}
        >
          {card.title && (
            <div className="card-title">
              {card.title}
              {progress.total > 0 && (
                <span
                  className={`task-progress ${
                    progress.done === progress.total ? "is-done" : ""
                  }`}
                >
                  {progress.done}/{progress.total}
                </span>
              )}
            </div>
          )}
          <div className="card-body">
            <CardMarkdown
              body={withoutAttachmentUrls(card.body ?? "", [
                card.payload.spotify_url,
                card.payload.youtube_url,
              ])}
              onToggleTask={toggleTask}
            />
          </div>
          {card.type === "text" && typeof card.payload.spotify_url === "string" && (
            <SpotifyAttachment card={card} />
          )}
          {card.type === "text" && typeof card.payload.youtube_url === "string" && (
            <YouTubeAttachment card={card} />
          )}
        </div>
      )}
      </div>
    </>
  );
}

export default memo(CardNodeImpl);
