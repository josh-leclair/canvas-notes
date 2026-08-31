import type { RefObject } from "react";
import "./editorToolbar.css";

interface Action {
  label: string;
  title: string;
  /** Wraps the selection, e.g. ** for bold. */
  wrap?: string;
  /** Goes at the start of every selected line, e.g. "- ". */
  prefix?: string;
  /** Dropped in whole, for things with no useful selection behaviour. */
  block?: string;
}

const ACTIONS: Action[] = [
  { label: "B", title: "Bold", wrap: "**" },
  { label: "I", title: "Italic", wrap: "*" },
  { label: "S", title: "Strikethrough", wrap: "~~" },
  { label: "H", title: "Heading", prefix: "## " },
  { label: "•", title: "Bullet list", prefix: "- " },
  { label: "1.", title: "Numbered list", prefix: "1. " },
  { label: "☑", title: "Checklist", prefix: "- [ ] " },
  { label: "❝", title: "Quote", prefix: "> " },
  { label: "‹›", title: "Code", wrap: "`" },
  {
    label: "▦",
    title: "Table",
    block: "\n| Item | Notes |\n| --- | --- |\n|  |  |\n|  |  |\n",
  },
  { label: "—", title: "Divider", block: "\n---\n" },
];

/** Formatting for the card editor.
 *
 * The body is markdown either way; this exists so the useful parts are
 * discoverable without knowing the syntax. */
export default function EditorToolbar({
  textarea,
  value,
  onChange,
  onReference,
}: {
  textarea: RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (next: string) => void;
  onReference?: () => void;
}) {
  function apply(action: Action) {
    const el = textarea.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end);

    let next = value;
    let caret = end;

    if (action.wrap) {
      const w = action.wrap;
      next = value.slice(0, start) + w + selected + w + value.slice(end);
      caret = end + w.length * 2;
    } else if (action.prefix) {
      // Prefix every line the selection touches, so it works on one line or
      // on a whole block.
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = value.indexOf("\n", end);
      const stop = lineEnd === -1 ? value.length : lineEnd;
      const block = value.slice(lineStart, stop);
      const prefixed = block
        .split("\n")
        .map((line) => (line.startsWith(action.prefix!) ? line : action.prefix + line))
        .join("\n");
      next = value.slice(0, lineStart) + prefixed + value.slice(stop);
      caret = lineStart + prefixed.length;
    } else if (action.block) {
      next = value.slice(0, end) + action.block + value.slice(end);
      caret = end + action.block.length;
    }

    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="editor-toolbar nodrag">
      {ACTIONS.map((action) => (
        <button
          key={action.title}
          type="button"
          title={action.title}
          // Keep focus in the textarea so the selection survives the click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => apply(action)}
        >
          {action.label}
        </button>
      ))}
      {onReference && (
        <button
          type="button"
          title="Reference a card ([[)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onReference}
        >
          [[
        </button>
      )}
    </div>
  );
}
