importScripts("fontSource.js");
try {
  importScripts("wfiKey.js");
} catch (err) {
  // wfiKey.js is local. Snip stays off until that file defines WFI_API_KEY.
}

const BADGE_TEXT = { snip: "✂", highlight: "🖍", image: "▣" };
const SELECTION_CARD_KEY = "selectionCard";
const SELECTION_SCRIPT_ID = "glyph-selection";
const SELECTION_ORIGINS = ["http://*/*", "https://*/*"];

// Sharper snip zooms the tab, captures, then puts the zoom back. Per-tab scope
// keeps that change off the site's saved zoom. Put the old factor back before
// leaving per-tab mode: Chrome saves the current factor onto the site when a
// tab returns to per-origin and that site has no zoom of its own. A stale end
// must not undo a newer snip.
const SHARP_MAX_ZOOM = 5;
const SHARP_MIN_GAIN = 1.15;
const sharpSessions = new Map();
let sharpZoomQueue = Promise.resolve();
let sharpZoomSeq = 0;

function queueSharpZoom(task) {
  const run = sharpZoomQueue.then(task, task);
  sharpZoomQueue = run.then(() => {}, () => {});
  return run;
}

function sharpZoomState(previous, changedSettings) {
  return {
    zoom: previous.zoom,
    mode: previous.mode || "automatic",
    scope: previous.scope || "per-origin",
    changedSettings: !!changedSettings,
  };
}

async function restoreTabZoom(tabId, previous, changedSettings) {
  await chrome.tabs.setZoom(tabId, previous.zoom);
  if (!changedSettings) return;
  const mode = previous.mode || "automatic";
  const payload = { mode };
  // Manual and disabled zoom ignore scope. Per-origin is only valid in automatic mode.
  if (mode === "automatic") payload.scope = previous.scope || "per-origin";
  await chrome.tabs.setZoomSettings(tabId, payload);
  const restored = await chrome.tabs.getZoom(tabId);
  if (Math.abs(restored - previous.zoom) > 0.01) await chrome.tabs.setZoom(tabId, previous.zoom);
}

function scheduleZoomRecheck(tabId, zoom) {
  setTimeout(() => {
    queueSharpZoom(async () => {
      const active = sharpSessions.get(tabId);
      if (active) return;
      try {
        const now = await chrome.tabs.getZoom(tabId);
        if (Math.abs(now - zoom) > 0.01) await chrome.tabs.setZoom(tabId, zoom);
      } catch (err) {
        // The tab can close before the late zoom check.
      }
    });
  }, 200);
}

async function beginSharpZoom(tabId, ratio) {
  await endSharpZoom(tabId, 0);
  if (!Number.isFinite(ratio) || ratio < SHARP_MIN_GAIN) return { ok: false };
  let current = 1;
  let settings = { mode: "automatic", scope: "per-origin", defaultZoomFactor: 1 };
  try {
    current = await chrome.tabs.getZoom(tabId);
    settings = await chrome.tabs.getZoomSettings(tabId);
  } catch (err) {
    return { ok: false };
  }
  const wanted = Math.min(SHARP_MAX_ZOOM, Math.round(current * ratio * 100) / 100);
  if (!Number.isFinite(wanted) || wanted < current * SHARP_MIN_GAIN) return { ok: false };
  const previous = {
    zoom: current,
    mode: settings.mode,
    scope: settings.scope,
  };
  const id = ++sharpZoomSeq;
  const timer = setTimeout(() => {
    queueSharpZoom(() => endSharpZoom(tabId, id));
  }, 12000);
  sharpSessions.set(tabId, { id, previous, timer, changedSettings: false });
  try {
    if (previous.scope !== "per-tab" || previous.mode === "disabled") {
      try {
        await chrome.tabs.setZoomSettings(tabId, { mode: "automatic", scope: "per-tab" });
        const session = sharpSessions.get(tabId);
        if (session && session.id === id) session.changedSettings = true;
      } catch (err) {
        // The tab can still zoom when its saved zoom settings cannot be changed.
      }
    }
    await chrome.tabs.setZoom(tabId, wanted);
    const session = sharpSessions.get(tabId);
    return {
      ok: true,
      id,
      zoom: sharpZoomState(previous, session && session.changedSettings),
    };
  } catch (err) {
    await endSharpZoom(tabId, id);
    return { ok: false };
  }
}

