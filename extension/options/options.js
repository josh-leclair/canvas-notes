(async function () {
  "use strict";

  const server = document.getElementById("server-url");
  const token = document.getElementById("api-token");
  const status = document.getElementById("status");
  const save = document.getElementById("save");
  const disconnect = document.getElementById("disconnect");
  const showToken = document.getElementById("show-token");
  let previousConnection = { serverUrl: "", apiToken: "" };

  function setStatus(message, kind) {
    status.className = `status ${kind || ""}`;
    status.textContent = message;
  }

  function busy(value) {
    save.disabled = value;
    disconnect.disabled = value;
  }

  showToken.addEventListener("click", () => {
    const showing = token.type === "text";
    token.type = showing ? "password" : "text";
    showToken.textContent = showing ? "Show" : "Hide";
  });

  document.getElementById("connection-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    busy(true);
    setStatus("Requesting access to your server…");
    try {
      const clean = {
        serverUrl: CanvasNotes.normalizeServerUrl(server.value),
        apiToken: CanvasNotes.normalizeToken(token.value),
      };
      const origin = CanvasNotes.originPattern(clean.serverUrl);
      const permitted = await browser.permissions.request({ origins: [origin] });
      if (!permitted) throw new Error("Firefox did not grant access to that server.");

      setStatus("Testing connection…");
      const user = await CanvasNotes.testConnection(clean);
      await CanvasNotes.saveConnection(clean);
      if (previousConnection.serverUrl && previousConnection.serverUrl !== clean.serverUrl) {
        const oldOrigin = CanvasNotes.originPattern(previousConnection.serverUrl);
        if (oldOrigin !== origin) await browser.permissions.remove({ origins: [oldOrigin] });
      }
      previousConnection = clean;
      setStatus(`Connected as ${user.display_name || user.email}. Clips will go to your inbox.`, "success");
    } catch (error) {
      setStatus(error?.message || "Could not connect to Canvas Notes.", "error");
    } finally {
      busy(false);
    }
  });

  disconnect.addEventListener("click", async () => {
    busy(true);
    const previous = await CanvasNotes.loadConnection();
    await CanvasNotes.clearConnection();
    if (previous.serverUrl) {
      await browser.permissions.remove({ origins: [CanvasNotes.originPattern(previous.serverUrl)] });
    }
    previousConnection = { serverUrl: "", apiToken: "" };
    server.value = "";
    token.value = "";
    setStatus("Connection removed from this browser.", "success");
    busy(false);
  });

  const connection = await CanvasNotes.loadConnection();
  previousConnection = connection;
  server.value = connection.serverUrl || "";
  token.value = connection.apiToken || "";
  if (connection.serverUrl) setStatus("Connection settings loaded from this browser.");
})();
