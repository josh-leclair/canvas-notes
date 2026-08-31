import { useNavigate } from "react-router-dom";
import { useCanvasStore } from "../store/canvasStore";
import Icon from "./Icon";
import "./focusShelf.css";

export default function FocusShelf() {
  const items = useCanvasStore((s) => s.focusShelf);
  const canvasId = useCanvasStore((s) => s.canvasId);
  const focusCards = useCanvasStore((s) => s.focusCards);
  const toggleFocus = useCanvasStore((s) => s.toggleFocus);
  const setInboxOpen = useCanvasStore((s) => s.setInboxOpen);
  const showToast = useCanvasStore((s) => s.showToast);
  const navigate = useNavigate();

  if (items.length === 0) return null;

  function open(item: (typeof items)[number]) {
    const here = item.placements.find((placement) => placement.canvas_id === canvasId);
    if (here) {
      focusCards([item.card.id]);
      return;
    }
    const home = item.placements[0];
    if (home) {
      navigate(`/c/${home.canvas_id}?card=${item.card.id}`);
      return;
    }
    setInboxOpen(true);
    showToast("That focus card is currently in your inbox.");
  }

  return (
    <aside className="focus-shelf" aria-label="Focus shelf">
      <span className="focus-shelf-label">Focus</span>
      <div className="focus-shelf-items">
        {items.map((item) => (
          <div className="focus-shelf-item" key={item.card.id}>
            <button
              className="focus-shelf-open"
              onClick={() => open(item)}
              title={item.card.body ?? item.card.title ?? "Untitled"}
            >
              {item.card.title ?? item.card.body?.slice(0, 42) ?? "Untitled"}
            </button>
            <button
              className="focus-shelf-remove"
              onClick={() => toggleFocus(item.card)}
              title="Remove from focus"
              aria-label={`Remove ${item.card.title ?? "card"} from focus`}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
