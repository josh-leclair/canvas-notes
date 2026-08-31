import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type {
  ApiToken,
  ApiTokenCreated,
  BotIdentity,
  PairingCode,
} from "../api/types";
import { useAuth } from "../auth";
import AiSettings from "../components/AiSettings";
import Logo from "../components/Logo";
import { confirmDialog } from "../store/dialogStore";
import { currentTheme, setTheme, THEMES } from "../theme";
import "./settings.css";

/** How much of your own library semantic search can see. `embeddable` is the
 *  number of cards there is anything to embed, which is what "rebuild" queues
 *  — a card with no text can never gain a vector, so counting it would leave
 *  this permanently short. */
interface Coverage {
  embedded: number;
  embeddable: number;
  cards: number;
}

export default function Settings() {
  const { user } = useAuth();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [identities, setIdentities] = useState<BotIdentity[]>([]);
  const [newName, setNewName] = useState("");
  const [freshToken, setFreshToken] = useState<ApiTokenCreated | null>(null);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [searchStatus, setSearchStatus] = useState<{
    modes: string[];
    embeddings_configured: boolean;
  } | null>(null);
  const [reindexed, setReindexed] = useState<number | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [theme, setTheme_] = useState(currentTheme);

  async function refresh() {
    const [t, i, s] = await Promise.all([
      api.get<ApiToken[]>("/api/tokens"),
      api.get<BotIdentity[]>("/api/bot-identities"),
      api.get<{ modes: string[]; embeddings_configured: boolean }>(
        "/api/search/status"
      ),
    ]);
    setTokens(t);
    setIdentities(i);
    setSearchStatus(s);
  }

  const loadCoverage = useCallback(async () => {
    try {
      setCoverage(await api.get<Coverage>("/api/search/coverage"));
    } catch {
      setCoverage(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    loadCoverage();
  }, [loadCoverage]);

  /* Embedding happens on the worker, so the number climbs for a while after
   * the button is pressed. Polling only until it stops moving: a figure that
   * sat at its pre-click value would read as the rebuild having done
   * nothing. */
  const pending = coverage !== null && coverage.embedded < coverage.embeddable;
  useEffect(() => {
    if (reindexed === null || !pending) return;
    const timer = window.setTimeout(loadCoverage, 3000);
    return () => window.clearTimeout(timer);
  }, [reindexed, pending, coverage, loadCoverage]);

  async function createToken(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const created = await api.post<ApiTokenCreated>("/api/tokens", {
      name: newName.trim(),
    });
    setFreshToken(created);
    setNewName("");
    refresh();
  }

  async function revoke(token: ApiToken) {
    const ok = await confirmDialog({
      title: `Revoke “${token.name}”?`,
      body: "Anything still using this token stops working immediately. Tokens cannot be restored.",
      confirmLabel: "Revoke token",
      danger: true,
    });
    if (!ok) return;
    await api.delete(`/api/tokens/${token.id}`);
    refresh();
  }

  async function makePairingCode() {
    setPairing(await api.post<PairingCode>("/api/pairing-codes"));
  }

  async function unpair(identity: BotIdentity) {
    await api.delete(`/api/bot-identities/${identity.id}`);
    refresh();
  }

  async function reindex() {
    const resp = await api.post<{ queued: number }>("/api/search/reindex");
    setReindexed(resp.queued);
    loadCoverage();
  }

  return (
    <div className="settings-page">
      <header>
        <Link to="/" className="settings-back" title="Back to canvases">
          <Logo size={20} />
        </Link>
        <h1>Settings</h1>
      </header>

      <section>
        <h2>API tokens</h2>
        <p className="settings-hint">
          For the iOS Shortcut and anything else posting to{" "}
          <code>/api/capture</code>. A token is shown once, at creation.
        </p>

        {freshToken && (
          <div className="token-reveal">
            <div>
              Copy this now — it will not be shown again.
              <code>{freshToken.token}</code>
            </div>
            <div className="token-reveal-actions">
              <button onClick={() => navigator.clipboard.writeText(freshToken.token)}>
                Copy
              </button>
              <button onClick={() => setFreshToken(null)}>Done</button>
            </div>
          </div>
        )}

        <form onSubmit={createToken} className="settings-row">
          <input
            placeholder="What is it for? e.g. iPhone shortcut"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button className="primary" type="submit">
            Create token
          </button>
        </form>

        {tokens.length === 0 && <p className="settings-empty">No tokens yet.</p>}
        {tokens.map((token) => (
          <div key={token.id} className="settings-item">
            <span className="settings-item-name">{token.name}</span>
            <span className="settings-meta">
              {token.last_used_at
                ? `last used ${new Date(token.last_used_at).toLocaleDateString()}`
                : "never used"}
            </span>
            <button onClick={() => revoke(token)}>Revoke</button>
          </div>
        ))}

        <details className="settings-details">
          <summary>How to set up the iOS Shortcut</summary>
          <p className="settings-hint">
            Two endpoints, because text and files cannot travel in the same
            request. One Shortcut can do both by branching on its input.
          </p>
          <ol>
            <li>
              Create a Shortcut that accepts <strong>Text, URLs and Images</strong>{" "}
              from the share sheet. The share sheet is only the handiest
              trigger — the same Shortcut works from the home screen, Back Tap
              or the Action button.
            </li>
            <li>
              Add an <strong>If</strong> action: if Shortcut Input{" "}
              <em>has any value</em> of type Text or URL, take the first branch,
              otherwise the second.
            </li>
            <li>
              <strong>Text and links.</strong> A{" "}
              <strong>Get Contents of URL</strong> action pointing at{" "}
              <code>{location.origin}/api/capture</code>, method POST, headers{" "}
              <code>Authorization: Bearer &lt;your token&gt;</code> and{" "}
              <code>Content-Type: application/json</code>. Request body (JSON):{" "}
              <code>text</code> = Shortcut Input, <code>url</code> = Shortcut
              Input if it is a URL.
            </li>
            <li>
              <strong>Photos, voice memos, anything else.</strong> A second{" "}
              <strong>Get Contents of URL</strong> pointing at{" "}
              <code>{location.origin}/api/capture/file</code>, method POST, with
              only the <code>Authorization</code> header — no{" "}
              <code>Content-Type</code>, Shortcuts sets it. Request body:{" "}
              <strong>Form</strong>, with one field named <code>file</code> of
              type File set to Shortcut Input, and optionally a text field
              named <code>title</code>.
            </li>
          </ol>
          <p>
            A picture becomes an image card, a voice memo becomes an audio card
            with transcription queued, and anything else becomes a file card.
            Everything lands in your inbox unplaced.
          </p>
        </details>
      </section>

      <section>
        <h2>Chat capture</h2>
        <p className="settings-hint">
          Generate a code and send it to the bot once. Messages from unpaired
          senders are ignored.
        </p>
        <div className="settings-row">
          <button className="primary" onClick={makePairingCode}>
            Generate pairing code
          </button>
          {pairing && (
            <span className="pairing-code">
              <code>{pairing.code}</code>
              <span className="settings-meta">
                expires {new Date(pairing.expires_at).toLocaleTimeString()}
              </span>
            </span>
          )}
        </div>

        {identities.length === 0 && (
          <p className="settings-empty">No chat accounts paired.</p>
        )}
        {identities.map((identity) => (
          <div key={identity.id} className="settings-item">
            <span className="settings-item-name">{identity.platform}</span>
            <span className="settings-meta">{identity.platform_user_id}</span>
            <button onClick={() => unpair(identity)}>Unpair</button>
          </div>
        ))}
      </section>

      <section>
        <h2>Appearance</h2>
        <p className="settings-hint">
          Applies to this browser. Everyone picks their own.
        </p>
        <div className="theme-picker">
          {THEMES.map((option) => (
            <button
              key={option.id}
              className={`theme-swatch ${theme === option.id ? "is-active" : ""}`}
              onClick={() => {
                setTheme(option.id);
                setTheme_(option.id);
              }}
            >
              <span className="swatch-chips">
                {option.swatch.map((colour) => (
                  <span key={colour} style={{ background: colour }} />
                ))}
              </span>
              <span className="swatch-text">
                <strong>{option.label}</strong>
                <span>{option.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>AI endpoints</h2>
        <AiSettings isAdmin={!!user?.is_admin} />
      </section>

      <section>
        <h2>Search</h2>
        {searchStatus?.embeddings_configured ? (
          <>
            <p className="settings-hint">
              Semantic search is available on this instance.
            </p>
            {/* Counted against the cards there is anything to embed, not
                against every card you own: an image with no title has no
                text to turn into a vector, and counting it would hold this
                below the total for ever. */}
            {coverage !== null && (
              <p className="settings-hint">
                <strong>
                  {coverage.embedded} of {coverage.embeddable}
                </strong>{" "}
                of your cards have embeddings
                {coverage.cards > coverage.embeddable &&
                  ` · ${coverage.cards - coverage.embeddable} more have no text to embed`}
                {/* Worth saying at 1 of 28 and not only at 0: a card without
                    a vector is invisible to search by meaning, however many
                    of its neighbours have one. */}
                {pending && (
                  <> — searching by meaning can only find the ones that do.</>
                )}
              </p>
            )}
            <div className="settings-row">
              <button onClick={reindex}>Rebuild embeddings for my cards</button>
              {reindexed !== null && (
                <span className="settings-meta">
                  {reindexed} cards queued
                  {pending && " · still working"}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="settings-hint">
            Full-text search is active. Semantic search, link suggestions, and
            inbox triage need an embedding endpoint — set{" "}
            <code>EMBEDDING_BASE_URL</code> and <code>EMBEDDING_MODEL</code> to
            enable them.
          </p>
        )}
      </section>
    </div>
  );
}
