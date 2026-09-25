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
  if (msg.type === "GLYPH_IDENTIFY") {
    identifyWithClaude(msg.image).then(sendResponse);
    return true;
  }
});

const DEFAULT_IDENTIFY_MODEL = "claude-sonnet-5";
const IDENTIFY_MODELS = {
  "claude-haiku-4-5": null,
  "claude-sonnet-5": "high",
  "claude-opus-5-5": "high",
  "claude-fable-5-1": "high",
};
const IDENTIFY_URL = "https://api.anthropic.com/v1/messages";
const IDENTIFY_PROMPT = `Identify the typeface in this image by its letterforms.

Study the shapes that separate families: two-story or single-story a, the ear of g, the spur and aperture of G, the tail of y and Q, the apex of A, the terminals of c and e, the shape of 1, and whether the face is grotesque, geometric, humanist, neo-grotesque, transitional, old-style, slab, or script.

Name each real family you can see, using its common name only. No weight, style, foundry, or category such as "sans-serif". When the letters are readable, commit to the best match instead of hedging.

confidence is from 0 to 1:
- 0.8 or higher when several distinguishing letters are clear and agree on one family
- 0.55 to 0.75 when the face is clear but a close relative is still plausible
- below 0.4 only when the crop is blurry, tiny, or has no real text

Also describe how each face is set:
- weight is a CSS number from 100 to 900. Regular is 400, medium is 500, bold is 700.
- italic is true when the letters slant.
- underline is true when the text is underlined.
- size is the approximate on-screen font size in pixels.
- color is the text colour as a #rrggbb hex.
- confidence follows the scale above.

If the crop contains more than one distinct typeface, include each one. A different weight or style of the same family is its own entry. Do not list lookalikes or guesses for the same letters. Use one entry when only one face is visible. At most four.

Reply with JSON only:
{"fonts":[{"font":"Family Name","weight":400,"italic":false,"underline":false,"size":16,"color":"#1a1a18","confidence":0.0}]}`;

const FONT_CATEGORY = /^(?:sans[\s-]?serif|serif|monospace|slab(?:\s+serif)?|script|display|handwriting|geometric(?:\s+sans)?|grotesque|neo-?grotesque|humanist(?:\s+sans)?|transitional|old[\s-]?style|modern|didone|blackletter|gothic)$/i;

function splitDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2].replace(/\s/g, "") };
}

// WEIGHT_SUFFIX comes from fontSource.js, imported above. Declaring it again
// stops the service worker from loading, which leaves the toolbar button dead.
function cleanFamilyName(value) {
  let name = String(value || "").replace(/["']/g, "").replace(/\s+/g, " ").trim();
  if (!/\bnew roman$/i.test(name)) name = name.replace(WEIGHT_SUFFIX, "").trim();
  if (!name || FONT_CATEGORY.test(name)) return "";
  return name;
}

function cssWeightNumber(value) {
  const named = {
    thin: 100, hairline: 100, extralight: 200, "extra light": 200, ultralight: 200, "ultra light": 200,
    light: 300, regular: 400, normal: 400, roman: 400, book: 400, medium: 500,
    semibold: 600, "semi bold": 600, "semi-bold": 600, demibold: 600, "demi bold": 600, "demi-bold": 600,
    bold: 700, extrabold: 800, "extra bold": 800, ultrabold: 800, "ultra bold": 800, black: 900, heavy: 900,
  };
  const word = String(value || "").trim().toLowerCase();
  if (named[word]) return named[word];
  const n = Number(word);
  if (!Number.isFinite(n) || n < 1 || n > 1000) return 0;
  return Math.round(n);
}

function cssSizePx(value) {
  const n = Number(String(value || "").trim().replace(/px$/i, ""));
  if (!Number.isFinite(n) || n < 4 || n > 400) return 0;
  return Math.round(n);
}

function cssHexColor(value) {
  const s = String(value || "").trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return "#" + h.toLowerCase();
  }
  const rgb = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!rgb) return "";
  return "#" + [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

function flagFrom(value) {
  if (value === true || value === 1) return true;
  const word = String(value || "").trim().toLowerCase();
  return word === "true" || word === "yes";
}

function faceFrom(data) {
  if (!data || typeof data !== "object") return null;
  const font = cleanFamilyName(data.font) || "Unknown";
  let confidence = Number(data.confidence);
  if (!Number.isFinite(confidence)) confidence = null;
  else {
    if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
    confidence = Math.max(0, Math.min(1, confidence));
  }
  const face = { font };
  const weight = cssWeightNumber(data.weight);
  if (weight) face.weight = weight;
  if (flagFrom(data.italic)) face.italic = true;
  if (flagFrom(data.underline)) face.underline = true;
  const size = cssSizePx(data.size);
  if (size) face.size = size;
  const color = cssHexColor(data.color);
  if (color) face.color = color;
  if (confidence != null) face.confidence = confidence;
  return face;
}

function parseFontGuess(body) {
  const text = (Array.isArray(body && body.content) ? body.content : [])
    .filter((block) => block && block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return null;
  }
  const list = Array.isArray(data.fonts) ? data.fonts : [data];
  const fonts = [];
  const seen = new Set();
  for (const item of list) {
    const face = faceFrom(item);
    if (!face || face.font === "Unknown") continue;
    const key = [face.font, face.weight || "", face.italic ? "i" : "", face.size || ""].join("\n").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    fonts.push(face);
    if (fonts.length === 4) break;
  }
  if (!fonts.length) return null;
  return { fonts };
}

async function identifyWithClaude(dataUrl) {
  const { apiKey, snipModel } = await chrome.storage.local.get(["apiKey", "snipModel"]);
  const key = String(apiKey || "").trim();
  if (!key) return { error: "no_key" };
  const image = splitDataUrl(dataUrl);
  if (!image) return { error: "bad_image" };
  const model = Object.prototype.hasOwnProperty.call(IDENTIFY_MODELS, snipModel)
    ? snipModel
    : DEFAULT_IDENTIFY_MODEL;
  const effort = IDENTIFY_MODELS[model];
  const payload = {
    model,
    max_tokens: 8192,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.data },
        },
        { type: "text", text: IDENTIFY_PROMPT },
      ],
    }],
  };
  if (effort) payload.output_config = { effort };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 70000);
  let resp;
  try {
    resp = await fetch(IDENTIFY_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { error: "network" };
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401 || resp.status === 403) return { error: "unauthorized" };
  if (resp.status === 429) return { error: "rate_limit" };
  if (resp.status === 529 || resp.status === 503) return { error: "overloaded" };
  if (!resp.ok) return { error: "failed" };

  let body;
  try {
    body = await resp.json();
  } catch (err) {
    return { error: "failed" };
  }
  return parseFontGuess(body) || { error: "failed" };
}

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
  const mode = command === "start-snip" ? "snip" : command === "start-highlight" ? "highlight" : null;
  if (!mode) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
  chrome.tabs.sendMessage(tab.id, { type: "GLYPH_START", mode });
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
