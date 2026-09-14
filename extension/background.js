(function () {
  "use strict";

  const MENU = {
    root: "canvas-notes",
    page: "canvas-notes-page",
    article: "canvas-notes-article",
    selection: "canvas-notes-selection",
    link: "canvas-notes-link",
    image: "canvas-notes-image",
    screenshot: "canvas-notes-screenshot",
    screenshotArea: "canvas-notes-screenshot-area",
  };

  async function configuredConnection() {
    const connection = await CanvasNotes.loadConnection();
    if (!connection.serverUrl || !connection.apiToken) {
      await browser.runtime.openOptionsPage();
      throw new Error("Set up Canvas Notes first.");
    }
    return connection;
  }

  function showBadge(tabId, ok, message) {
    const details = tabId ? { tabId } : {};
    browser.action.setBadgeBackgroundColor({ ...details, color: ok ? "#2f8f61" : "#b74848" });
    browser.action.setBadgeText({ ...details, text: ok ? "✓" : "!" });
    browser.action.setTitle({ ...details, title: message });
    setTimeout(() => {
      browser.action.setBadgeText({ ...details, text: "" }).catch(() => {});
      browser.action.setTitle({ ...details, title: "Clip to Canvas Notes" }).catch(() => {});
    }, 3500);
  }

  async function extract(tabId) {
    const result = await browser.scripting.executeScript({
      target: { tabId },
      func: canvasNotesExtractPage,
    });
    return result?.[0]?.result;
  }

  async function clipPage(tab, article) {
    const connection = await configuredConnection();
    let data = { url: tab.url };
    if (article) data = await extract(tab.id);
    return CanvasNotes.capture(connection, {
      url: data.url || tab.url,
      text: article && !data.isVideo ? data.article : undefined,
    });
  }

  async function requestOrigin(url) {
    const parsed = new URL(url);
    if (parsed.protocol === "data:") return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("This image address cannot be read by an extension.");
    }
    const origin = `${parsed.origin}/*`;
    return (await browser.permissions.request({ origins: [origin] })) ? origin : false;
  }

  function filenameForImage(url, mime) {
    let name = "clipped-image";
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop() || name);
    } catch {
      // Keep the safe fallback.
    }
    name = name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 120) || "clipped-image";
    if (!name.includes(".")) {
      const extension = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg" }[mime];
      if (extension) name += extension;
    }
    return name;
  }

  async function clipImage(info, tab, connection) {
    const response = await fetch(info.srcUrl, { credentials: "omit", redirect: "follow" });
    if (!response.ok) throw new Error(`The image server returned ${response.status}.`);
    const blob = await response.blob();
    if (blob.size > 25 * 1024 * 1024) throw new Error("That image is larger than Canvas Notes' 25 MB limit.");
    const mime = (blob.type || response.headers.get("content-type") || "").split(";")[0];
    if (!mime.startsWith("image/")) throw new Error("That address did not return an image.");
    return CanvasNotes.captureFile(
      connection,
      blob,
      filenameForImage(info.srcUrl, mime),
      tab.title ? `Image from ${tab.title}` : "Clipped image"
    );
  }

  async function selectScreenshotRegion(tabId) {
    const result = await browser.scripting.executeScript({
      target: { tabId },
      func: canvasNotesSelectRegion,
    });
    return result?.[0]?.result || null;
  }

  async function screenshotBlob(tab, region) {
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    if (!region) return blob;

    const bitmap = await createImageBitmap(blob);
    const scaleX = bitmap.width / Math.max(1, region.viewportWidth);
    const scaleY = bitmap.height / Math.max(1, region.viewportHeight);
    const sourceX = Math.max(0, Math.floor(region.x * scaleX));
    const sourceY = Math.max(0, Math.floor(region.y * scaleY));
    const sourceWidth = Math.max(1, Math.min(bitmap.width - sourceX, Math.round(region.width * scaleX)));
    const sourceHeight = Math.max(1, Math.min(bitmap.height - sourceY, Math.round(region.height * scaleY)));
    const canvas = new OffscreenCanvas(sourceWidth, sourceHeight);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not crop the screenshot.");
    context.drawImage(
      bitmap,
      sourceX, sourceY, sourceWidth, sourceHeight,
      0, 0, sourceWidth, sourceHeight
    );
    bitmap.close?.();
    return canvas.convertToBlob({ type: "image/png" });
  }

  async function clipScreenshot(tab, connection, { region, title, text } = {}) {
    const blob = await screenshotBlob(tab, region);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return CanvasNotes.captureFile(
      connection,
      blob,
      `screenshot-${timestamp}.png`,
      title || (tab.title ? `Screenshot of ${tab.title}` : "Web page screenshot"),
      text
    );
  }

  async function clipSelectedScreenshot(tab, connection, details = {}) {
    const region = await selectScreenshotRegion(tab.id);
    if (!region) return false;
    // Give Firefox a frame to repaint after removing the selection overlay.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await clipScreenshot(tab, connection, { ...details, region });
    return true;
  }

  async function handleMenu(info, tab) {
    if (!tab?.id) return;
    let imageOrigin = null;
    let connection = null;
    try {
      // Permission prompts must be initiated directly by the menu click. Do
      // this before any storage/network await for image captures.
      if (info.menuItemId === MENU.image) {
        imageOrigin = await requestOrigin(info.srcUrl);
        if (imageOrigin === false) throw new Error("Image access was not allowed.");
      }
      connection = await configuredConnection();
      if (info.menuItemId === MENU.page) await clipPage(tab, false);
      else if (info.menuItemId === MENU.article) await clipPage(tab, true);
      else if (info.menuItemId === MENU.selection) {
        let selected = info.selectionText;
        try {
          const data = await extract(tab.id);
          if (data?.selection) selected = data.selection;
        } catch {
          // Plain selection text is still useful on protected or unusual pages.
        }
        await CanvasNotes.capture(connection, { text: selected, url: info.pageUrl });
      } else if (info.menuItemId === MENU.link) {
        await CanvasNotes.capture(connection, { url: info.linkUrl });
      } else if (info.menuItemId === MENU.image) {
        await clipImage(info, tab, connection);
      } else if (info.menuItemId === MENU.screenshot) {
        await clipScreenshot(tab, connection);
      } else if (info.menuItemId === MENU.screenshotArea) {
        if (!(await clipSelectedScreenshot(tab, connection))) return;
      } else return;
      showBadge(tab.id, true, "Saved to the Canvas Notes inbox");
    } catch (error) {
      showBadge(tab.id, false, error?.message || "Could not clip this item");
    } finally {
      if (
        imageOrigin &&
        (!connection || imageOrigin !== CanvasNotes.originPattern(connection.serverUrl))
      ) {
        await browser.permissions.remove({ origins: [imageOrigin] });
      }
    }
  }

  function installMenus() {
    browser.contextMenus.removeAll().then(() => {
      browser.contextMenus.create({ id: MENU.root, title: "Canvas Notes", contexts: ["page", "selection", "link", "image"] });
      browser.contextMenus.create({ id: MENU.page, parentId: MENU.root, title: "Clip page", contexts: ["page"] });
      browser.contextMenus.create({ id: MENU.article, parentId: MENU.root, title: "Clip simplified article", contexts: ["page"] });
      browser.contextMenus.create({ id: MENU.screenshot, parentId: MENU.root, title: "Clip visible area as screenshot", contexts: ["page"] });
      browser.contextMenus.create({ id: MENU.screenshotArea, parentId: MENU.root, title: "Select area to screenshot", contexts: ["page"] });
      browser.contextMenus.create({ id: MENU.selection, parentId: MENU.root, title: "Clip selection", contexts: ["selection"] });
      browser.contextMenus.create({ id: MENU.link, parentId: MENU.root, title: "Clip link", contexts: ["link"] });
      browser.contextMenus.create({ id: MENU.image, parentId: MENU.root, title: "Clip image", contexts: ["image"] });
    });
  }

  browser.runtime.onInstalled.addListener((details) => {
    installMenus();
    if (details.reason === "install") browser.runtime.openOptionsPage();
  });
  browser.runtime.onStartup.addListener(installMenus);
  browser.contextMenus.onClicked.addListener(handleMenu);
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== "capture-screenshot-area") return undefined;
    return (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active page was found.");
      const connection = await configuredConnection();
      const saved = await clipSelectedScreenshot(tab, connection, {
        title: message.title,
        text: message.text,
      });
      if (saved) showBadge(tab.id, true, "Screenshot saved to the Canvas Notes inbox");
      return { saved };
    })().catch((error) => {
      browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id) showBadge(tab.id, false, error?.message || "Could not save this screenshot");
      });
      return { saved: false, error: error?.message || "Could not save this screenshot" };
    });
  });
  browser.commands.onCommand.addListener(async (command) => {
    if (command !== "clip-page") return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await clipPage(tab, false);
      showBadge(tab.id, true, "Saved to the Canvas Notes inbox");
    } catch (error) {
      showBadge(tab.id, false, error?.message || "Could not clip this page");
    }
  });
})();
