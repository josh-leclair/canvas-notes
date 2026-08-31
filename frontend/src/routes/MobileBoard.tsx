import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { CanvasDetail, CanvasSummary, Card, Link as CardLink, PlacementWithCard, Zone } from "../api/types";
import MobileCard from "../components/MobileCard";
import MobileComposer from "../components/MobileComposer";
import "./mobile.css";

function isTitleCard(card: Card) {
  return Boolean(card.title && !card.body?.trim() && (card.type === "text" || card.type === "document"));
}

function orderCards(placements: PlacementWithCard[], links: CardLink[]): Card[] {
  const cards = placements.map((placement) => placement.card);
  const present = new Set(cards.map((card) => card.id));
  const children = new Map<string, string[]>();
  const childIds = new Set<string>();
  for (const link of links) {
    if (!link.source_card_id || !link.target_card_id || !present.has(link.source_card_id) || !present.has(link.target_card_id)) continue;
    children.set(link.source_card_id, [...(children.get(link.source_card_id) ?? []), link.target_card_id]);
    childIds.add(link.target_card_id);
  }
  const byId = new Map(cards.map((card) => [card.id, card]));
  const base = [...cards].sort((a, b) => Number(isTitleCard(b)) - Number(isTitleCard(a)) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const result: Card[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const card = byId.get(id);
    if (card) result.push(card);
    for (const child of children.get(id) ?? []) visit(child);
  };
  // Heading-only cards are the mobile equivalent of labels on the canvas:
  // every one leads before relationship traversal begins.
  for (const card of base.filter(isTitleCard)) {
    seen.add(card.id);
    result.push(card);
  }
  for (const card of base.filter(isTitleCard)) {
    for (const child of children.get(card.id) ?? []) visit(child);
  }
  for (const card of base.filter((item) => !isTitleCard(item) && !childIds.has(item.id))) visit(card.id);
  for (const card of base) visit(card.id);
  return result;
}

function placementsIn(zone: Zone, zones: Zone[], placements: PlacementWithCard[]) {
  return placements.filter((placement) => {
    if (placement.parent_id || placement.card.type === "portal") return false;
    const centerX = placement.x + placement.w / 2;
    const centerY = placement.y + placement.h / 2;
    const containing = zones
      .filter((candidate) => centerX >= candidate.x && centerX <= candidate.x + candidate.w && centerY >= candidate.y && centerY <= candidate.y + candidate.h)
      .sort((a, b) => a.w * a.h - b.w * b.h || a.sort - b.sort);
    return containing[0]?.id === zone.id;
  });
}

function MobileContainer({ column, members }: { column: PlacementWithCard; members: PlacementWithCard[] }) {
  const [open, setOpen] = useState(false);
  const visible = members
    .filter((placement) => placement.card.type !== "portal")
    .sort((a, b) => a.sort - b.sort);
  return (
    <section className="mobile-container">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span><strong>{column.card.title || "Container"}</strong><small>{visible.length} {visible.length === 1 ? "card" : "cards"}</small></span>
        <b aria-hidden="true">{open ? "−" : "+"}</b>
      </button>
      {open && <div className="mobile-container-cards">{visible.length ? visible.map((placement) => <MobileCard card={placement.card} titleCard={isTitleCard(placement.card)} key={placement.id} />) : <p className="mobile-empty-copy">This container is empty.</p>}</div>}
    </section>
  );
}

export default function MobileBoard() {
  const { canvasId } = useParams<{ canvasId: string }>();
  const [detail, setDetail] = useState<CanvasDetail | null>(null);
  const [boards, setBoards] = useState<CanvasSummary[]>([]);
  const [inbox, setInbox] = useState<Card[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [openZones, setOpenZones] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!canvasId) return;
    void Promise.all([
      api.get<CanvasDetail>(`/api/canvases/${canvasId}`),
      api.get<CanvasSummary[]>("/api/canvases"),
      api.get<{ items: Card[] }>(`/api/inbox?canvas_id=${canvasId}&limit=100`),
    ]).then(([nextDetail, nextBoards, nextInbox]) => {
      setDetail(nextDetail);
      setBoards(nextBoards);
      setInbox(nextInbox.items);
    });
  }, [canvasId]);

  const zones = useMemo(() => detail ? [...detail.zones].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)) : [], [detail]);
  if (!canvasId || !detail) return <main className="mobile-page" />;

  return (
    <main className="mobile-page">
      <header className="mobile-header mobile-board-header">
        <Link to="/" aria-label="Back to create">‹</Link>
        <h1>{detail.name}</h1>
        {detail.role !== "viewer" && <button type="button" onClick={() => setComposerOpen((value) => !value)}>+ Card</button>}
      </header>

      {composerOpen && <MobileComposer boards={boards} initialBoardId={canvasId} onCreated={(card) => setInbox((current) => [card, ...current])} />}

      <section className="mobile-section">
        <button className="mobile-section-heading" type="button" onClick={() => setInboxOpen((value) => !value)}>
          <span>Board inbox</span><span>{inbox.length} {inboxOpen ? "−" : "+"}</span>
        </button>
        {inboxOpen && <div className="mobile-card-list">{inbox.length ? inbox.map((card) => <MobileCard card={card} key={card.id} />) : <p className="mobile-empty-copy">Nothing waiting for placement.</p>}</div>}
      </section>

      <section className="mobile-section mobile-zones">
        <div className="mobile-section-label">Zones</div>
        {zones.length === 0 && <div className="mobile-empty-panel"><strong>No zones yet</strong><p>Create a zone around cards on desktop and it will become readable here.</p></div>}
        {zones.map((zone) => {
          const open = openZones.has(zone.id);
          const contents = placementsIn(zone, zones, detail.placements);
          const columns = contents.filter((placement) => placement.card.type === "column");
          const cards = orderCards(contents.filter((placement) => placement.card.type !== "column"), detail.links);
          const containedCards = columns.reduce((total, column) => total + detail.placements.filter((placement) => placement.parent_id === column.id && placement.card.type !== "portal").length, 0);
          const cardCount = cards.length + containedCards;
          const summary = [
            cardCount ? `${cardCount} ${cardCount === 1 ? "card" : "cards"}` : "",
            columns.length ? `${columns.length} ${columns.length === 1 ? "container" : "containers"}` : "",
          ].filter(Boolean).join(" · ") || "Empty";
          const count = cards.length + columns.length;
          return <div className="mobile-zone" key={zone.id}>
            <button type="button" onClick={() => setOpenZones((current) => {
              const next = new Set(current);
              if (next.has(zone.id)) next.delete(zone.id); else next.add(zone.id);
              return next;
            })}>
              <span><strong>{zone.name}</strong><small>{summary}</small></span><b aria-hidden="true">{open ? "−" : "+"}</b>
            </button>
            {open && <div className="mobile-card-list">
              {cards.filter(isTitleCard).map((card) => <MobileCard card={card} titleCard key={card.id} />)}
              {columns.map((column) => <MobileContainer column={column} members={detail.placements.filter((placement) => placement.parent_id === column.id)} key={column.id} />)}
              {cards.filter((card) => !isTitleCard(card)).map((card) => <MobileCard card={card} key={card.id} />)}
              {count === 0 && <p className="mobile-empty-copy">This zone is empty.</p>}
            </div>}
          </div>;
        })}
      </section>
    </main>
  );
}
