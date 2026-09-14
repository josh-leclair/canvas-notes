import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({
  globalThis: null,
  location: {
    origin: "https://example.com",
    pathname: "/recipe",
    href: "https://example.com/recipe",
  },
});
context.globalThis = context;
vm.runInContext(await readFile(new URL("../lib/extract-page.js", import.meta.url), "utf8"), context);

const classify = (input) => context.canvasNotesExtractPage(input);

test("only actual video routes classify known video hosts as video pages", () => {
  assert.equal(classify({ mode: "video-url", host: "youtube.com", pathname: "/watch" }), true);
  assert.equal(classify({ mode: "video-url", host: "youtube.com", pathname: "/shorts/abc" }), true);
  assert.equal(classify({ mode: "video-url", host: "youtube.com", pathname: "/results" }), false);
  assert.equal(classify({ mode: "video-url", host: "vimeo.com", pathname: "/blog/post" }), false);
});

test("small and ad-like native videos do not classify the page as video", () => {
  assert.equal(classify({
    mode: "video-size", visible: true, adLike: false,
    width: 300, height: 169, viewportWidth: 1440, viewportHeight: 900, controls: true,
  }), false);
  assert.equal(classify({
    mode: "video-size", visible: true, adLike: true,
    width: 960, height: 540, viewportWidth: 1440, viewportHeight: 900, controls: true,
  }), false);
  assert.equal(classify({
    mode: "video-size", visible: true, adLike: false,
    width: 960, height: 540, viewportWidth: 1440, viewportHeight: 900, controls: true,
  }), true);
  assert.equal(classify({
    mode: "video-size", visible: true, adLike: false,
    width: 640, height: 360, viewportWidth: 1440, viewportHeight: 900, controls: false,
  }), false);
});

test("article structured data wins over incidental video metadata", () => {
  assert.equal(classify({
    mode: "video-decision",
    host: "news.example.com",
    pathname: "/story",
    openGraphType: "article",
    structuredAsArticle: true,
    hasVideoMetadata: true,
    prominentNativeVideo: false,
  }), false);
  assert.equal(classify({
    mode: "video-decision",
    host: "videos.example.com",
    pathname: "/feature",
    openGraphType: "video.other",
    structuredAsArticle: false,
    hasVideoMetadata: true,
    prominentNativeVideo: false,
  }), true);
});

test("recipe structured data becomes concise useful Markdown", () => {
  const result = classify({
    mode: "structured-details",
    items: [{
      "@type": "Recipe",
      url: "https://example.com/recipe",
      name: "Tomato soup",
      recipeYield: "4 bowls",
      recipeIngredient: ["6 tomatoes", "1 onion"],
      recipeInstructions: [{ "@type": "HowToStep", text: "Simmer until tender." }],
    }],
  });
  assert.equal(result.id, "jsonld-recipe");
  assert.match(result.markdown, /## Ingredients/);
  assert.match(result.markdown, /- 6 tomatoes/);
  assert.match(result.markdown, /1\. Simmer until tender\./);
});
