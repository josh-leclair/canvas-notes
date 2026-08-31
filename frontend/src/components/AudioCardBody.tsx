import { useRef, useState } from "react";
import type { Card } from "../api/types";
import { useCanvasStore } from "../store/canvasStore";
import Icon from "./Icon";

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

/** Player, uploader, and recorder for audio cards, plus the transcript.
 *
 * The player is a single square button rather than the browser's own
 * controls: those are a wide strip that has to sit above the transcript, and
 * every pixel of them swallows a drag. Here only the button opts out of
 * dragging, so the rest of the card still moves when you pull on it. */
export default function AudioCardBody({ card }: { card: Card }) {
  const showToast = useCanvasStore((s) => s.showToast);
  const refreshCard = useCanvasStore((s) => s.refreshCardFromServer);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);

  function togglePlay(e: React.MouseEvent) {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => showToast("Could not play that audio"));
    else el.pause();
  }

  const fileId = card.payload.audio_file_id as string | undefined;
  const transcript = card.payload.transcript as string | undefined;
  const transcriptStatus = card.payload.transcript_status as string | undefined;

  async function upload(blob: Blob, mime: string) {
    const form = new FormData();
    form.append("file", new File([blob], "audio", { type: mime }));
    const resp = await fetch(`/api/cards/${card.id}/audio`, {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => null);
      showToast(data?.error?.message ?? "Upload failed");
      return;
    }
    await refreshCard(card.id, await resp.json());
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const mime = recorder.mimeType || "audio/webm";
        upload(new Blob(chunksRef.current, { type: mime }), mime.split(";")[0]);
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      showToast("Microphone access was refused");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  return (
    <div className="audio-card">
      {fileId ? (
        <div className="audio-row">
          <button
            className="audio-play nodrag"
            onClick={togglePlay}
            title={playing ? "Pause" : "Play"}
          >
            <Icon
              name={playing ? "pause" : "play"}
              size={24}
              className="audio-play-glyph"
            />
            <span className="audio-play-time">
              {clock(playing || elapsed > 0 ? elapsed : duration)}
            </span>
          </button>
          <audio
            ref={audioRef}
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
          {transcript ? (
            <div className="audio-transcript">{transcript}</div>
          ) : transcriptStatus === "queued" ? (
            <div className="audio-transcript pending">Transcription queued…</div>
          ) : null}
        </div>
      ) : (
        <div className="audio-actions nodrag">
          {recording ? (
            <button className="danger" onClick={stopRecording}>
              <Icon name="stop" /> Stop recording
            </button>
          ) : (
            <button onClick={startRecording}>
              <Icon name="record" /> Record
            </button>
          )}
          <label className="audio-upload">
            Upload
            <input
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload(file, file.type || "audio/mpeg");
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
