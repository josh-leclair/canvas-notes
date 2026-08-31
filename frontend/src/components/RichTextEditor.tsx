import { useEffect } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import { Markdown } from "tiptap-markdown";

/** tiptap-markdown adds its storage at runtime but ships no type for it. */
type WithMarkdown = Editor & {
  storage: { markdown: { getMarkdown: () => string } };
};

const markdownOf = (editor: Editor) =>
  (editor as WithMarkdown).storage.markdown.getMarkdown();

/** A document, edited the way a word processor edits one.
 *
 * What is stored is still markdown. That is not a compromise for its own
 * sake — search_text is generated over the body, the embeddings read it, the
 * split reads it and export hands it to you — so the document has to stay
 * text that those things understand. What changed is that you no longer type
 * the markdown: the asterisks and hashes are the file format now, not the
 * writing surface.
 *
 * `html: true` on the markdown bridge is what lets the two things that
 * markdown has no syntax for — text colour and highlight — survive a round
 * trip, as inline spans inside an otherwise ordinary markdown file.
 */
export default function RichTextEditor({
  value,
  onChange,
  onReady,
  onReferenceTrigger,
  onOpenReference,
  placeholder,
  autoFocus = true,
}: {
  value: string;
  onChange: (markdown: string) => void;
  onReady?: (editor: Editor | null) => void;
  onReferenceTrigger?: (range: { from: number; to: number }) => void;
  onOpenReference?: (cardId: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Internal card references use a deliberately narrow custom scheme.
        // Without registering it here, Tiptap renders their href as empty and
        // the browser treats a click as a trip back to the current document.
        link: { openOnClick: false, protocols: ["card"] },
      }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Markdown.configure({
        html: true,
        transformPastedText: true,
        linkify: true,
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        class: "doc-rich",
        ...(placeholder ? { "data-placeholder": placeholder } : {}),
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChange(markdownOf(instance));
      const to = instance.state.selection.from;
      if (
        instance.state.selection.empty &&
        to >= 2 &&
        instance.state.doc.textBetween(to - 2, to, "") === "[["
      ) {
        onReferenceTrigger?.({ from: to - 2, to });
      }
    },
  });

  useEffect(() => {
    onReady?.(editor);
  }, [editor, onReady]);

  /* Only when the card changed underneath us — reloading on every keystroke
   * would fight the caret, since `value` is what this editor just produced. */
  useEffect(() => {
    if (!editor) return;
    if (markdownOf(editor) === value) return;
    editor.commands.setContent(value, { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, value]);

  useEffect(() => {
    if (editor && autoFocus) editor.commands.focus("end");
  }, [editor, autoFocus]);

  return (
    <EditorContent
      editor={editor}
      className="doc-rich-shell"
      onClickCapture={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>(
          'a[href^="card:"]'
        );
        if (!anchor) return;
        const match = /^card:([0-9a-f-]{36})$/i.exec(anchor.getAttribute("href") ?? "");
        if (!match) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenReference?.(match[1]);
      }}
    />
  );
}
