(async function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let page = null;
  let connection = null;

  function openSettings() {
    browser.runtime.openOptionsPage();
    window.close();
  }

  function setBusy(busy) {
    document.querySelectorAll("#clip-form button").forEach((button) => { button.disabled = busy; });
  }

  async function save(kind) {
    setBusy(true);
    $("status").className = "status";
    $("status").textContent = "Saving…";
    try {
      const clip = { url: page.url };
      const title = CanvasNotes.titleOverride($("title").value, page.title);
      if (title) clip.title = title;
      const content = kind === "selection" ? page.selection : kind === "article" ? page.article : "";
      const text = CanvasNotes.combineClipText($("note").value, content);
      if (text) clip.text = text;
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

  try {
    connection = await CanvasNotes.loadConnection();
    if (!connection.serverUrl || !connection.apiToken) {
      $("loading").hidden = true;
      $("setup").hidden = false;
      return;
    }
    $("destination").textContent = new URL(connection.serverUrl).host;

    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/i.test(tab.url || "")) throw new Error("unsupported");
    const result = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: canvasNotesExtractPage });
    page = result?.[0]?.result;
    if (!page) throw new Error("unsupported");

    $("title").value = page.title || "";
    $("host").textContent = page.host;
    $("kind").textContent = page.isVideo ? "Video" : "Web page";
    $("clip-page").textContent = page.isVideo ? "Clip video" : "Clip page";
    $("clip-selection").hidden = !page.selection;
    $("clip-article").hidden = page.isVideo || page.article.length < 200;
    $("loading").hidden = true;
    $("clip-form").hidden = false;
  } catch {
    $("loading").hidden = true;
    $("unsupported").hidden = false;
  }
})();
