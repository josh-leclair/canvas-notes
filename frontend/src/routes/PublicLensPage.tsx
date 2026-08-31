import { memo, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Card, PublicLensPlacement, PublicLensView } from "../api/types";
import CardMarkdown from "../components/CardMarkdown";
import { LinkCardBody } from "../components/CardNode";
import Icon from "../components/Icon";
import SpotifyAttachment from "../components/SpotifyAttachment";
import YouTubeAttachment from "../components/YouTubeAttachment";
import { withoutAttachmentUrls } from "../lib/urls";
import Logo from "../components/Logo";
import { hasAccent, paintOf, paintStyle } from "../components/cardPaint";
import { COLUMN_WIDTH, MEMBER_WIDTH, columnHeight, memberOffset } from "../store/columnLayout";
import { normaliseCanvasAppearance } from "../lib/canvasAppearance";
import { normaliseCanvasTextSize } from "../lib/canvasTextSize";
import "./publicLensPage.css";

type LensNodeData = {
  card: PublicLensPlacement["card"];
  slug: string;
  column?: boolean;
  memberCount?: number;
  onReference: (cardId: string) => void;
};
type LensNode = Node<LensNodeData, "lensCard">;

function assetUrl(slug: string, id: unknown) {
  return typeof id === "string" ? `/api/public/lenses/${slug}/assets/${id}` : "";
}

function safeExternalUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function checklist(card: LensNodeData["card"]) {
  const raw = card.payload.items;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) =>
    typeof item === "string"
      ? { text: item, done: false }
      : { text: String((item as { text?: unknown }).text ?? ""), done: Boolean((item as { done?: unknown }).done) }
  );
}

