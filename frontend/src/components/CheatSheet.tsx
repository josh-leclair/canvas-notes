import "./cheatSheet.css";

const GESTURES: [string, string][] = [
  ["Double-click a card", "Edit its title and body"],
  ["Type [[ while writing", "Search for and insert a stable reference to another card"],
  ["Tick a checkbox on a card", "Toggles it without opening the editor"],
  ["⋯ menu → swatches", "Paint the card; the colour follows it everywhere"],
  ["Drag a card", "Move it (position saves on drop)"],
  ["Shift + drag empty space", "Rubber-band select several cards"],
  ["Press and hold a card on touch", "Add it to or remove it from the current selection"],
  ["Space + drag, or drag empty space", "Pan the canvas"],
  ["Double-click empty space", "New card there"],
  ["Today portal", "Choose Today when creating a Portal to see cards changed today"],
  ["⋯ menu → Add to focus", "Keep that card on the cross-canvas focus shelf"],
  ["Click a focus shelf item", "Jump to the card, even when it lives on another canvas"],
  [
    "Paste with nothing focused",
    "New card at the cursor — a URL becomes a link card, an image becomes an image card",
  ],
  ["Drag a tool from the bar", "Drop it where you want it, rather than in the middle"],
  ["Drag Portal from the bar", "Create a live filtered view of a canvas or the workspace"],
  ["Click a card inside a portal", "Open the canonical card; the portal never makes a copy"],
  ["Drag a card out of a portal", "Place that same card on the current canvas"],
  ["Drop a card onto a canvas portal", "Place it on the canvas the portal watches"],
  ["Enter in a to-do", "Start the next item; Backspace on an empty one removes it"],
  ["Drag a table's right or bottom edge", "Add or remove columns and rows"],
  ["Double-click a document card", "Open it in a full writing surface"],
  ["Click a document source chip", "Close the document and reveal that card"],
  [
    "Refresh changed in a document",
    "Update untouched generated blocks while preserving blocks you edited",
  ],
  ["Ctrl or Cmd click cards", "Add each one to the selection"],
  [
    "Select two or more cards → Draft selected",
    "Ask the configured model to turn them and their relationships into a document",
  ],
  [
    "Resize with several selected",
    "They all take the new size; “Match size to this” in the ⋯ menu does the same without dragging",
  ],
  ["Drag from any card edge dot", "Draw a link to another card"],
  [
    "Drop a card so it overlaps another",
    "Link them, leaving the card where it was",
  ],
  ["Click the dot on a link", "Edit its type and reason, or delete it"],
  ["Double-click a board card", "Open the board nested inside this one"],
  ["Drag a card onto a column", "Add it to the stack where you drop it"],
  ["Drag a card out of a column", "It goes back to sitting loose on the canvas"],
  ["Click a portal chip", "Travel to that card's canvas; hover it to unlink"],
  ["Number pill on a card", "Make it a hub — its children fold to titles"],
  ["Select a hub", "Its children unfold while it stays selected"],
  ["Play badge on a video", "Watch it full size; the rest of the card drags"],
  ["Expand badge on an image", "View it full size"],
  ["Select one card", "Reveal its links, two hops out"],
  ["Click a ghost card", "Re-root the reveal there"],
  ["Delete / Backspace", "Remove selected cards from this canvas"],
  ["Ctrl/Cmd + Z", "Undo the last move, resize, or removal"],
  ["Ctrl/Cmd + F", "Search this instance"],
  ["?", "This list"],
];

export default function CheatSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="cheat-overlay" onClick={onClose}>
      <div className="cheat-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cheat-header">
          <strong>Gestures and shortcuts</strong>
          <button onClick={onClose}>✕</button>
        </div>
        <table>
          <tbody>
            {GESTURES.map(([gesture, meaning]) => (
              <tr key={gesture}>
                <td className="cheat-gesture">{gesture}</td>
                <td>{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
