import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useReactFlow } from "@xyflow/react";
import { api } from "../api/client";
import { useCanvasStore } from "../store/canvasStore";
import type { CardPlacementInfo, LinkHit, SearchHit } from "../api/types";
import "./searchOverlay.css";

/** Search filters the canvas in place, reusing the reveal's dimming, and
 * lists what it found so you can go there. */
export default function SearchOverlay() {
  const open = useCanvasStore((s) => s.searchOpen);
  const setOpen = useCanvasStore((s) => s.setSearchOpen);
  const runSearch = useCanvasStore((s) => s.runSearch);
  const hits = useCanvasStore((s) => s.searchHits);
  const linkHits = useCanvasStore((s) => s.searchLinkHits);
  const canvasId = useCanvasStore((s) => s.canvasId);
  const setNodes = useCanvasStore((s) => s.setNodes);
  const setSelection = useCanvasStore((s) => s.setSelection);
  const setFocusLink = useCanvasStore((s) => s.setFocusLink);
  const setInboxOpen = useCanvasStore((s) => s.setInboxOpen);
  const showToast = useCanvasStore((s) => s.showToast);
  const { fitView } = useReactFlow();
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("auto");
  const [modes, setModes] = useState<string[]>(["text"]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number>();

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      api
        .get<{ modes: string[] }>("/api/search/status")
        .then((s) => setModes(s.modes))
        .catch(() => setModes(["text"]));
    }
  }, [open]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!open) return;
    timer.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const matches = await runSearch(query, mode);
        if (matches.length > 0) {
          fitView({ nodes: matches.map((id) => ({ id })), padding: 0.25, duration: 300 });
        }
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [query, mode, open, runSearch, fitView]);

  /** Land on a card that is already on this canvas.
   *
   * Search closes on the way: its dimming is the same machinery as the
   * reveal's and takes precedence over it, so staying open would mean
   * arriving at a card and being shown none of what it connects to. */
  const goHere = useCallback(
    (placementId: string) => {
      setOpen(false);
      setSelection([placementId]);
      setNodes((current) =>
        current.map((n) =>
          n.selected === (n.id === placementId)
            ? n
            : { ...n, selected: n.id === placementId }
        )
      );
      fitView({
        nodes: [{ id: placementId }],
        padding: 0.45,
        duration: 400,
        maxZoom: 1.2,
      });
    },
    [setOpen, setSelection, setNodes, fitView]
  );

  /** Land on a card, wherever it happens to live.
   *
   * `?card=` is the same trail a portal pill follows out to another canvas,
   * so arriving from a search result behaves exactly like arriving from a
   * link — selected, centred, and with its own reveal up. */
  const goToPlacements = useCallback(
    (cardId: string, placements: CardPlacementInfo[]) => {
      const here = placements.find((p) => p.canvas_id === canvasId);
      if (here) {
        goHere(here.id);
        return;
      }
      const elsewhere = placements[0];
      if (elsewhere) {
        setOpen(false);
        navigate(`/c/${elsewhere.canvas_id}?card=${cardId}`);
        return;
      }
      // On no canvas at all: the card exists but there is nowhere to go to
      // it. The inbox is where it is.
      setOpen(false);
      setInboxOpen(true);
      showToast("That one is still in your inbox");
    },
    [canvasId, goHere, navigate, setOpen, setInboxOpen, showToast]
  );

  const goToCard = useCallback(
    (hit: SearchHit) => goToPlacements(hit.card.id, hit.placements),
    [goToPlacements]
  );

  /** Open a link's details.
   *
   * The panel reads the link out of the current reveal, so getting there
   * means standing on one of its end cards first. Either end will do; the
   * source is the one the arrow leaves, so it is the more natural place to
   * be standing. A tombstoned end has no card to go to, hence the fallback. */
  const goToLink = useCallback(
    (hit: LinkHit) => {
      // The source is the end the arrow leaves, so it is the more natural
      // place to be standing. A tombstoned end has no card to stand on.
      const [endpoint, placements] = hit.source
        ? [hit.source, hit.source_placements]
        : [hit.target, hit.target_placements];
      if (!endpoint) {
        showToast("Both ends of that link are gone");
        return;
      }
      setFocusLink(hit.link.id);
      goToPlacements(endpoint.id, placements);
    },
    [goToPlacements, setFocusLink, showToast]
  );

  if (!open) return null;

  const here = hits.filter((h) => h.placements.some((p) => p.canvas_id === canvasId));
  const elsewhere = hits.filter(
    (h) => !h.placements.some((p) => p.canvas_id === canvasId)
  );

  const titleOf = (hit: SearchHit) =>
    hit.card.title ?? hit.card.body?.slice(0, 50) ?? "Untitled";

  return (
    <div className="search-overlay">
      <div className="search-bar">
        <input
          ref={inputRef}
          placeholder="Search titles, notes, transcripts, and why things are linked…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        />
        {modes.includes("semantic") && (
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="auto">Everything</option>
            <option value="text">Words only</option>
            <option value="semantic">Meaning only</option>
          </select>
        )}
        <button onClick={() => setOpen(false)}>✕</button>
      </div>

      {query.trim() !== "" && (
        <div className="search-results">
          <div className="search-summary">
            {searching
              ? "Searching…"
              : `${here.length} on this canvas · ${elsewhere.length} elsewhere` +
                (linkHits.length
                  ? ` · ${linkHits.length} link${linkHits.length === 1 ? "" : "s"}`
                  : "")}
          </div>

          {/* Cards on this canvas light up in place, but they are listed here
              too: the summary counts them, and a count with no rows under it
              reads as results that failed to arrive. */}
          {here.length > 0 && (
            <>
              <div className="search-group">On this canvas</div>
              {here.map((hit) => (
                <button
                  key={hit.card.id}
                  className="search-hit"
                  onClick={() => goToCard(hit)}
                >
                  <span className="search-hit-title">{titleOf(hit)}</span>
                  {/* The heading already said where these are, so the only
                      thing left worth saying is how it matched. */}
                  {hit.source === "semantic" && (
                    <span className="search-hit-where">similar meaning</span>
                  )}
                </button>
              ))}
            </>
          )}

          {elsewhere.length > 0 && (
            <>
              <div className="search-group">Elsewhere</div>
              {elsewhere.map((hit) => (
                <button
                  key={hit.card.id}
                  className="search-hit"
                  onClick={() => goToCard(hit)}
                >
                  <span className="search-hit-title">{titleOf(hit)}</span>
                  <span className="search-hit-where">
                    {hit.placements.length > 0
                      ? hit.placements.map((p) => p.canvas_name).join(", ")
                      : "Inbox"}
                    {hit.source === "semantic" && " · similar meaning"}
                  </span>
                </button>
              ))}
            </>
          )}

          {/* Links come out under their own heading. A note is not a card,
              and filing it under both of its ends would say the same thing
              twice without saying what it joins. */}
          {linkHits.length > 0 && (
            <>
              <div className="search-group">Why things are linked</div>
              {linkHits.map((hit) => (
                <button
                  key={hit.link.id}
                  className="search-hit is-link"
                  onClick={() => goToLink(hit)}
                >
                  <span className="search-hit-title">{hit.link.note}</span>
                  <span className="search-hit-where">
                    {hit.source?.title ?? "Untitled"}
                    <span className={`search-link-type t-${hit.link.link_type ?? "untyped"}`}>
                      {(hit.link.link_type ?? "linked").replace(/_/g, " ")}
                    </span>
                    {hit.target?.title ?? "Untitled"}
                  </span>
                </button>
              ))}
            </>
          )}
          {!searching && hits.length === 0 && linkHits.length === 0 && (
            <p className="search-empty">Nothing matched.</p>
          )}
        </div>
      )}
    </div>
  );
}
