import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import type { CanvasMember } from "../api/types";
import { confirmDialog } from "../store/dialogStore";
import "./shareDialog.css";

export default function ShareDialog({
  canvasId,
  canvasName,
  onClose,
}: {
  canvasId: string;
  canvasName: string;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<CanvasMember[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [error, setError] = useState("");

  async function refresh() {
    setMembers(await api.get<CanvasMember[]>(`/api/canvases/${canvasId}/members`));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.post(`/api/canvases/${canvasId}/members`, { email: email.trim(), role });
      setEmail("");
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not share");
    }
  }

  async function changeRole(member: CanvasMember, next: "viewer" | "editor") {
    await api.patch(`/api/canvases/${canvasId}/members/${member.user_id}`, {
      role: next,
    });
    refresh();
  }

  async function remove(member: CanvasMember) {
    const ok = await confirmDialog({
      title: `Remove ${member.display_name}?`,
      body: "They lose access to these cards immediately. Links involving cards they can no longer see will be hidden.",
      confirmLabel: "Remove access",
      danger: true,
    });
    if (!ok) return;
    await api.delete(`/api/canvases/${canvasId}/members/${member.user_id}`);
    refresh();
  }

  return (
    <div className="share-overlay" onClick={onClose}>
      <div className="share-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="share-header">
          <strong>Share “{canvasName}”</strong>
          <button onClick={onClose}>✕</button>
        </div>

        <form onSubmit={add} className="share-form">
          <input
            type="email"
            placeholder="Email of an existing account"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
          >
            <option value="viewer">Can view</option>
            <option value="editor">Can edit</option>
          </select>
          <button className="primary" type="submit">
            Share
          </button>
        </form>
        {error && <div className="share-error">{error}</div>}

        {members.length === 0 && (
          <p className="share-empty">
            Not shared with anyone. People need an account on this instance.
          </p>
        )}
        {members.map((member) => (
          <div key={member.user_id} className="share-member">
            <span className="share-member-name">
              {member.display_name}
              <span className="share-member-email">{member.email}</span>
            </span>
            <select
              value={member.role}
              onChange={(e) =>
                changeRole(member, e.target.value as "viewer" | "editor")
              }
            >
              <option value="viewer">Can view</option>
              <option value="editor">Can edit</option>
            </select>
            <button onClick={() => remove(member)}>Remove</button>
          </div>
        ))}

        <p className="share-note">
          Editors can add, move, and edit cards here. Only you can rename,
          delete, or reshare this canvas, and only a card's owner can delete it.
        </p>
      </div>
    </div>
  );
}