async function endSharpZoom(tabId, id, fallback) {
  const session = sharpSessions.get(tabId);
  if (session && id && session.id !== id) return { ok: true };

  let previous = null;
  let changedSettings = false;
  if (session) {
    sharpSessions.delete(tabId);
    clearTimeout(session.timer);
    previous = session.previous;
    changedSettings = session.changedSettings;
  } else if (fallback && Number(fallback.zoom) > 0) {
    // The worker can restart between the zoom and its restore. The page still
    // has the factor from when the snip began.
    previous = {
      zoom: Number(fallback.zoom),
      mode: fallback.mode || "automatic",
      scope: fallback.scope || "per-origin",
    };
    changedSettings = !!fallback.changedSettings;
  }
  if (!previous || !(previous.zoom > 0)) return { ok: true };
  try {
    await restoreTabZoom(tabId, previous, changedSettings);
  } catch (err) {
    // The tab can close before the zoom is restored.
  }
  scheduleZoomRecheck(tabId, previous.zoom);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GLYPH_CAPTURE") {
    chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
      sendResponse({ dataUrl });
    });
    return true;
  }
  if (msg.type === "GLYPH_ZOOM_BEGIN" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    queueSharpZoom(() => beginSharpZoom(tabId, Number(msg.ratio))).then(sendResponse);
    return true;
  }
  if (msg.type === "GLYPH_ZOOM_END" && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    queueSharpZoom(() => endSharpZoom(tabId, Number(msg.id) || 0, msg.zoom || null)).then(sendResponse);
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
  if (msg.type === "GLYPH_SNIP_QUOTA") {
    readWfiUsage().then(sendResponse);
    return true;
  }
  if (msg.type === "GLYPH_IDENTIFY") {
    identifySnip(msg.image, msg.fallbackImage, {
      detectText: msg.detectText === true,
      imageUrl: typeof msg.imageUrl === "string" ? msg.imageUrl : "",
    }).then(sendResponse);
    return true;
  }
  if (msg.type === "GLYPH_FETCH_IMAGE") {
    fetchImageForIdentify(msg.url).then(sendResponse);
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

const WFI_URL = "https://www.whatfontis.com/api2/index.php";
const WFI_LIMIT = 4;
const WFI_SNIP_LIMIT = 20;
const WFI_USAGE_KEY = "wfiSnipUsage";
let wfiUsageChain = Promise.resolve();

// WhatFontIs daily quota resets at 00:00 UTC.
function wfiPeriod(now = Date.now()) {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return { day: new Date(start).toISOString().slice(0, 10), resetAt: start + 24 * 60 * 60 * 1000 };
}

function withWfiUsage(task) {
  const run = wfiUsageChain.then(task, task);
  wfiUsageChain = run.then(() => {}, () => {});
  return run;
}

async function readWfiUsage(now = Date.now()) {
  const period = wfiPeriod(now);
  const stored = await chrome.storage.local.get(WFI_USAGE_KEY);
  const usage = stored[WFI_USAGE_KEY];
  const count = usage && usage.day === period.day ? Math.max(0, Number(usage.count) || 0) : 0;
  return {
    count,
    limit: WFI_SNIP_LIMIT,
    resetAt: period.resetAt,
    limited: count >= WFI_SNIP_LIMIT,
  };
}

async function writeWfiCount(count, now = Date.now()) {
  const period = wfiPeriod(now);
  const next = Math.max(0, count);
  await chrome.storage.local.set({ [WFI_USAGE_KEY]: { day: period.day, count: next } });
  return {
    count: next,
    limit: WFI_SNIP_LIMIT,
    resetAt: period.resetAt,
    limited: next >= WFI_SNIP_LIMIT,
  };
}

function matchFamilyName(value) {
  const name = String(value || "").replace(/["']/g, "").replace(/\s+/g, " ").trim();
  if (!name || FONT_CATEGORY.test(name)) return "";
  return name;
}

function whatFontIsPage(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return "";
    if (url.hostname !== "www.whatfontis.com" && url.hostname !== "whatfontis.com") return "";
    return url.href;
  } catch (err) {
    return "";
  }
}

function wfiErrorFrom(status, body) {
  const text = String(body || "").toLowerCase();
  if (status === 409) return "wfi_unauthorized";
  if (status === 402 || status === 429) return "wfi_quota";
  // A crop with no letters is HTTP 420 and this body. Not an outage.
  if (text.includes("invalid response from ai")) return "no_font";
  if (status === 420 || status === 503 || status >= 500) return "wfi_down";
  if (status === 422) {
    if (text.includes("mysql") || text.includes("server error")) return "wfi_down";
    if (text.includes("size") || text.includes("large") || text.includes("type")) return "wfi_image";
    return "no_chars";
  }
  return "wfi_failed";
}

function parseWfiMatches(parsed) {
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.results) ? parsed.results : null);
  if (!list) return null;
  const fonts = [];
  const seen = new Set();
  for (const item of list) {
    const font = matchFamilyName(item && item.title);
    if (!font) continue;
    const key = font.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    fonts.push({
      font,
      matchUrl: whatFontIsPage(item && item.url),
      license: item && (item.type === "Free" || item.type === "Commercial") ? item.type : "",
    });
    if (fonts.length === WFI_LIMIT) break;
  }
  if (!fonts.length) return null;
  const [primary, ...rest] = fonts;
  primary.similars = rest.map((face) => face.font);
  return { fonts: [primary], engine: "whatfontis" };
}

async function identifyWithWhatFontIs(dataUrl, options) {
  return withWfiUsage(() => identifyWithWhatFontIsUnlocked(dataUrl, options));
}

async function identifyWithWhatFontIsFromUrl(url) {
  return withWfiUsage(() => identifyWithWhatFontIsFromUrlUnlocked(url));
}

async function identifyWithWhatFontIsUnlocked(dataUrl, options) {
  const image = splitDataUrl(dataUrl);
  if (!image) return { error: "bad_image" };
  // Same envelope the WhatFontIs clients post as multipart field "file".
  // A snip crop is already the text, so skip their text-box search.
  // A whole picture still needs that search.
  const info = {
    urlimagebase64: image.data,
    limit: WFI_LIMIT,
  };
  if (!options || !options.detectText) info.NOTTEXTBOXSDETECTION = 1;
  return postWhatFontIs(info, true);
}

function whatFontIsImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    return url.href;
  } catch (err) {
    return "";
  }
}

