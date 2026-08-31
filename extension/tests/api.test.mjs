import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadApi(fetchImpl) {
  const context = vm.createContext({
    fetch: fetchImpl,
    FormData,
    globalThis: null,
  });
  context.globalThis = context;
  vm.runInContext(await readFile(new URL("../lib/api.js", import.meta.url), "utf8"), context);
  return context.CanvasNotes;
}

const connection = { serverUrl: "https://notes.example.com", apiToken: "cnv_secret" };

test("capture posts the documented JSON shape with bearer authentication", async () => {
  let seen;
  const api = await loadApi(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: "card-1", type: "link" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  });
  const result = await api.capture(connection, { text: "Quote", url: "https://example.com", title: "Example" });
  assert.equal(result.id, "card-1");
  assert.equal(seen.url, "https://notes.example.com/api/capture");
  assert.equal(seen.init.headers.Authorization, "Bearer cnv_secret");
  assert.deepEqual(JSON.parse(seen.init.body), { text: "Quote", url: "https://example.com", title: "Example" });
  assert.equal(seen.init.credentials, "omit");
});

test("surfaces Canvas Notes API errors", async () => {
  const api = await loadApi(async () => new Response(
    JSON.stringify({ detail: { message: "Invalid API token" } }),
    { status: 401, headers: { "content-type": "application/json" } }
  ));
  await assert.rejects(() => api.testConnection(connection), (error) => {
    assert.equal(error.name, "CanvasNotesApiError");
    assert.equal(error.status, 401);
    assert.equal(error.message, "Invalid API token");
    return true;
  });
});

test("image capture uses multipart without overriding its content type", async () => {
  let seen;
  const api = await loadApi(async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: "image-1", type: "image" }), { status: 201 });
  });
  const result = await api.captureFile(connection, new Blob(["png"], { type: "image/png" }), "clip.png", "Clipped image");
  assert.equal(result.type, "image");
  assert.equal(seen.url, "https://notes.example.com/api/capture/file");
  assert.ok(seen.init.body instanceof FormData);
  assert.equal(seen.init.headers.Authorization, "Bearer cnv_secret");
  assert.equal(seen.init.headers["Content-Type"], undefined);
});
