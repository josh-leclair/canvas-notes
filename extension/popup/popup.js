(async function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let page = null;
  let connection = null;
  let activeTab = null;

  function openSettings() {
    browser.runtime.openOptionsPage();
    window.close();
  }

  function setBusy(busy) {
    document.querySelectorAll("#clip-form button").forEach((button) => { button.disabled = busy; });
  }

  function showScreenshotOnly(tab) {
    page = {
      url: tab.url || "",
      title: tab.title || "Browser page",
      host: "Page content unavailable",
      selection: "",
      article: "",
      isVideo: false,
    };
    $("title").value = page.title;
    $("host").textContent = page.host;
    $("kind").textContent = "Screenshot only";
    $("clip-page").hidden = true;
    $("clip-selection").hidden = true;
    $("clip-article").hidden = true;
    $("loading").hidden = true;
    $("unsupported").hidden = true;
    $("clip-form").hidden = false;
  }

  async function save(kind) {
    setBusy(true);
    $("status").className = "status";
    $("status").textContent = "Saving…";
    try {
      const title = CanvasNotes.titleOverride($("title").value, page.title);
      if (kind === "screenshot") {
        const dataUrl = await browser.tabs.captureVisibleTab(activeTab.windowId, { format: "png" });
        const blob = await (await fetch(dataUrl)).blob();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        await CanvasNotes.captureFile(
          connection,
          blob,
          `screenshot-${timestamp}.png`,
          title || `Screenshot of ${page.title || page.host}`,
          $("note").value.trim() || undefined
        );
        $("status").className = "status success";
        $("status").textContent = "Screenshot saved to your inbox.";
        setTimeout(() => window.close(), 900);
        return;
      }

      const clip = { url: page.url };
      if (title) clip.title = title;
      const content = kind === "selection" ? page.selection : kind === "article" ? page.article : "";
      const text = CanvasNotes.combineClipText($("note").value, content);
      if (text) clip.text = text;
      if (page.isVideo) clip.preferUrlCard = true;
      await CanvasNotes.capture(connection, clip);
      $("status").className = "status success";
      $("status").textContent = "Saved to your inbox.";
      setTimeout(() => window.close(), 900);
    } catch (error) {
      $("status").className = "status error";
      $("status").textContent = error?.message || "Could not save this clip.";
      setBusy(false);
    }
  }

  $("settings").addEventListener("click", openSettings);
  $("setup-button").addEventListener("click", openSettings);
  $("clip-page").addEventListener("click", () => save("page"));
  $("clip-selection").addEventListener("click", () => save("selection"));
  $("clip-article").addEventListener("click", () => save("article"));
  $("clip-screenshot").addEventListener("click", () => save("screenshot"));

  try {
    connection = await CanvasNotes.loadConnection();
    if (!connection.serverUrl || !connection.apiToken) {
      $("loading").hidden = true;
      $("setup").hidden = false;
      return;
    }
    $("destination").textContent = new URL(connection.serverUrl).host;

    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("unsupported");
    activeTab = tab;
    if (!/^https?:/i.test(tab.url || "")) {
      showScreenshotOnly(tab);
      return;
    }
    const result = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: canvasNotesExtractPage });
    page = result?.[0]?.result;
    if (!page) throw new Error("unsupported");

    $("title").value = page.title || "";
    $("host").textContent = page.host;
    $("kind").textContent = page.isVideo ? "Video" : (page.articleKind || "Web page");
    $("clip-page").textContent = page.isVideo ? "Clip video" : "Clip page";
    $("clip-selection").hidden = !page.selection;
    $("clip-article").textContent = `Clip ${page.articleLabel || "simplified article"}`;
    $("clip-article").hidden = page.isVideo || page.article.length < 120;
    $("loading").hidden = true;
    $("clip-form").hidden = false;
  } catch {
    if (activeTab) showScreenshotOnly(activeTab);
    else {
      $("loading").hidden = true;
      $("unsupported").hidden = false;
    }
  }
})();
