(function (root) {
  "use strict";

  const STORE_KEY = "canvasNotesConnection";

  function normalizeServerUrl(value) {
    const input = String(value || "").trim();
    if (!input) throw new Error("Enter your Canvas Notes server URL.");

    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      throw new Error("Enter a complete URL, such as https://notes.example.com.");
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("The server URL must use HTTPS.");
    }
    if (parsed.username || parsed.password) {
      throw new Error("Do not put a username or password in the server URL.");
    }

    const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
      parsed.hostname.toLowerCase()
    );
    if (parsed.protocol === "http:" && !loopback) {
      throw new Error("Use HTTPS for remote servers. HTTP is allowed only on this device.");
    }

    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  }

  function normalizeToken(value) {
    const token = String(value || "").trim();
    if (!token) throw new Error("Enter an API token from Canvas Notes Settings.");
    if (!token.startsWith("cnv_")) {
      throw new Error("Canvas Notes API tokens begin with cnv_.");
    }
    return token;
  }

  function originPattern(value) {
    const parsed = new URL(normalizeServerUrl(value));
    return `${parsed.origin}/*`;
  }

  function titleOverride(entered, detected) {
    const clean = String(entered || "").trim();
    const automatic = String(detected || "").trim();
    return clean && clean !== automatic ? clean : undefined;
  }

  function combineClipText(note, content) {
    const cleanNote = String(note || "").trim();
    const cleanContent = String(content || "").trim();
    if (!cleanNote) return cleanContent || undefined;
    if (!cleanContent) return cleanNote;
    return `${cleanNote}\n\n---\n\n${cleanContent}`;
  }

  async function loadConnection() {
    const stored = await browser.storage.local.get(STORE_KEY);
    return stored[STORE_KEY] || { serverUrl: "", apiToken: "" };
  }

  async function saveConnection(connection) {
    const clean = {
      serverUrl: normalizeServerUrl(connection.serverUrl),
      apiToken: normalizeToken(connection.apiToken),
    };
    await browser.storage.local.set({ [STORE_KEY]: clean });
    return clean;
  }

  async function clearConnection() {
    await browser.storage.local.remove(STORE_KEY);
  }

  root.CanvasNotes = Object.assign(root.CanvasNotes || {}, {
    STORE_KEY,
    normalizeServerUrl,
    normalizeToken,
    originPattern,
    titleOverride,
    combineClipText,
    loadConnection,
    saveConnection,
    clearConnection,
  });
})(globalThis);
