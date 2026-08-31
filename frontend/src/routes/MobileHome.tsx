import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { CanvasSummary, Card } from "../api/types";
import Logo from "../components/Logo";
import MobileCard from "../components/MobileCard";
import MobileComposer from "../components/MobileComposer";
import { cycleTheme } from "../theme";
import "./mobile.css";

export default function MobileHome() {
  const [boards, setBoards] = useState<CanvasSummary[]>([]);
  const [inbox, setInbox] = useState<Card[]>([]);
  const [inboxOpen, setInboxOpen] = useState(false);

  useEffect(() => {
    void Promise.all([
      api.get<CanvasSummary[]>("/api/canvases"),
      api.get<{ items: Card[] }>("/api/inbox?general=true&limit=100"),
    ]).then(([nextBoards, nextInbox]) => {
      setBoards(nextBoards);
      setInbox(nextInbox.items);
    });
  }, []);

  return (
    <main className="mobile-page">
      <header className="mobile-header">
        <h1><Logo size={24} /> Create</h1>
        <button type="button" onClick={() => cycleTheme()} aria-label="Switch theme">◐</button>
      </header>
      <MobileComposer boards={boards} onCreated={(card) => {
        if (!card.inbox_canvas_id) setInbox((current) => [card, ...current]);
      }} />

      <section className="mobile-section">
        <button className="mobile-section-heading" type="button" onClick={() => setInboxOpen((value) => !value)}>
          <span>General inbox</span><span>{inbox.length} {inboxOpen ? "−" : "+"}</span>
        </button>
        {inboxOpen && <div className="mobile-card-list">{inbox.length ? inbox.map((card) => <MobileCard card={card} key={card.id} />) : <p className="mobile-empty-copy">Nothing waiting here.</p>}</div>}
      </section>

      <section className="mobile-section">
        <div className="mobile-section-label">Boards</div>
        <div className="mobile-board-list">
          {boards.map((board) => <Link key={board.id} to={`/c/${board.id}`}><span>{board.name}</span><small>{board.card_count} cards</small><b aria-hidden="true">›</b></Link>)}
        </div>
      </section>
    </main>
  );
}