async function identifyWithWhatFontIsFromUrlUnlocked(raw) {
  const url = whatFontIsImageUrl(raw);
  if (!url) return { error: "bad_image" };
  return postWhatFontIs({
    urlimage: url,
    NOTTEXTBOXSDETECTION: 0,
    limit: WFI_LIMIT,
  }, false);
}

async function postWhatFontIs(info, base64) {
  const usage = await readWfiUsage();
  if (usage.limited) return { error: "snip_limit", resetAt: usage.resetAt };
  const key = (typeof WFI_API_KEY === "string" ? WFI_API_KEY : "").trim();
  if (!key) return { error: "no_wfi_key" };
  const envelope = {
    FONT: {
      API_KEY: key,
      BASE64: base64 ? 1 : 0,
      WANT_QUOTA: 1,
      INFO: info,
    },
  };
  const form = new FormData();
  form.append("file", JSON.stringify(envelope));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let resp;
  try {
    resp = await fetch(WFI_URL, { method: "POST", body: form, signal: ctrl.signal });
  } catch (err) {
    return { error: "wfi_network" };
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await resp.text();
  if (wfiErrorFrom(resp.status, bodyText) === "wfi_quota") {
    const exhausted = await writeWfiCount(WFI_SNIP_LIMIT);
    return { error: "snip_limit", resetAt: exhausted.resetAt };
  }
  await writeWfiCount(usage.count + 1);
  if (!resp.ok) return { error: wfiErrorFrom(resp.status, bodyText) };

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    return { error: "wfi_failed" };
  }
  return parseWfiMatches(parsed) || { error: "no_chars" };
}