function imagePosition(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const crop = value as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
  const x = Number(crop.x);
  const y = Number(crop.y);
  const w = Number(crop.w);
  const h = Number(crop.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return undefined;
  return { objectPosition: `${(x + w / 2) * 100}% ${(y + h / 2) * 100}%` };
}

function PublishedCard({
  card,
  slug,
  selected = false,
  column = false,
  memberCount = 0,
  onReference,
}: {
  card: PublicLensPlacement["card"];
  slug: string;
  selected?: boolean;
  column?: boolean;
  memberCount?: number;
  onReference: (cardId: string) => void;
}) {
  const fullCard = card as Card;
  const paint = paintOf(fullCard);
  const isHeading = card.payload.display === "heading";
  const wearsAccent = hasAccent(fullCard, paint.accent);
  const headingFit = isHeading
    ? Math.min(1, 20 / Math.max((card.title ?? "").length, 1))
    : null;
  const style = {
    ...paintStyle(paint),
    ...(!paint.accent && wearsAccent
      ? { "--card-accent": `var(--cardtype-${card.type})` }
      : {}),
    ...(headingFit === null ? {} : { "--heading-fit": headingFit }),
  } as CSSProperties;
  const rows = Array.isArray(card.payload.rows) ? card.payload.rows as unknown[][] : [];
  const widths = Array.isArray(card.payload.widths) ? card.payload.widths.map(Number) : [];
  const externalUrl = safeExternalUrl(card.payload.url);
  const videoId = typeof card.payload.video_id === "string" ? card.payload.video_id : null;

  if (column) {
    return (
      <article className={`public-lens-column ${selected ? "selected" : ""}`} style={style}>
        <strong>{card.title || "Untitled column"}</strong>
        <span>{memberCount} cards</span>
      </article>
    );
  }

  return (
    <article
      className={`card-node public-lens-card type-${card.type} ${
        selected ? "is-selected" : ""
      } ${wearsAccent ? "has-accent" : ""} ${paint.fill ? "is-painted" : ""} ${
        isHeading ? "is-heading" : ""
      } ${card.title || card.body ? "has-caption" : ""}`}
      style={style}
    >
      {card.type === "image" && card.payload.image_file_id ? (
        <img src={assetUrl(slug, card.payload.image_file_id)} alt={card.title || "Published image"} style={imagePosition(card.payload.crop)} />
      ) : null}
      {card.type === "audio" && card.payload.audio_file_id ? (
        <audio controls preload="metadata" src={assetUrl(slug, card.payload.audio_file_id)} />
      ) : null}
      {card.type === "youtube" && videoId ? (
        <div className="public-lens-youtube">
          <img src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`} alt="" />
          {externalUrl && (
            <a href={externalUrl} target="_blank" rel="noopener noreferrer" aria-label="Watch on YouTube">
              <Icon name="play" />
            </a>
          )}
          {(card.title || card.body) && (
            <div className="public-lens-youtube-caption">
              {card.title && <div className="card-title">{card.title}</div>}
              {card.body && <div className="card-body"><CardMarkdown body={card.body} onCardReference={onReference} externalLinksNewTab /></div>}
            </div>
          )}
        </div>
      ) : card.type === "link" ? (
        <div className="card-content public-lens-card-content">
          <LinkCardBody
            card={fullCard}
            onCardReference={onReference}
            externalLinksNewTab
          />
        </div>
      ) : (
        <div className="card-content public-lens-card-content">
          {card.title && <div className="card-title">{card.title}</div>}
          {card.type === "checklist" && (
            <ul className="public-lens-checklist">
              {checklist(card).map((item, index) => (
                <li className={item.done ? "is-done" : ""} key={index}>
                  <span className="public-lens-check" aria-hidden="true">
                    {item.done ? "✓" : ""}
                  </span>
                  {item.text}
                </li>
              ))}
            </ul>
          )}
          {card.type === "table" && rows.length > 0 && (
            <div className="public-lens-table-wrap"><table>
              {widths.length === (rows[0]?.length ?? 0) && <colgroup>{widths.map((width, index) => <col key={index} style={{ width: `${Math.max(0, width) * 100}%` }} />)}</colgroup>}
              <tbody>
              {rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{String(cell ?? "")}</td>)}</tr>)}
            </tbody></table></div>
          )}
          {card.body && card.type !== "checklist" && card.type !== "table" && (
            <div className="card-body">
              <CardMarkdown
                body={withoutAttachmentUrls(card.body, [card.payload.spotify_url, card.payload.youtube_url])}
                onCardReference={onReference}
                externalLinksNewTab
              />
            </div>
          )}
          {card.type === "text" && typeof card.payload.spotify_url === "string" && (
            <SpotifyAttachment card={fullCard} />
          )}
          {card.type === "text" && typeof card.payload.youtube_url === "string" && (
            <YouTubeAttachment card={fullCard} />
          )}
          {card.type === "youtube" && externalUrl && (
            <a className="public-lens-external nodrag nopan" href={externalUrl} target="_blank" rel="noopener noreferrer">Visit source</a>
          )}
          {card.type === "file" && card.payload.file_id ? (
            <a className="public-lens-file nodrag nopan" href={assetUrl(slug, card.payload.file_id)} download>
              <Icon name="download" /> {String(card.payload.file_name || "Download attachment")}
            </a>
          ) : null}
        </div>
      )}
    </article>
  );
}

function LensCard({ data, selected }: NodeProps<LensNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <PublishedCard
        card={data.card}
        slug={data.slug}
        selected={selected}
        column={data.column}
        memberCount={data.memberCount}
        onReference={data.onReference}
      />
    </>
  );
}

const nodeTypes = { lensCard: memo(LensCard) };

function buildNodes(view: PublicLensView, onReference: (cardId: string) => void): LensNode[] {
  const placements = view.snapshot.placements;
  const members = new Map<string, PublicLensPlacement[]>();
  for (const placement of placements) {
    if (!placement.parent_id) continue;
    const list = members.get(placement.parent_id) ?? [];
    list.push(placement);
    members.set(placement.parent_id, list);
  }
  for (const list of members.values()) list.sort((a, b) => a.sort - b.sort);

  return placements.map((placement) => {
    const kids = members.get(placement.id) ?? [];
    const isColumn = placement.card.type === "column";
    let width = isColumn ? COLUMN_WIDTH : placement.parent_id ? MEMBER_WIDTH : placement.w;
    let height = placement.h;
    let position = { x: placement.x, y: placement.y };
    if (isColumn) height = columnHeight(kids.map((kid) => kid.h));
    if (placement.parent_id) {
      const siblings = members.get(placement.parent_id) ?? [];
      const index = siblings.findIndex((item) => item.id === placement.id);
      position = memberOffset(siblings.map((item) => item.h), index);
    }
    return {
      id: placement.id,
      type: "lensCard" as const,
      position,
      width,
      height,
      parentId: placement.parent_id ?? undefined,
      zIndex: placement.z,
      draggable: false,
      selectable: true,
      data: { card: placement.card, slug: view.slug, column: isColumn, memberCount: kids.length, onReference },
    };
  }).sort((a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)) || (a.zIndex ?? 0) - (b.zIndex ?? 0));
}

function LensCanvas({ view }: { view: PublicLensView }) {
  const { fitView } = useReactFlow();
  const onReference = (cardId: string) => {
    const placement = view.snapshot.placements.find((item) => item.card.id === cardId);
    if (placement) void fitView({ nodes: [{ id: placement.id }], duration: 280, padding: 0.35 });
  };
  const nodes = useMemo(() => buildNodes(view, onReference), [view]);
  const placementByCard = useMemo(
    () => new Map(view.snapshot.placements.map((placement) => [placement.card.id, placement.id])),
    [view]
  );
  const edges = useMemo<Edge[]>(() => view.snapshot.links.flatMap((link) => {
    const source = placementByCard.get(link.source_card_id);
    const target = placementByCard.get(link.target_card_id);
    if (!source || !target) return [];
    const color = `var(--link-${link.link_type || "untyped"})`;
    return [{
      id: link.id,
      source,
      target,
      label: link.link_type?.replace(/_/g, " "),
      style: { stroke: color, strokeWidth: 2 },
      labelStyle: { fill: "var(--text-muted)", fontSize: 11 },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      selectable: false,
    }];
  }), [placementByCard, view.snapshot.links]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      fitView
      fitViewOptions={{ padding: 0.24, maxZoom: 1.1 }}
      minZoom={0.08}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} color="var(--canvas-dots)" gap={20} size={1} />
      <MiniMap position="bottom-right" pannable zoomable maskColor="var(--minimap-mask)" nodeColor="var(--minimap-node)" />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  );
}

function GuidedPresentation({ view }: { view: PublicLensView }) {
  const byId = useMemo(
    () => new Map(view.snapshot.placements.map((placement) => [placement.id, placement])),
    [view.snapshot.placements]
  );
  const slides = useMemo(() => {
    const sequence = view.snapshot.sequence ?? view.snapshot.placements
      .filter((placement) => !placement.parent_id)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((placement) => placement.id);
    return sequence.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
  }, [byId, view.snapshot.placements, view.snapshot.sequence]);
  const memberCount = (placementId: string) =>
    view.snapshot.placements.filter((placement) => placement.parent_id === placementId).length;
  const showSlide = (placementId: string) => {
    document.getElementById(`guided-slide-${placementId}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };
  const showOverview = () => {
    document.getElementById("guided-overview")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };
  const onReference = (cardId: string) => {
    const slide = slides.find((placement) => placement.card.id === cardId);
    if (slide) showSlide(slide.id);
  };

  return (
    <div className="guided-pages">
      {slides.map((placement, index) => (
        <section
          className={`guided-page type-${placement.card.type} ${placement.card.payload.display === "heading" ? "is-heading" : ""}`}
          id={`guided-slide-${placement.id}`}
          key={placement.id}
          aria-label={`Page ${index + 1} of ${slides.length}`}
        >
          <span className="guided-page-number">{index + 1} / {slides.length}</span>
          <div
            className="guided-card-stage"
            style={{ "--guided-card-ratio": `${Math.max(1, placement.w)} / ${Math.max(1, placement.h)}` } as CSSProperties}
          >
            <PublishedCard
              card={placement.card}
              slug={view.slug}
              column={placement.card.type === "column"}
              memberCount={memberCount(placement.id)}
              onReference={onReference}
            />
          </div>
          <nav className="guided-page-controls" aria-label={`Page ${index + 1} navigation`}>
            <button
              type="button"
              onClick={() => index > 0 && showSlide(slides[index - 1].id)}
              disabled={index === 0}
            >
              <Icon name="chevronLeft" />
              Previous
            </button>
            <button
              type="button"
              onClick={() => index < slides.length - 1 ? showSlide(slides[index + 1].id) : showOverview()}
            >
              {index < slides.length - 1 ? "Next" : "Overview"}
              <Icon name="chevronRight" />
            </button>
          </nav>
        </section>
      ))}
      <section className="guided-page guided-overview" id="guided-overview" aria-label="Presentation overview">
        <div className="guided-overview-inner">
          <div className="guided-overview-heading">
            <span>Overview</span>
            <h2>{view.title}</h2>
            <p>Select any page to return to it.</p>
          </div>
          <div className="guided-overview-grid">
            {slides.map((placement, index) => (
              <button
                type="button"
                className="guided-overview-slide"
                key={placement.id}
                onClick={() => showSlide(placement.id)}
                aria-label={`Open page ${index + 1}`}
              >
                <span className="guided-overview-number">{index + 1}</span>
                <span className="guided-overview-card">
                  <PublishedCard
                    card={placement.card}
                    slug={view.slug}
                    column={placement.card.type === "column"}
                    memberCount={memberCount(placement.id)}
                    onReference={() => undefined}
                  />
                </span>
              </button>
            ))}
          </div>
          {slides.length > 0 && (
            <nav className="guided-page-controls guided-overview-controls" aria-label="Overview navigation">
              <button type="button" onClick={() => showSlide(slides[slides.length - 1].id)}>
                <Icon name="chevronLeft" />
                Previous
              </button>
            </nav>
          )}
        </div>
      </section>
    </div>
  );
}

function PublicLensRoute() {
  const { slug } = useParams<{ slug: string }>();
  const [view, setView] = useState<PublicLensView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!slug) return;
    api.get<PublicLensView>(`/api/public/lenses/${slug}`)
      .then(setView)
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? "This public lens is unavailable or has been revoked." : "Could not load this public lens."));
  }, [slug]);

  if (error) return <main className="public-lens-state"><Logo size={30} /><h1>Lens unavailable</h1><p>{error}</p></main>;
  if (!view) return <main className="public-lens-state"><Logo size={30} /><p>Loading public lens…</p></main>;
  const appearance = normaliseCanvasAppearance(view.snapshot.appearance);
  const textSize = normaliseCanvasTextSize(view.snapshot.text_size);
  const isGuided = view.snapshot.view_mode === "presentation";
  return (
    <main
      className={`public-lens-page canvas-appearance-${appearance} ${isGuided ? "is-guided" : ""}`}
      style={{
        "--card-copy-size": `${textSize}px`,
        "--card-copy-medium": `${Math.max(8, textSize - 1)}px`,
        "--card-copy-small": `${Math.max(8, textSize - 2)}px`,
        "--card-copy-tiny": `${Math.max(8, textSize - 2.5)}px`,
        "--card-copy-micro": `${Math.max(7, textSize - 4)}px`,
        "--card-copy-table": `${Math.max(9, textSize - 0.5)}px`,
      } as CSSProperties}
    >
      <header className="public-lens-header">
        <Logo size={22} />
        <div><h1>{view.title}</h1>{view.description && <p>{view.description}</p>}</div>
        <span>Read-only snapshot · revision {view.revision}</span>
      </header>
      {isGuided
        ? <GuidedPresentation view={view} />
        : <LensCanvas view={view} />}
    </main>
  );
}

export default function PublicLensPage() {
  return <ReactFlowProvider><PublicLensRoute /></ReactFlowProvider>;
}
