import type { Editor } from "@tiptap/react";

const TOOLS = [
  { label: "B", title: "Bold", active: "bold", run: (editor: Editor) => editor.chain().focus().toggleBold().run() },
  { label: "I", title: "Italic", active: "italic", run: (editor: Editor) => editor.chain().focus().toggleItalic().run() },
  { label: "•", title: "Bulleted list", active: "bulletList", run: (editor: Editor) => editor.chain().focus().toggleBulletList().run() },
  { label: "1.", title: "Numbered list", active: "orderedList", run: (editor: Editor) => editor.chain().focus().toggleOrderedList().run() },
];

function textStyle(editor: Editor): "large" | "heading" | "text" {
  if (editor.isActive("heading", { level: 1 })) return "large";
  if (editor.isActive("heading", { level: 2 })) return "heading";
  return "text";
}

function applyTextStyle(editor: Editor, style: string) {
  if (style === "large") editor.chain().focus().setHeading({ level: 1 }).run();
  else if (style === "heading") editor.chain().focus().setHeading({ level: 2 }).run();
  else editor.chain().focus().setParagraph().run();
}

export default function MobileDocumentToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return <div className="mobile-document-tools" aria-hidden="true" />;
  return (
    <div className="mobile-document-tools" aria-label="Document formatting">
      <select
        value={textStyle(editor)}
        aria-label="Text style"
        title="Text style"
        onChange={(event) => applyTextStyle(editor, event.target.value)}
      >
        <option value="large">Large heading</option>
        <option value="heading">Heading</option>
        <option value="text">Normal text</option>
      </select>
      {TOOLS.map((tool) => (
        <button
          key={tool.title}
          type="button"
          title={tool.title}
          aria-label={tool.title}
          className={editor.isActive(tool.active) ? "is-active" : ""}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => tool.run(editor)}
        >
          {tool.label}
        </button>
      ))}
    </div>
  );
}
