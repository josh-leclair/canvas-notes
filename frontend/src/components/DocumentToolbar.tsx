import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";

interface Tool {
  label: string;
  title: string;
  className?: string;
  is?: (e: Editor) => boolean;
  can?: (e: Editor) => boolean;
  run: (e: Editor) => void;
}

const TOOLS: Tool[] = [
  {
    label: "B",
    title: "Bold",
    className: "is-bold",
    is: (e) => e.isActive("bold"),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    label: "I",
    title: "Italic",
    className: "is-italic",
    is: (e) => e.isActive("italic"),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    label: "S",
    title: "Strikethrough",
    className: "is-strike",
    is: (e) => e.isActive("strike"),
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    label: "U",
    title: "Underline",
    className: "is-underline",
    is: (e) => e.isActive("underline"),
    run: (e) => e.chain().focus().toggleUnderline().run(),
  },
  {
    label: "•≡",
    title: "Bullet list",
    is: (e) => e.isActive("bulletList"),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: "1≡",
    title: "Numbered list",
    is: (e) => e.isActive("orderedList"),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    label: "≡›",
    title: "Indent",
    can: (e) => e.can().sinkListItem("listItem"),
    run: (e) => e.chain().focus().sinkListItem("listItem").run(),
  },
  {
    label: "‹≡",
    title: "Outdent",
    can: (e) => e.can().liftListItem("listItem"),
    run: (e) => e.chain().focus().liftListItem("listItem").run(),
  },
  {
    label: "—",
    title: "Divider",
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    label: "‹›",
    title: "Inline code",
    className: "is-code",
    is: (e) => e.isActive("code"),
    run: (e) => e.chain().focus().toggleCode().run(),
  },
];

function normaliseHref(value: string) {
  const href = value.trim();
  if (!href || href.startsWith("/") || href.startsWith("#")) return href;
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return href;
  return `https://${href}`;
}

/** The formatting rail.
 *
 * Every button sets a mark or a block on the selection. None of them inserts
 * a character of syntax, which is the difference between this and the note
 * editor's toolbar — a note is still written in markdown by hand, a document
 * is not.
 *
 * Indent and outdent grey out rather than disappear when there is nothing to
 * indent, so the rail keeps the same shape as the caret moves around.
 */
export default function DocumentToolbar({
  editor,
  onReference,
}: {
  editor: Editor | null;
  onReference?: () => void;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const linkInput = useRef<HTMLInputElement>(null);
  const linkSelection = useRef({ from: 0, to: 0 });
  const linkWasActive = useRef(false);

  useEffect(() => {
    if (linkOpen) linkInput.current?.focus();
  }, [linkOpen]);

  if (!editor) return null;

  function openLinkEditor() {
    linkSelection.current = {
      from: editor!.state.selection.from,
      to: editor!.state.selection.to,
    };
    linkWasActive.current = editor!.isActive("link");
    setHref(editor!.getAttributes("link").href ?? "");
    setLinkOpen(true);
  }

  function applyLink() {
    const nextHref = normaliseHref(href);
    if (!nextHref) return;

    const selection = linkSelection.current;
    const chain = editor!.chain().focus().setTextSelection(selection);

    if (linkWasActive.current) {
      chain.extendMarkRange("link").setLink({ href: nextHref }).run();
    } else if (selection.from !== selection.to) {
      chain.setLink({ href: nextHref }).run();
    } else {
      chain
        .command(({ tr, dispatch }) => {
          const link = editor!.schema.marks.link.create({ href: nextHref });
          dispatch?.(
            tr.replaceSelectionWith(editor!.schema.text(nextHref, [link]), false)
          );
          return true;
        })
        .run();
    }
    setLinkOpen(false);
  }

  function removeLink() {
    editor!
      .chain()
      .focus()
      .setTextSelection(linkSelection.current)
      .extendMarkRange("link")
      .unsetLink()
      .run();
    setLinkOpen(false);
  }

  return (
    <>
      <div className="doc-rail-tools">
        {TOOLS.map((tool) => {
          const usable = tool.can ? tool.can(editor) : true;
          return (
            <button
              key={tool.title}
              className={`doc-tool ${tool.className ?? ""} ${
                tool.is?.(editor) ? "is-active" : ""
              }`}
              title={tool.title}
              type="button"
              disabled={!usable}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => tool.run(editor)}
            >
              {tool.label}
            </button>
          );
        })}
        <button
          className={`doc-tool is-link ${editor.isActive("link") ? "is-active" : ""}`}
          title={editor.isActive("link") ? "Edit link" : "Add link"}
          type="button"
          aria-expanded={linkOpen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openLinkEditor}
        >
          ⚭
        </button>
        {onReference && (
          <button
            className="doc-tool is-reference"
            title="Reference a card ([[)"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onReference}
          >
            [[
          </button>
        )}
      </div>
      {linkOpen &&
        createPortal(
          <div
            className="doc-link-backdrop"
            onPointerDown={() => {
              setLinkOpen(false);
              editor.commands.focus();
            }}
          >
            <form
              className="doc-link-dialog"
              onPointerDown={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                applyLink();
              }}
            >
              <label htmlFor="doc-link-href">Link to</label>
              <input
                id="doc-link-href"
                ref={linkInput}
                type="text"
                inputMode="url"
                value={href}
                placeholder="https://example.com"
                onChange={(event) => setHref(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setLinkOpen(false);
                    editor.commands.focus();
                  }
                }}
              />
              <div className="doc-link-actions">
                {linkWasActive.current && (
                  <button type="button" className="is-remove" onClick={removeLink}>
                    Remove
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setLinkOpen(false);
                    editor.commands.focus();
                  }}
                >
                  Cancel
                </button>
                <button type="submit" disabled={!href.trim()}>
                  Apply
                </button>
              </div>
            </form>
          </div>,
          document.body
        )}
    </>
  );
}
