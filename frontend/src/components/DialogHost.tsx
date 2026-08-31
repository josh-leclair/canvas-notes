import { useEffect, useRef, useState } from "react";
import { useDialogStore } from "../store/dialogStore";
import "./dialogHost.css";

/** Renders whichever dialog is currently open. Mounted once, at the root. */
export default function DialogHost() {
  const request = useDialogStore((s) => s.request);
  const close = useDialogStore((s) => s.close);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    if (request.kind === "prompt") {
      setDraft(request.initial ?? "");
      // Select the existing text so typing replaces it, like a rename should.
      requestAnimationFrame(() => inputRef.current?.select());
    } else {
      requestAnimationFrame(() => confirmRef.current?.focus());
    }
  }, [request]);

  useEffect(() => {
    if (!request) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      }
    }
    // Capture, so the canvas's own Escape handling does not run first.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [request, close]);

  if (!request) return null;

  const isPrompt = request.kind === "prompt";
  const canConfirm = !isPrompt || draft.trim().length > 0;

  function submit() {
    if (!canConfirm) return;
    close(isPrompt ? draft.trim() : true);
  }

  return (
    <div className="dialog-backdrop" onClick={() => close(false)}>
      <div
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">{request.title}</div>

        {!isPrompt && request.body && (
          <p className="dialog-body">{request.body}</p>
        )}

        {!isPrompt && request.details && request.details.length > 0 && (
          <ul className="dialog-details">
            {request.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}

        {isPrompt && (
          <label className="dialog-field">
            {request.label}
            <input
              ref={inputRef}
              value={draft}
              placeholder={request.placeholder}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
        )}

        <div className="dialog-actions">
          <button onClick={() => close(false)}>
            {(!isPrompt && request.cancelLabel) || "Cancel"}
          </button>
          <button
            ref={confirmRef}
            className={!isPrompt && request.danger ? "danger" : "primary"}
            disabled={!canConfirm}
            onClick={submit}
          >
            {request.confirmLabel ?? (isPrompt ? "Save" : "Confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
