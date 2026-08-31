(function (root) {
  "use strict";

  class CanvasNotesApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "CanvasNotesApiError";
      this.status = status;
    }
  }

  async function errorMessage(response) {
    try {
      const data = await response.json();
      return (
        data?.message ||
        data?.detail?.message ||
        data?.detail ||
        `Canvas Notes returned ${response.status}.`
      );
    } catch {
      return `Canvas Notes returned ${response.status}.`;
    }
  }

  async function request(connection, path, init) {
    const response = await fetch(`${connection.serverUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.apiToken}`,
        ...(init?.headers || {}),
      },
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) {
      throw new CanvasNotesApiError(await errorMessage(response), response.status);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function testConnection(connection) {
    return request(connection, "/api/me", { method: "GET" });
  }

  function capture(connection, clip) {
    const body = {};
    if (clip.text) body.text = clip.text;
    if (clip.url) body.url = clip.url;
    if (clip.title) body.title = clip.title;
    return request(connection, "/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function captureFile(connection, blob, filename, title) {
    const form = new FormData();
    form.append("file", blob, filename || "clipped-image");
    if (title) form.append("title", title);
    return request(connection, "/api/capture/file", {
      method: "POST",
      body: form,
    });
  }

  root.CanvasNotes = Object.assign(root.CanvasNotes || {}, {
    CanvasNotesApiError,
    testConnection,
    capture,
    captureFile,
  });
})(globalThis);
