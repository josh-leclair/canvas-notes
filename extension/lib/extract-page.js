/* This function is deliberately self-contained. Firefox serializes it into the
 * active tab with scripting.executeScript, so it cannot close over helpers. */
function canvasNotesExtractPage() {
  "use strict";

  const MAX_ARTICLE_CHARS = 100000;
  const ignored = [
    "script", "style", "noscript", "template", "svg", "canvas", "form",
    "button", "input", "select", "textarea", "nav", "aside", "footer",
    "[aria-hidden='true']", "[hidden]", ".advertisement", ".advertising",
    ".cookie", ".cookies", ".newsletter", ".social-share",
  ].join(",");

  function meta(name) {
    const escaped = CSS.escape(name);
    return (
      document.querySelector(`meta[property="${escaped}"]`)?.content ||
      document.querySelector(`meta[name="${escaped}"]`)?.content ||
      ""
    ).trim();
  }

  function absoluteUrl(value) {
    try {
      const parsed = new URL(value, location.href);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function inline(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    const content = Array.from(node.childNodes).map(inline).join("");
    if (tag === "br") return "\n";
    if (tag === "strong" || tag === "b") return content.trim() ? `**${content.trim()}**` : "";
    if (tag === "em" || tag === "i") return content.trim() ? `*${content.trim()}*` : "";
    if (tag === "code") return content.trim() ? `\`${content.trim().replace(/`/g, "\\`")}\`` : "";
    if (tag === "a") {
      const href = absoluteUrl(node.getAttribute("href") || "");
      const label = content.trim();
      return href && label ? `[${label}](${href})` : label;
    }
    if (tag === "img") {
      const src = absoluteUrl(node.currentSrc || node.getAttribute("src") || "");
      const alt = (node.getAttribute("alt") || "").trim();
      return src ? `![${alt}](${src})` : "";
    }
    return content;
  }

  function block(node, depth) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE || depth > 40) return "";
    const tag = node.tagName.toLowerCase();
    if (["a", "strong", "b", "em", "i", "code", "img", "br"].includes(tag)) {
      return inline(node);
    }
    if (["pre"].includes(tag)) {
      const text = (node.textContent || "").trim();
      return text ? `\n\n\`\`\`\n${text}\n\`\`\`\n\n` : "";
    }
    if (/^h[1-6]$/.test(tag)) {
      const text = inline(node).trim();
      return text ? `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n` : "";
    }
    if (tag === "blockquote") {
      const text = Array.from(node.childNodes).map((child) => block(child, depth + 1)).join("").trim();
      return text ? `\n\n${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : "";
    }
    if (tag === "li") {
      const text = inline(node).replace(/\s+/g, " ").trim();
      const ordered = node.parentElement?.tagName.toLowerCase() === "ol";
      const position = ordered
        ? Array.from(node.parentElement.children).filter((child) => child.tagName.toLowerCase() === "li").indexOf(node) + 1
        : 0;
      return text ? `\n${ordered ? `${position}.` : "-"} ${text}` : "";
    }
    if (["p", "div", "section", "article", "main", "header", "figure", "figcaption", "ul", "ol"].includes(tag)) {
      const content = Array.from(node.childNodes).map((child) => block(child, depth + 1)).join("").trim();
      return content ? `\n\n${content}\n\n` : "";
    }
    return Array.from(node.childNodes).map((child) => block(child, depth + 1)).join("");
  }

  function cleanMarkdown(value) {
    return value
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
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
    return cleanMarkdown(block(container, 0)) ||
      (selected.toString() || "").trim().slice(0, MAX_ARTICLE_CHARS);
  }

  const candidates = Array.from(document.querySelectorAll("article, main, [role='main']"));
  const root = candidates.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length)[0] || document.body;
  const clone = root.cloneNode(true);
  clone.querySelectorAll(ignored).forEach((node) => node.remove());

  const host = location.hostname.toLowerCase().replace(/^www\./, "");
  const videoHosts = [
    "youtube.com", "youtu.be", "vimeo.com", "twitch.tv", "tiktok.com",
    "dailymotion.com", "loom.com", "wistia.com",
  ];
  const isVideo =
    videoHosts.some((item) => host === item || host.endsWith(`.${item}`)) ||
    meta("og:type").toLowerCase().startsWith("video") ||
    Boolean(document.querySelector("video"));

  const selection = selectedMarkdown();
  const description = (meta("og:description") || meta("description")).slice(0, 2000);
  const title = (meta("og:title") || document.title || host).trim().slice(0, 500);
  const canonical = absoluteUrl(document.querySelector("link[rel='canonical']")?.href || location.href);

  return {
    url: canonical || location.href,
    title,
    selection,
    description,
    article: cleanMarkdown(block(clone, 0)),
    isVideo,
    host,
  };
}
