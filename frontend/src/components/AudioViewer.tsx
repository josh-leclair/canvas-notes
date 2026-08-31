import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Card } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import Icon from "./Icon";
import "./audioViewer.css";

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

/** Opening an audio card, which used to hand you a title field and a markdown
 *  textarea — the standard text editor, for a card whose content is a
 *  recording and a transcript the machine wrote. Neither field was the thing
 *  you came to look at.
 *
 *  What you came for is the audio and the whole transcript, so that is what
 *  this is: a player you can scrub, and the text in full rather than the few
 *  lines the card had room for.
 *
 *  It borrows the backdrop and sheet from the document editor. Those are the
 *  app's overlay shell rather than anything document-specific.
 */
export default function AudioViewer({
  card,
  onClose,
}: {
  card: Card;
  onClose: () => void;
}) {
  const showToast = useCanvasStore((s) => s.showToast);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);

  const fileId = card.payload.audio_file_id as string | undefined;
  const transcript = card.payload.transcript as string | undefined;
  const status = card.payload.transcript_status as string | undefined;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      // Space plays, the way every player works — unless the caret is
      // somewhere it would type a space instead.
      if (e.key === " " && !(e.target as HTMLElement)?.closest("input, textarea")) {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  function toggle() {
    const el = audio.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => showToast("Could not play that audio"));
    else el.pause();
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const el = audio.current;
    if (!el) return;
    el.currentTime = Number(e.target.value);
    setElapsed(el.currentTime);
  }

  return createPortal(
    <div className="doc-backdrop" onPointerDown={onClose}>
      <div
        className="doc-sheet is-audio"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="doc-head">
          <span className="audio-view-title">{card.title || "Audio"}</span>
          <div className="doc-actions">
            <button onClick={onClose} title="Close (Esc)">
              <Icon name="close" />
            </button>
          </div>
        </header>

        {fileId ? (
          <div className="audio-view-player">
            <button
              className="audio-view-play"
              onClick={toggle}
              title={playing ? "Pause" : "Play"}
            >
              <Icon name={playing ? "pause" : "play"} size={26} />
            </button>
            <input
              className="audio-view-seek"
              type="range"
              min={0}
              max={Number.isFinite(duration) && duration > 0 ? duration : 0}
              step={0.1}
              value={elapsed}
              onChange={seek}
            />
            <span className="audio-view-clock">
              {clock(elapsed)} / {clock(duration)}
            </span>
            <audio
              ref={audio}
              src={`/api/files/${fileId}`}
              preload="metadata"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                setPlaying(false);
                setElapsed(0);
              }}
              onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              onDurationChange={(e) => setDuration(e.currentTarget.duration)}
            />
          </div>
        ) : (
          <p className="audio-view-empty">
            This card has no recording on it yet.
          </p>
        )}

        <div className="audio-view-transcript">
          {transcript ? (
            transcript
              .split(/\n{2,}/)
              .map((para, i) => <p key={i}>{para}</p>)
          ) : status === "queued" || status === "running" ? (
            <p className="is-pending">Transcription is still running…</p>
          ) : status === "failed" ? (
            <p className="is-pending">Transcription failed for this recording.</p>
          ) : (
            <p className="is-pending">No transcript for this recording.</p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
