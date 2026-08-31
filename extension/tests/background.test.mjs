import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function harness() {
  const calls = [];
  let onMenu;
  const connection = { serverUrl: "https://notes.example.com", apiToken: "cnv_secret" };
  const CanvasNotes = {
    async loadConnection() { calls.push("load-connection"); return connection; },
    async capture(_connection, clip) { calls.push(["capture", clip]); return { id: "card" }; },
    async captureFile(_connection, blob, filename, title) {
      calls.push(["capture-file", blob.type, filename, title]);
      return { id: "image" };
    },
    originPattern() { return "https://notes.example.com/*"; },
  };
  const event = () => ({ addListener() {} });
  const browser = {
    action: {
      async setBadgeBackgroundColor() {}, async setBadgeText() {}, async setTitle() {},
    },
    commands: { onCommand: event() },
    contextMenus: {
      async removeAll() {}, create() {},
      onClicked: { addListener(listener) { onMenu = listener; } },
    },
    permissions: {
      async request(value) { calls.push(["permission", value.origins[0]]); return true; },
      async remove(value) { calls.push(["remove-permission", value.origins[0]]); return true; },
    },
    runtime: { onInstalled: event(), onStartup: event(), async openOptionsPage() {} },
    scripting: {
      async executeScript() {
        return [{ result: { selection: "**Chosen words** with [context](https://example.com/context)" } }];
      },
    },
    tabs: { async query() { return []; } },
  };
  const context = vm.createContext({
    browser, CanvasNotes, URL, setTimeout() {}, globalThis: null,
    canvasNotesExtractPage() {},
    fetch: async () => new Response(new Blob(["png"], { type: "image/png" }), { status: 200 }),
  });
  context.globalThis = context;
  vm.runInContext(await readFile(new URL("../background.js", import.meta.url), "utf8"), context);
  return { calls, onMenu };
}

test("selection context menu leaves the title for server metadata", async () => {
  const { calls, onMenu } = await harness();
  await onMenu(
    { menuItemId: "canvas-notes-selection", selectionText: "Chosen words", pageUrl: "https://example.com/article" },
    { id: 7, title: "Example" }
  );
  const captureCall = calls.find((call) => Array.isArray(call) && call[0] === "capture");
  assert.deepEqual(JSON.parse(JSON.stringify(captureCall)), [
    "capture",
    {
      text: "**Chosen words** with [context](https://example.com/context)",
      url: "https://example.com/article",
    },
  ]);
});

test("page context menu does not block the server's unfurled title", async () => {
  const { calls, onMenu } = await harness();
  await onMenu(
    { menuItemId: "canvas-notes-page", pageUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ" },
    { id: 9, title: "YouTube", url: "https://youtube.com/watch?v=dQw4w9WgXcQ" }
  );
  const captureCall = calls.find((call) => Array.isArray(call) && call[0] === "capture");
  assert.deepEqual(JSON.parse(JSON.stringify(captureCall)), [
    "capture",
    { url: "https://youtube.com/watch?v=dQw4w9WgXcQ" },
  ]);
});

test("image context menu requests and then drops exact image-origin access", async () => {
  const { calls, onMenu } = await harness();
  await onMenu(
    { menuItemId: "canvas-notes-image", srcUrl: "https://cdn.example.com/photo.png" },
    { id: 8, title: "Photo page" }
  );
  assert.deepEqual(calls[0], ["permission", "https://cdn.example.com/*"]);
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "capture-file"));
  assert.deepEqual(calls.at(-1), ["remove-permission", "https://cdn.example.com/*"]);
});
