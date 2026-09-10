importScripts("fontSource.js");

const BADGE_TEXT = { snip: "✂", highlight: "🖍" };
const SELECTION_CARD_KEY = "selectionCard";
const SELECTION_SCRIPT_ID = "glyph-selection";
const SELECTION_ORIGINS = ["http://*/*", "https://*/*"];

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
  if (msg.type === "GLYPH_SELECTION_CARD_SET") {
    syncSelectionScripts(!!msg.enabled).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GLYPH_FONT_SOURCE") {
    resolveFontSource(msg.family).then((source) => {
      sendResponse(source || { url: null, label: null });
    }).catch(() => {
      sendResponse({ url: null, label: null });
    });
    return true;
  }
});

const RESTRICTED_URL_PREFIXES = ["chrome://", "chrome-extension://", "edge://", "about:", "https://chrome.google.com/webstore", "https://chromewebstore.google.com"];

function isRestricted(url) {
  return !url || RESTRICTED_URL_PREFIXES.some((p) => url.startsWith(p));
}

// The toolbar button normally injects panel.js, which shows popup.html in a
// transparent in-page iframe (Chrome's native popup cannot have a transparent
// backdrop, so its corners can't be rounded). On pages that can't be scripted
// a small native popup explains that Glyph can't run there, enabled per tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (!isRestricted(tab.url)) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["panel.js"] });
      return;
    } catch (err) {
      // Fall through to the native popup.
    }
  }
  await chrome.action.setPopup({ tabId: tab.id, popup: "unavailable.html" });
  try {
    await chrome.action.openPopup();
  } catch (err) {
    // Older Chrome: the popup will show on the next click instead.
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" });
    // Restore the in-page panel for tabs that previously showed the "can't run here" popup.
    chrome.action.setPopup({ tabId, popup: "" });
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

async function hasSelectionOrigins() {
  try {
    return await chrome.permissions.contains({ origins: SELECTION_ORIGINS });
  } catch (err) {
    return false;
  }
}

async function injectSelectionIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || isRestricted(tab.url)) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    } catch (err) {
      // Restricted or unloaded tabs can't be scripted.
    }
  }));
}

async function enableSelectionScripts() {
  try {
    await chrome.scripting.registerContentScripts([{
      id: SELECTION_SCRIPT_ID,
      matches: SELECTION_ORIGINS,
      js: ["content.js"],
      css: ["content.css"],
      runAt: "document_idle",
      persistAcrossSessions: true,
    }]);
  } catch (err) {
    // Already registered, or host permission was not granted.
  }
  await injectSelectionIntoOpenTabs();
}

async function disableSelectionScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SELECTION_SCRIPT_ID] });
  } catch (err) {
    // Not registered.
  }
}

async function syncSelectionScripts(forceEnabled) {
  const enabled = forceEnabled == null
    ? !!(await chrome.storage.local.get(SELECTION_CARD_KEY))[SELECTION_CARD_KEY]
    : forceEnabled;
  const allowed = await hasSelectionOrigins();
  if (enabled && allowed) {
    await enableSelectionScripts();
    return;
  }
  await disableSelectionScripts();
  if (enabled && !allowed) {
    await chrome.storage.local.set({ [SELECTION_CARD_KEY]: false });
  }
}

chrome.runtime.onInstalled.addListener(() => { syncSelectionScripts(); });
chrome.runtime.onStartup.addListener(() => { syncSelectionScripts(); });
chrome.permissions.onRemoved.addListener(() => { syncSelectionScripts(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SELECTION_CARD_KEY]) return;
  syncSelectionScripts(!!changes[SELECTION_CARD_KEY].newValue);
});
