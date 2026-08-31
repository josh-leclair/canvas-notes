import { useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { api } from "../api/client";
import type { CanvasSummary, Card, CardType } from "../api/types";
import { URL_PATTERN, YOUTUBE_PATTERN } from "../lib/urls";
import MobileDocumentToolbar from "./MobileDocumentToolbar";
import RichTextEditor from "./RichTextEditor";
import "./documentEditor.css";

type MobileType = "text" | "document" | "checklist" | "table" | "attachment";

const TYPES: { type: MobileType; label: string }[] = [
  { type: "text", label: "Note" },
  { type: "document", label: "Document" },
  { type: "checklist", label: "To-do" },
  { type: "table", label: "Table" },
  { type: "attachment", label: "File" },
];

const DRAFT_KEY = "mobile-card-draft";

interface MobileDraft {
  type?: MobileType;
  boardId?: string;
  title?: string;
  body?: string;
  tasks?: string[];
  rows?: string[][];
}

function loadDraft(): MobileDraft {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as MobileDraft;
  } catch {
    return {};
  }
}

function attachmentType(file: File): "image" | "audio" | "file" {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  return "file";
}

export default function MobileComposer({
  boards,
  initialBoardId = null,
  onCreated,
}: {
  boards: CanvasSummary[];
  initialBoardId?: string | null;
  onCreated?: (card: Card) => void;
}) {
  const draft = loadDraft();
  const [type, setType] = useState<MobileType>(() =>
    draft.type ?? (localStorage.getItem("mobile-card-type") as MobileType | null) ?? "text"
  );
  const [boardId, setBoardId] = useState(initialBoardId ?? draft.boardId ?? "");
  const [title, setTitle] = useState(draft.title ?? "");
  const [body, setBody] = useState(draft.body ?? "");
  const [tasks, setTasks] = useState(draft.tasks?.length ? draft.tasks : [""]);
  const [rows, setRows] = useState(draft.rows?.length ? draft.rows : [["", ""], ["", ""]]);
  const [file, setFile] = useState<File | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (initialBoardId !== null) setBoardId(initialBoardId);
  }, [initialBoardId]);

  useEffect(() => {
    localStorage.setItem("mobile-card-type", type);
  }, [type]);

  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ type, boardId, title, body, tasks, rows }));
  }, [boardId, body, rows, tasks, title, type]);

  const canSave = useMemo(() => {
    if (type === "attachment") return file !== null;
    if (type === "checklist") return Boolean(title.trim() || tasks.some((task) => task.trim()));
    if (type === "table") return Boolean(title.trim() || rows.flat().some((cell) => cell.trim()));
    return Boolean(title.trim() || body.trim());
  }, [body, file, rows, tasks, title, type]);

  function reset() {
    setTitle("");
    setBody("");
    setTasks([""]);
    setRows([["", ""], ["", ""]]);
    setFile(null);
  }

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    setMessage("");
    let cardType: CardType = type === "attachment" && file ? attachmentType(file) : type as CardType;
    let payload: Record<string, unknown> = {};
    let nextBody: string | null = body.trim() || null;

    if (type === "text" && body.trim().match(URL_PATTERN)?.[0] === body.trim()) {
      const url = body.trim();
      cardType = YOUTUBE_PATTERN.test(url) ? "youtube" : "link";
      payload = { url };
    } else if (type === "checklist") {
      payload = { items: tasks.filter((task) => task.trim()).map((text) => ({ text, done: false })) };
      nextBody = null;
    } else if (type === "table") {
      payload = { rows, header: true };
      nextBody = null;
    }

    try {
      const created = await api.post<{ card: Card }>("/api/cards", {
        type: cardType,
        title: title.trim() || (file?.name ?? null),
        body: nextBody,
        payload,
        inbox_canvas_id: boardId || null,
      });
      let card = created.card;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        const upload = await fetch(`/api/cards/${card.id}/${cardType}`, {
          method: "POST",
          credentials: "same-origin",
          body: form,
        });
        if (!upload.ok) {
          await api.delete(`/api/cards/${card.id}`);
          const data = await upload.json().catch(() => null);
          throw new Error(data?.error?.message ?? "Could not upload that file");
        }
        card = await upload.json() as Card;
      }
      setMessage(boardId ? "Saved to the board inbox." : "Saved to General inbox.");
      reset();
      onCreated?.(card);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create the card");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mobile-composer">
      <div className="mobile-type-strip" role="tablist" aria-label="Card type">
        {TYPES.map((item) => (
          <button
            key={item.type}
            type="button"
            className={type === item.type ? "is-active" : ""}
            onClick={() => setType(item.type)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {type !== "attachment" && (
        <input
          className="mobile-title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={type === "checklist" ? "List name" : type === "table" ? "Table name" : "Title (optional)"}
        />
      )}

      {type === "text" && (
        <textarea
          className="mobile-note-input"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Write a note or paste a link…"
          autoFocus
        />
      )}

      {type === "document" && (
        <div className="mobile-document-editor">
          <MobileDocumentToolbar editor={editor} />
          <RichTextEditor
            value={body}
            onChange={setBody}
            onReady={setEditor}
            placeholder="Start writing…"
          />
        </div>
      )}

      {type === "checklist" && (
        <div className="mobile-task-editor">
          {tasks.map((task, index) => (
            <div className="mobile-task-row" key={index}>
              <span aria-hidden="true">○</span>
              <input
                value={task}
                placeholder="What needs doing?"
                onChange={(event) => setTasks((current) => current.map((item, i) => i === index ? event.target.value : item))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && task.trim()) setTasks((current) => [...current, ""]);
                }}
              />
              {tasks.length > 1 && <button type="button" onClick={() => setTasks((current) => current.filter((_, i) => i !== index))}>×</button>}
            </div>
          ))}
          <button className="mobile-add-row" type="button" onClick={() => setTasks((current) => [...current, ""])}>+ Add task</button>
        </div>
      )}

      {type === "table" && (
        <div className="mobile-table-wrap">
          <table className="mobile-table-editor"><tbody>
            {rows.map((row, r) => <tr key={r}>{row.map((cell, c) => (
              <td key={c}><input value={cell} placeholder={r === 0 ? "Heading" : ""} onChange={(event) => setRows((current) => current.map((line, ri) => ri === r ? line.map((value, ci) => ci === c ? event.target.value : value) : line))} /></td>
            ))}</tr>)}
          </tbody></table>
          <div className="mobile-table-actions">
            <button type="button" onClick={() => setRows((current) => [...current, Array.from({ length: current[0]?.length ?? 2 }, () => "")])}>+ Row</button>
            <button type="button" onClick={() => setRows((current) => current.map((row) => [...row, ""]))}>+ Column</button>
          </div>
        </div>
      )}

      {type === "attachment" && (
        <label className="mobile-file-drop">
          <span>{file ? file.name : "Choose a photo, recording, or file"}</span>
          <input type="file" accept="image/*,audio/*,.pdf,.txt,.md,.doc,.docx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </label>
      )}

      <div className="mobile-compose-footer">
        <label>
          <span>Send to</span>
          <select value={boardId} onChange={(event) => setBoardId(event.target.value)}>
            <option value="">General inbox</option>
            {boards.filter((board) => board.role !== "viewer").map((board) => <option value={board.id} key={board.id}>{board.name} inbox</option>)}
          </select>
        </label>
        <button className="mobile-save" type="button" disabled={!canSave || saving} onClick={save}>{saving ? "Saving…" : "Create card"}</button>
      </div>
      {message && <p className="mobile-compose-message" role="status">{message}</p>}
    </section>
  );
}
