import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadConfig(initial = {}) {
  const values = { ...initial };
  const browser = {
    storage: {
      local: {
        async get(key) { return key in values ? { [key]: values[key] } : {}; },
        async set(next) { Object.assign(values, next); },
        async remove(key) { delete values[key]; },
      },
    },
  };
  const context = vm.createContext({ browser, URL, globalThis: null });
  context.globalThis = context;
  vm.runInContext(await readFile(new URL("../lib/config.js", import.meta.url), "utf8"), context);
  return { api: context.CanvasNotes, values };
}

test("normalizes a server URL without discarding a deployment path", async () => {
  const { api } = await loadConfig();
  assert.equal(api.normalizeServerUrl(" https://notes.example.com/canvas/ "), "https://notes.example.com/canvas");
  assert.equal(api.originPattern("https://notes.example.com/canvas"), "https://notes.example.com/*");
});

test("allows HTTP only for loopback development", async () => {
  const { api } = await loadConfig();
  assert.equal(api.normalizeServerUrl("http://localhost:8080/"), "http://localhost:8080");
  assert.throws(() => api.normalizeServerUrl("http://notes.example.com"), /HTTPS/);
  assert.throws(() => api.normalizeServerUrl("file:///tmp/notes"), /HTTPS/);
  assert.throws(() => api.normalizeServerUrl("https://user:pass@notes.example.com"), /username or password/);
});

test("validates, stores, loads, and clears a connection", async () => {
  const { api, values } = await loadConfig();
  await api.saveConnection({ serverUrl: "https://notes.example.com/", apiToken: "cnv_secret" });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await api.loadConnection())),
    { serverUrl: "https://notes.example.com", apiToken: "cnv_secret" }
  );
  assert.equal(values.canvasNotesConnection.apiToken, "cnv_secret");
  await api.clearConnection();
  assert.deepEqual(JSON.parse(JSON.stringify(await api.loadConnection())), { serverUrl: "", apiToken: "" });
});

test("rejects malformed Canvas Notes tokens", async () => {
  const { api } = await loadConfig();
  assert.throws(() => api.normalizeToken(""), /API token/);
  assert.throws(() => api.normalizeToken("secret"), /cnv_/);
});

test("automatic page titles are omitted unless the user edits them", async () => {
  const { api } = await loadConfig();
  assert.equal(api.titleOverride("YouTube", "YouTube"), undefined);
  assert.equal(api.titleOverride("", "Video title"), undefined);
  assert.equal(api.titleOverride("My research clip", "Video title"), "My research clip");
});

test("optional notes stay distinct from clipped content", async () => {
  const { api } = await loadConfig();
  assert.equal(api.combineClipText("", "Selected text"), "Selected text");
  assert.equal(api.combineClipText("Remember this", ""), "Remember this");
  assert.equal(
    api.combineClipText("Why it matters", "**Rich** selection"),
    "Why it matters\n\n---\n\n**Rich** selection"
  );
  assert.equal(api.combineClipText("", ""), undefined);
});