const IMAGE_FETCH_MAX = 18 * 1024 * 1024;

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
}

async function dataUrlFromFetchedImage(blob) {
  if (!blob || !blob.size || blob.size > IMAGE_FETCH_MAX) return "";
  const type = blob.type || "";
  if (type && !type.startsWith("image/")) return "";
  try {
    const bitmap = await createImageBitmap(blob);
    const maxLong = 2000;
    const scale = Math.min(1, maxLong / Math.max(bitmap.width, bitmap.height, 1));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const outType = type === "image/jpeg" ? "image/jpeg" : "image/png";
    const out = await canvas.convertToBlob({ type: outType, quality: 0.9 });
    return await blobToDataUrl(out);
  } catch (err) {
    if (blob.size > 4 * 1024 * 1024) return "";
    return await blobToDataUrl(blob);
  }
}

async function fetchImageForIdentify(raw) {
  const url = whatFontIsImageUrl(raw);
  if (!url) return { dataUrl: "" };
  let allowed = false;
  try {
    allowed = await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
  } catch (err) {
    allowed = false;
  }
  if (!allowed) return { dataUrl: "" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(url, { credentials: "include", signal: ctrl.signal });
    if (!resp.ok) return { dataUrl: "" };
    const dataUrl = await dataUrlFromFetchedImage(await resp.blob());
    return { dataUrl };
  } catch (err) {
    return { dataUrl: "" };
  } finally {
    clearTimeout(timer);
  }
}

function claudeSnipSelected(id) {
  return Object.prototype.hasOwnProperty.call(IDENTIFY_MODELS, id);
}

async function identifySnip(image, fallbackImage, options) {
  const { snipModel } = await chrome.storage.local.get("snipModel");
  const detectText = !!(options && options.detectText);
  const imageUrl = options && typeof options.imageUrl === "string" ? options.imageUrl : "";
  const matched = image
    ? await identifyWithWhatFontIs(image, { detectText })
    : imageUrl
      ? await identifyWithWhatFontIsFromUrl(imageUrl)
      : { error: "bad_image" };
  if (!matched.error) return matched;
  if (!claudeSnipSelected(snipModel) || matched.error !== "no_chars" || !fallbackImage) return matched;
  const guessed = await identifyWithClaude(fallbackImage);
  if (guessed.error === "no_key") return matched;
  if (guessed.error) return guessed;
  return { ...guessed, engine: "claude", fallback: true };
}

const RESTRICTED_URL_PREFIXES = ["chrome://", "chrome-extension://", "edge://", "about:", "https://chrome.google.com/webstore", "https://chromewebstore.google.com"];

function isRestricted(url) {
  return !url || RESTRICTED_URL_PREFIXES.some((p) => url.startsWith(p));
}

// The toolbar button normally injects panel.js, which shows popup.html in a
// transparent in-page iframe (Chrome's native popup cannot have a transparent
// backdrop, so its corners can't be rounded). On pages that can't be scripted
// a small native popup explains that Glyph can't run there, enabled per tab.
async function showUnavailablePopup(tabId) {
  await chrome.action.setPopup({ tabId, popup: "unavailable.html" });
  try {
    await chrome.action.openPopup();
  } catch (err) {
    // Older Chrome: the popup will show on the next click instead.
  }
}

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
  await showUnavailablePopup(tab.id);
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
  if (isRestricted(tab.url)) {
    await showUnavailablePopup(tab.id);
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
  } catch (err) {
    await showUnavailablePopup(tab.id);
    return;
  }
  if (mode === "snip") {
    const usage = await readWfiUsage();
    if (usage.limited) {
      chrome.tabs.sendMessage(tab.id, { type: "GLYPH_SNIP_LIMIT", resetAt: usage.resetAt });
      return;
    }
  }
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
