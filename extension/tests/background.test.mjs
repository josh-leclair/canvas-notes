import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function harness() {
  const calls = [];
  let onMenu;
  let onMessage;
  const regionSelector = function canvasNotesSelectRegion() {};
  const connection = { serverUrl: "https://notes.example.com", apiToken: "cnv_secret" };
  const CanvasNotes = {
    async loadConnection() { calls.push("load-connection"); return connection; },
    async capture(_connection, clip) { calls.push(["capture", clip]); return { id: "card" }; },
    async captureFile(_connection, blob, filename, title, text) {
      calls.push(["capture-file", blob.type, filename, title, text]);
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
    runtime: {
      onInstalled: event(), onStartup: event(), async openOptionsPage() {},
      onMessage: { addListener(listener) { onMessage = listener; } },
    },
    scripting: {
      async executeScript(details) {
        if (details.func === regionSelector) {
          calls.push("select-region");
          return [{ result: {
            x: 100, y: 50, width: 400, height: 200,
            viewportWidth: 1000, viewportHeight: 500,
          } }];
        }
        return [{ result: { selection: "**Chosen words** with [context](https://example.com/context)" } }];
      },
    },
    tabs: {
      async query() { return [{ id: 12, windowId: 4, title: "Message page" }]; },
      async captureVisibleTab(windowId, options) {
        calls.push(["capture-visible-tab", windowId, options.format]);
        return "data:image/png;base64,cG5n";
      },
    },
  };
  const context = vm.createContext({
    browser, CanvasNotes, URL, setTimeout(callback) { callback(); }, globalThis: null,
    canvasNotesExtractPage() {},
    canvasNotesSelectRegion: regionSelector,
    async createImageBitmap() {
      return { width: 2000, height: 1000, close() { calls.push("bitmap-closed"); } };
    },
    OffscreenCanvas: class {
      constructor(width, height) {
        calls.push(["crop-canvas", width, height]);
      }
      getContext() {
        return { drawImage(...args) { calls.push(["draw-image", ...args.slice(1)]); } };
      }
      async convertToBlob() { return new Blob(["cropped"], { type: "image/png" }); }
    },
    fetch: async () => new Response(new Blob(["png"], { type: "image/png" }), { status: 200 }),
  });
  context.globalThis = context;
  vm.runInContext(await readFile(new URL("../background.js", import.meta.url), "utf8"), context);
  return { calls, onMenu, onMessage };
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

test("screenshot context menu captures the visible tab as an image card", async () => {
  const { calls, onMenu } = await harness();
  await onMenu(
    { menuItemId: "canvas-notes-screenshot", pageUrl: "https://example.com/article" },
    { id: 10, windowId: 4, title: "Example article" }
  );
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "capture-visible-tab"));
  const upload = calls.find((call) => Array.isArray(call) && call[0] === "capture-file");
  assert.equal(upload[1], "image/png");
  assert.match(upload[2], /^screenshot-.*\.png$/);
  assert.equal(upload[3], "Screenshot of Example article");
  assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === "permission"));
});

test("selected-area screenshot crops at the captured image scale", async () => {
  const { calls, onMenu } = await harness();
  await onMenu(
    { menuItemId: "canvas-notes-screenshot-area", pageUrl: "https://example.com/article" },
    { id: 11, windowId: 4, title: "Example article" }
  );
  assert.ok(calls.includes("select-region"));
  assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === "crop-canvas"), [
    "crop-canvas", 800, 400,
  ]);
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "capture-file"));
});

test("popup delegates selected screenshot capture with its title and note", async () => {
  const { calls, onMessage } = await harness();
  const result = await onMessage({
    type: "capture-screenshot-area",
    title: "Important detail",
    text: "Compare this later",
  });
  assert.equal(result.saved, true);
  const upload = calls.find((call) => Array.isArray(call) && call[0] === "capture-file");
  assert.equal(upload[3], "Important detail");
  assert.equal(upload[4], "Compare this later");
});
