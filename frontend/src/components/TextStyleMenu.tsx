import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import Icon from "./Icon";
import "./textStyleMenu.css";

/** Text colours and highlights, drawn from the card palette so a document
 *  and the cards around it agree on what "blue" is. */
const INK = ["blue", "green", "orange", "red", "slate"] as const;
const MARKER = ["blue", "green", "yellow", "pink", "slate"] as const;

interface Block {
  label: string;
  hint: string;
  className?: string;
  is: (e: Editor) => boolean;
  run: (e: Editor) => void;
}

const BLOCKS: Block[] = [
  {
    label: "Large heading",
    hint: "Ctrl+Shift+1",
    className: "is-h1",
    is: (e) => e.isActive("heading", { level: 1 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    label: "Normal heading",
    hint: "Ctrl+Shift+2",
    className: "is-h2",
    is: (e) => e.isActive("heading", { level: 2 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: "Normal text",
    hint: "",
    is: (e) => e.isActive("paragraph") && !e.isActive("blockquote"),
    run: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    label: "Code block",
    hint: "Ctrl+>",
    className: "is-code",
    is: (e) => e.isActive("codeBlock"),
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    label: "Quote block",
    hint: "Ctrl+\"",
    className: "is-quote",
    is: (e) => e.isActive("blockquote"),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
];

/** The style menu, opened from the toolbar.
 *
 * Everything here sets a style on the selection. Nothing here types a
 * character into the document — that is the whole point of it existing.
 */
export default function TextStyleMenu({ editor }: { editor: Editor | null }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ left: 0, top: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function away(e: PointerEvent) {
      const target = e.target as Node;
      if (wrap.current?.contains(target) || panel.current?.contains(target))
        return;
      setOpen(false);
    }
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);

  if (!editor) return null;

  /* Drawn on the body rather than beside the button. The rail scrolls its own
   * tools, and an absolutely positioned panel inside a scrolling ancestor is
   * clipped by it — the menu was not behind the page, it was cut off at the
   * rail's edge. Same reason the column menu is portalled. */
  function toggle() {
    const button = wrap.current?.querySelector("button");
    if (button) {
      const r = button.getBoundingClientRect();
      setAt({ left: Math.round(r.right + 10), top: Math.round(r.top - 6) });
    }
    setOpen((o) => !o);
  }

  return (
    <div className="style-menu-wrap" ref={wrap}>
      <button
        className={`doc-tool is-style ${open ? "is-open" : ""}`}
        title="Text style"
        onClick={toggle}
      >
        <Icon name="textStyle" />
        <span className="doc-tool-label">Text style</span>
      </button>

      {open &&
        createPortal(
          <div className="style-menu" ref={panel} style={at}>
          {BLOCKS.map((block) => (
            <button
              key={block.label}
              className={`style-row ${block.className ?? ""} ${
                block.is(editor) ? "is-current" : ""
              }`}
              onClick={() => {
                block.run(editor);
                setOpen(false);
              }}
            >
              <span className="style-name">{block.label}</span>
              {block.is(editor) ? (
                <Icon name="check" />
              ) : (
                <span className="style-hint">{block.hint}</span>
              )}
            </button>
          ))}

          <div className="style-group">Colour</div>
          <div className="style-swatches">
            <button
              className={`style-ink ${
                !editor.getAttributes("textStyle").color ? "is-current" : ""
              }`}
              title="Default"
              onClick={() => editor.chain().focus().unsetColor().run()}
            >
              A
            </button>
            {INK.map((hue) => (
              <button
                key={hue}
                className="style-ink"
                style={{ color: `var(--hue-${hue})` }}
                title={hue[0].toUpperCase() + hue.slice(1)}
                onClick={() =>
                  editor
                    .chain()
                    .focus()
                    .setColor(
                      getComputedStyle(document.documentElement)
                        .getPropertyValue(`--hue-${hue}`)
                        .trim()
                    )
                    .run()
                }
              >
                A
              </button>
            ))}
          </div>

          <div className="style-group">Highlight</div>
          <div className="style-swatches">
            <button
              className="style-mark is-none"
              title="None"
              onClick={() => editor.chain().focus().unsetHighlight().run()}
            >
              A
            </button>
            {MARKER.map((hue) => (
              <button
                key={hue}
                className="style-mark"
                style={{
                  background: `var(--fill-${hue})`,
                  color: `var(--fill-ink-${hue})`,
                }}
                title={hue[0].toUpperCase() + hue.slice(1)}
                onClick={() =>
                  editor
                    .chain()
                    .focus()
                    .setHighlight({
                      color: getComputedStyle(document.documentElement)
                        .getPropertyValue(`--fill-${hue}`)
                        .trim(),
                    })
                    .run()
                }
              >
                A
              </button>
            ))}
          </div>
          </div>,
          document.body
        )}
    </div>
  );
}
