import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("every local HTML resource exists", async () => {
  for (const page of ["popup/popup.html", "options/options.html", "privacy.html"]) {
    const html = await readFile(new URL(page, root), "utf8");
    const references = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
      .map((match) => match[1])
      .filter((value) => !/^(?:https?:|data:|mailto:)/.test(value));
    for (const reference of references) {
      await access(new URL(reference, new URL(page, root)));
    }
  }
});

test("runtime JavaScript contains no remote-code execution primitives", async () => {
  const files = [
    "background.js", "lib/api.js", "lib/config.js", "lib/extract-page.js",
    "options/options.js", "popup/popup.js",
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\b|import\s*\(\s*["']https?:/);
  }
});
