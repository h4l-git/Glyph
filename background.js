const BADGE_TEXT = { snip: "✂", highlight: "🖍" };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GLYPH_CAPTURE") {
    chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
      sendResponse({ dataUrl });
    });
    return true;
  }
  if (msg.type === "GLYPH_MODE_CHANGED" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    if (msg.active) {
      chrome.action.setBadgeText({ tabId, text: BADGE_TEXT[msg.mode] || "" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#7FC4BB" });
    } else {
      chrome.action.setBadgeText({ tabId, text: "" });
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "start-snip") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
  chrome.tabs.sendMessage(tab.id, { type: "GLYPH_START", mode: "snip" });
});
