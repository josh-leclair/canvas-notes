/* This function is deliberately self-contained. Firefox serializes it into the
 * active tab with scripting.executeScript, so it cannot close over helpers. */
function canvasNotesExtractPage(testInput) {
  "use strict";

  const MAX_ARTICLE_CHARS = 100000;
  const ignored = [
    "script", "style", "noscript", "template", "canvas", "form", "button",
    "input", "select", "textarea", "nav", "aside", "footer", "iframe",
    "[role='navigation']", "[role='complementary']", "[role='dialog']",
    "[role='banner']", "[role='contentinfo']", "[aria-modal='true']",
    "[aria-hidden='true']", "[hidden]", "[inert]",
    "[style*='display:none']", "[style*='display: none']",
    "[style*='visibility:hidden']", "[style*='visibility: hidden']",
    ".advertisement", ".advertising", ".ad-container", ".ad-wrapper",
    ".cookie", ".cookies", ".newsletter", ".social-share", ".share-tools",
    ".related-posts", ".recommended", ".recommendations", ".comments",
    "[class*='paywall']", "[id*='paywall']", "[class*='popup']",
    "[class*='modal']", "[class*='consent']", "[id*='consent']",
  ].join(",");
  const negativeName = /(?:^|[-_\s])(ad|ads|advert|banner|cookie|consent|footer|header|menu|nav|newsletter|promo|related|share|sidebar|sponsor|subscribe|widget)(?:$|[-_\s])/i;
  const positiveName = /(?:article|body|content|entry|main|post|prose|story|text)/i;

  if (testInput?.mode === "video-url") {
    return isKnownVideoUrl(testInput.host, testInput.pathname);
  }
  if (testInput?.mode === "video-size") {
    return videoDimensionsAreProminent(testInput);
  }
  if (testInput?.mode === "video-decision") {
    return videoDecision(testInput);
  }
  if (testInput?.mode === "structured-details") {
    return structuredDetails(testInput.items || []);
  }

  function meta(name) {
    const escaped = CSS.escape(name);
    return (
      document.querySelector(`meta[property="${escaped}"]`)?.content ||
      document.querySelector(`meta[name="${escaped}"]`)?.content ||
      ""
    ).trim();
  }

  function metas(name) {
    const escaped = CSS.escape(name);
    return Array.from(document.querySelectorAll(`meta[name="${escaped}"]`))
      .map((node) => (node.content || "").trim())
      .filter(Boolean);
  }

  function absoluteUrl(value) {
    try {
      const parsed = new URL(value, location.href);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function markdownText(value) {
    return String(value || "").replace(/([\\`*_[\]<>])/g, "\\$1");
  }

  function inline(node) {
    if (node.nodeType === Node.TEXT_NODE) return markdownText(node.nodeValue || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    const content = Array.from(node.childNodes).map(inline).join("");
    if (tag === "br") return "\n";
    if (tag === "strong" || tag === "b") return content.trim() ? `**${content.trim()}**` : "";
    if (tag === "em" || tag === "i") return content.trim() ? `*${content.trim()}*` : "";
    if (tag === "code") {
      const code = (node.textContent || "").trim();
      if (!code) return "";
      const fence = code.includes("`") ? "``" : "`";
      return `${fence}${code}${fence}`;
    }
    if (tag === "a") {
      const href = absoluteUrl(node.getAttribute("href") || "");
      const label = content.trim();
      return href && label ? `[${label}](${href})` : label;
    }
    if (tag === "img") {
      const src = absoluteUrl(node.currentSrc || node.getAttribute("src") || node.getAttribute("data-src") || "");
      const alt = markdownText((node.getAttribute("alt") || "").trim());
      return src ? `![${alt}](${src})` : "";
    }
    return content;
  }

  function tableBlock(node) {
    const rows = Array.from(node.querySelectorAll("tr")).map((row) =>
      Array.from(row.querySelectorAll(":scope > th, :scope > td")).map((cell) =>
        inline(cell).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()
      )
    ).filter((row) => row.length);
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const padded = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] || ""));
    const lines = [
      `| ${padded[0].join(" | ")} |`,
      `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
      ...padded.slice(1).map((row) => `| ${row.join(" | ")} |`),
    ];
    return `\n\n${lines.join("\n")}\n\n`;
  }

  function listBlock(node, depth) {
    const ordered = node.tagName.toLowerCase() === "ol";
    const start = Number(node.getAttribute("start")) || 1;
    const items = Array.from(node.children).filter((child) => child.tagName.toLowerCase() === "li");
    return items.map((item, index) => {
      const primary = Array.from(item.childNodes)
        .filter((child) => child.nodeType !== Node.ELEMENT_NODE || !["ul", "ol"].includes(child.tagName.toLowerCase()))
        .map((child) => block(child, depth + 1))
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      const nested = Array.from(item.children)
        .filter((child) => ["ul", "ol"].includes(child.tagName.toLowerCase()))
        .map((child) => listBlock(child, depth + 1).trim().split("\n").map((line) => `  ${line}`).join("\n"))
        .join("\n");
      const marker = ordered ? `${start + index}.` : "-";
      return `${marker} ${primary}${nested ? `\n${nested}` : ""}`;
    }).join("\n");
  }

  function block(node, depth) {
    if (node.nodeType === Node.TEXT_NODE) return markdownText(node.nodeValue || "");
    if (node.nodeType !== Node.ELEMENT_NODE || depth > 50) return "";
    const tag = node.tagName.toLowerCase();
    if (["a", "strong", "b", "em", "i", "code", "img", "br"].includes(tag)) return inline(node);
    if (tag === "pre") {
      const value = (node.textContent || "").trim();
      if (!value) return "";
      const fence = value.includes("```") ? "~~~~" : "```";
      return `\n\n${fence}\n${value}\n${fence}\n\n`;
    }
    if (/^h[1-6]$/.test(tag)) {
      const value = inline(node).trim();
      return value ? `\n\n${"#".repeat(Number(tag[1]))} ${value}\n\n` : "";
    }
    if (tag === "blockquote") {
      const value = Array.from(node.childNodes).map((child) => block(child, depth + 1)).join("").trim();
      return value ? `\n\n${value.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : "";
    }
    if (tag === "table") return tableBlock(node);
    if (tag === "ul" || tag === "ol") {
      const value = listBlock(node, depth + 1);
      return value ? `\n\n${value}\n\n` : "";
    }
    if (tag === "dt") {
      const value = inline(node).trim();
      return value ? `\n\n**${value}**\n` : "";
    }
    if (tag === "dd") {
      const value = Array.from(node.childNodes).map((child) => block(child, depth + 1)).join("").trim();
      return value ? `${value}\n\n` : "";
    }
    if (tag === "hr") return "\n\n---\n\n";
    if (["p", "div", "section", "article", "main", "header", "figure", "figcaption", "details", "summary", "dl"].includes(tag)) {
      const content = Array.from(node.childNodes).map((child) => block(child, depth + 1)).join("").trim();
      return content ? `\n\n${content}\n\n` : "";
    }
    return Array.from(node.childNodes).map((child) => block(child, depth + 1)).join("");
  }

  function cleanMarkdown(value) {
    return String(value || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, MAX_ARTICLE_CHARS);
  }

  function selectedMarkdown() {
    const selected = getSelection();
    if (!selected || selected.rangeCount === 0 || selected.isCollapsed) return "";
    const container = document.createElement("div");
    for (let index = 0; index < selected.rangeCount; index += 1) {
      container.appendChild(selected.getRangeAt(index).cloneContents());
      if (index < selected.rangeCount - 1) container.appendChild(document.createElement("p"));
    }
    container.querySelectorAll(ignored).forEach((node) => node.remove());
    return cleanMarkdown(block(container, 0)) || (selected.toString() || "").trim().slice(0, MAX_ARTICLE_CHARS);
  }

  function jsonLdItems() {
    const found = [];
    function visit(value) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") {
        found.push(value);
        if (value["@graph"]) visit(value["@graph"]);
        if (value.mainEntity) visit(value.mainEntity);
      }
    }
    document.querySelectorAll("script[type='application/ld+json']").forEach((node) => {
      try { visit(JSON.parse(node.textContent || "null")); } catch { /* Ignore malformed publisher data. */ }
    });
    return found;
  }

  function hasType(item, expected) {
    const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
    return types.some((type) => String(type || "").toLowerCase() === expected.toLowerCase());
  }

  function structuredDetails(items) {
    const pagePath = `${location.origin}${location.pathname}`.replace(/\/$/, "");
    function matchesPage(item) {
      const main = typeof item.mainEntityOfPage === "string"
        ? item.mainEntityOfPage
        : item.mainEntityOfPage?.["@id"] || item.mainEntityOfPage?.url;
      return [item.url, item["@id"], main].filter(Boolean).some((value) => {
        try {
          const parsed = new URL(value, location.href);
          return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "") === pagePath;
        } catch { return false; }
      });
    }
    function primaryOfType(type) {
      const candidates = items.filter((item) => hasType(item, type));
      return candidates.find(matchesPage) || candidates.find((item) => item.mainEntityOfPage) || candidates[0];
    }
    const pageHasArticle = items.some((item) =>
      ["Article", "NewsArticle", "BlogPosting", "ScholarlyArticle"].some((type) => hasType(item, type))
    );

    const recipeCandidate = primaryOfType("Recipe");
    const recipe = pageHasArticle && recipeCandidate && !matchesPage(recipeCandidate) ? null : recipeCandidate;
    if (recipe) {
      const lines = [`# ${markdownText(recipe.name || document.title || "Recipe")}`];
      const facts = [
        ["Yield", recipe.recipeYield], ["Prep time", recipe.prepTime],
        ["Cook time", recipe.cookTime], ["Total time", recipe.totalTime],
      ].filter(([, value]) => value);
      if (facts.length) lines.push(facts.map(([label, value]) => `- **${label}:** ${markdownText(value)}`).join("\n"));
      if (recipe.description) lines.push(markdownText(recipe.description));
      const ingredients = Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : [];
      if (ingredients.length) lines.push(`## Ingredients\n\n${ingredients.map((value) => `- ${markdownText(value)}`).join("\n")}`);
      function instructionLines(value) {
        if (Array.isArray(value)) return value.flatMap(instructionLines);
        if (typeof value === "string") return [value];
        if (!value || typeof value !== "object") return [];
        if (hasType(value, "HowToSection")) {
          const heading = value.name ? [`### ${String(value.name)}`] : [];
          return [...heading, ...instructionLines(value.itemListElement || value.steps)];
        }
        return value.text ? [String(value.text)] : instructionLines(value.itemListElement);
      }
      const steps = instructionLines(recipe.recipeInstructions);
      if (steps.length) {
        let number = 0;
        const rendered = steps.map((value) => value.startsWith("### ") ? value : `${++number}. ${markdownText(value)}`);
        lines.push(`## Instructions\n\n${rendered.join("\n")}`);
      }
      return { markdown: cleanMarkdown(lines.join("\n\n")), kind: "Recipe", label: "recipe", id: "jsonld-recipe", replace: true };
    }

    const productCandidate = primaryOfType("Product");
    const product = pageHasArticle && productCandidate && !matchesPage(productCandidate) ? null : productCandidate;
    if (product) {
      const lines = [`# ${markdownText(product.name || document.title || "Product")}`];
      const brand = typeof product.brand === "string" ? product.brand : product.brand?.name;
      if (brand) lines.push(`**Brand:** ${markdownText(brand)}`);
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      if (offers?.price) lines.push(`**Price:** ${markdownText(`${offers.priceCurrency || ""} ${offers.price}`.trim())}`);
      if (offers?.availability) lines.push(`**Availability:** ${markdownText(String(offers.availability).split("/").pop())}`);
      if (product.sku) lines.push(`**SKU:** ${markdownText(product.sku)}`);
      if (product.description) lines.push(markdownText(product.description));
      return { markdown: cleanMarkdown(lines.join("\n\n")), kind: "Product", label: "product details", id: "jsonld-product", replace: true };
    }

    const citationTitle = meta("citation_title");
    if (citationTitle) {
      const lines = [`# ${markdownText(citationTitle)}`];
      const authors = metas("citation_author");
      if (authors.length) lines.push(`**Authors:** ${authors.map(markdownText).join(", ")}`);
      const journal = meta("citation_journal_title");
      const date = meta("citation_publication_date") || meta("citation_date");
      if (journal) lines.push(`**Publication:** ${markdownText(journal)}`);
      if (date) lines.push(`**Published:** ${markdownText(date)}`);
      const pdf = absoluteUrl(meta("citation_pdf_url"));
      if (pdf) lines.push(`[PDF](${pdf})`);
      const abstract = meta("citation_abstract") || meta("description") || meta("og:description");
      if (abstract) lines.push(`## Abstract\n\n${markdownText(abstract)}`);
      return { markdown: cleanMarkdown(lines.join("\n\n")), kind: "Research paper", label: "paper", id: "citation-paper", replace: false };
    }
    return null;
  }

  function nameOf(node) {
    return `${node.id || ""} ${typeof node.className === "string" ? node.className : ""}`;
  }

  function isVisible(node) {
    try {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch {
      return true;
    }
  }

  function candidateScore(node) {
    if (!node || !isVisible(node)) return -Infinity;
    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 120) return -Infinity;
    const links = Array.from(node.querySelectorAll("a"));
    const linkLength = links.reduce((total, link) => total + (link.textContent || "").length, 0);
    const density = Math.min(1, linkLength / Math.max(1, text.length));
    const paragraphs = node.querySelectorAll("p").length;
    const headings = node.querySelectorAll("h1, h2, h3").length;
    const tag = node.tagName.toLowerCase();
    const name = nameOf(node);
    let score = Math.min(text.length, 60000) * (1 - density * 0.9) + paragraphs * 110 + headings * 60;
    if (tag === "article") score += 1800;
    else if (tag === "main" || node.getAttribute("role") === "main") score += 900;
    if (positiveName.test(name)) score += 650;
    if (negativeName.test(name)) score -= 3000;
    if (paragraphs === 0 && text.length > 1000) score *= 0.55;
    return score;
  }

  function domainRoot(host) {
    if (/(^|\.)wikipedia\.org$/.test(host)) {
      return { root: document.querySelector("#mw-content-text .mw-parser-output"), kind: "Wikipedia article", label: "Wikipedia article", id: "wikipedia" };
    }
    if (host === "github.com" || host.endsWith(".github.com")) {
      return { root: document.querySelector("article.markdown-body, .repository-content article, main article"), kind: "GitHub document", label: "GitHub document", id: "github" };
    }
    if (/(^|\.)(stackoverflow|serverfault|superuser|askubuntu)\.com$/.test(host) || host.endsWith(".stackexchange.com")) {
      const pieces = [
        document.querySelector(".question .s-prose, .question .post-text"),
        document.querySelector(".answer.accepted-answer .s-prose, .answer.accepted-answer .post-text, .answer .s-prose, .answer .post-text"),
      ].filter(Boolean);
      if (pieces.length) {
        const root = document.createElement("article");
        pieces.forEach((piece) => root.appendChild(piece.cloneNode(true)));
        return { root, kind: "Q&A", label: "question and answer", id: "stackexchange" };
      }
    }
    if (host === "medium.com" || host.endsWith(".medium.com") || host === "substack.com" || host.endsWith(".substack.com")) {
      return { root: document.querySelector("article"), kind: "Article", label: "article", id: "publisher-article" };
    }
    return null;
  }

  function chooseRoot(domain) {
    if (domain?.root) return domain.root;
    const candidates = new Set(document.querySelectorAll([
      "article", "main", "[role='main']", "[itemprop='articleBody']",
      ".article-body", ".article-content", ".entry-content", ".post-content",
      ".story-body", ".prose", "#article-body", "#article-content",
    ].join(",")));
    for (const paragraph of Array.from(document.querySelectorAll("p")).slice(0, 1500)) {
      if (candidates.size >= 600) break;
      let parent = paragraph.parentElement;
      for (let level = 0; parent && level < 2; level += 1, parent = parent.parentElement) candidates.add(parent);
    }
    let best = null;
    let bestScore = -Infinity;
    candidates.forEach((candidate) => {
      const score = candidateScore(candidate);
      if (score > bestScore) { best = candidate; bestScore = score; }
    });
    return best || document.body;
  }

  function isKnownVideoUrl(host, pathname) {
    if (host === "youtu.be") return /^\/[A-Za-z0-9_-]{6,}/.test(pathname);
    if (host === "youtube.com" || host.endsWith(".youtube.com")) return /^\/(watch|shorts|live|embed)(\/|$)/.test(pathname);
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) return /^\/(?:\d+|channels\/[^/]+\/\d+|showcase\/[^/]+\/video\/\d+)/.test(pathname);
    if (host === "twitch.tv" || host.endsWith(".twitch.tv")) return /^\/(?:videos\/\d+|[^/]+\/?$)/.test(pathname);
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return /^\/@[^/]+\/video\/\d+/.test(pathname);
    if (host === "dailymotion.com" || host.endsWith(".dailymotion.com")) return /^\/video\//.test(pathname);
    if (host === "loom.com" || host.endsWith(".loom.com")) return /^\/(share|embed)\//.test(pathname);
    if (host === "wistia.com" || host.endsWith(".wistia.com")) return /\/(medias|embed)\//.test(pathname);
    return false;
  }

  function videoDimensionsAreProminent(details) {
    if (!details.visible || details.adLike) return false;
    const viewportArea = Math.max(1, details.viewportWidth * details.viewportHeight);
    const areaRatio = (details.width * details.height) / viewportArea;
    return (details.controls && details.width >= 480 && details.height >= 270 && areaRatio >= 0.16) ||
      (details.width >= 720 && details.height >= 405 && areaRatio >= 0.35);
  }

  function videoDecision(details) {
    return isKnownVideoUrl(details.host, details.pathname) ||
      String(details.openGraphType || "").toLowerCase().startsWith("video") ||
      (!details.structuredAsArticle && details.hasVideoMetadata) ||
      details.prominentNativeVideo;
  }

  function prominentVideo(video) {
    const adLike = negativeName.test(nameOf(video)) || Boolean(
      video.closest("[class*='advert'], [id*='advert'], [class^='ad-'], [class*=' ad-'], [id^='ad-'], [class*='promo'], [class*='sponsor'], [id*='sponsor']")
    );
    const visible = isVisible(video);
    const rect = video.getBoundingClientRect();
    return videoDimensionsAreProminent({
      visible,
      adLike,
      width: rect.width,
      height: rect.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      controls: video.controls,
    });
  }

  const host = location.hostname.toLowerCase().replace(/^www\./, "");
  const items = jsonLdItems();
  const structured = structuredDetails(items);
  const domain = domainRoot(host);
  const root = chooseRoot(domain);
  const clone = root.cloneNode(true);
  clone.querySelectorAll(ignored).forEach((node) => node.remove());
  clone.querySelectorAll("*").forEach((node) => {
    const name = nameOf(node);
    if (negativeName.test(name) && !positiveName.test(name)) node.remove();
  });

  const openGraphType = meta("og:type").toLowerCase();
  const structuredAsArticle = items.some((item) =>
    ["Article", "NewsArticle", "BlogPosting", "ScholarlyArticle"].some((type) => hasType(item, type))
  );
  const isVideo = videoDecision({
    host,
    pathname: location.pathname,
    openGraphType,
    structuredAsArticle,
    hasVideoMetadata:
      Boolean(meta("og:video") || meta("twitter:player")) ||
      items.some((item) => hasType(item, "VideoObject")),
    prominentNativeVideo: Array.from(document.querySelectorAll("video")).some(prominentVideo),
  });

  let article = cleanMarkdown(block(clone, 0));
  let articleKind = domain?.kind || "Article";
  let articleLabel = domain?.label || "simplified article";
  let extractionRecipe = domain?.id || "scored-article";
  if (structured) {
    article = structured.replace
      ? structured.markdown
      : cleanMarkdown(`${structured.markdown}\n\n---\n\n${article}`);
    articleKind = structured.kind;
    articleLabel = structured.label;
    extractionRecipe = structured.id;
  }

  const selection = selectedMarkdown();
  const description = (meta("og:description") || meta("description")).slice(0, 2000);
  const title = (meta("og:title") || document.title || host).trim().slice(0, 500);
  const canonical = absoluteUrl(document.querySelector("link[rel='canonical']")?.href || location.href);

  return {
    url: canonical || location.href,
    title,
    selection,
    description,
    article,
    articleKind,
    articleLabel,
    extractionRecipe,
    isVideo,
    host,
  };
}
