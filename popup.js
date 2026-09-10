const menu = document.getElementById("menu-main");
const settings = document.getElementById("panel-settings");
const history = document.getElementById("panel-history");
const historyList = document.getElementById("history-list");
const apiKeyInput = document.getElementById("api-key");
const saveNote = document.getElementById("save-note");
const btnTheme = document.getElementById("btn-theme");
const errorNote = document.getElementById("error-note");

// popup.html is shown either as Chrome's native popup or inside the
// transparent in-page iframe created by panel.js.
const inPanel = window.parent !== window;

function closePopup() {
  if (inPanel) window.parent.postMessage({ type: "GLYPH_PANEL_CLOSE" }, "*");
  else window.close();
}

function showError(text) {
  if (!errorNote) return;
  errorNote.textContent = text;
  errorNote.classList.remove("hidden");
  setTimeout(() => errorNote.classList.add("hidden"), 3000);
}

if (inPanel) {
  const root = document.documentElement;
  const card = document.querySelector(".popup");
  root.setAttribute("data-panel", "");

  const DEFAULT_WIDTH = 260;
  let naturalHeight = 0;

  const captureNaturalHeight = () => {
    naturalHeight = Math.max(1, Math.ceil(card.getBoundingClientRect().height));
  };

  // Scale menu controls up with the panel, but never below the default size.
  const updateUiScale = () => {
    if (!root.hasAttribute("data-panel-fill") || !naturalHeight) {
      root.style.setProperty("--ui-scale", "1");
      return;
    }
    const scale = Math.max(
      1,
      Math.min(window.innerWidth / DEFAULT_WIDTH, window.innerHeight / naturalHeight)
    );
    root.style.setProperty("--ui-scale", String(scale));
  };

  // While the panel is auto-sized, report the content height so the frame can
  // follow it. Once the user has dragged the panel to a size, the card fills
  // the frame instead ("fill" mode) and reporting stops.
  const sendSize = () => {
    if (root.hasAttribute("data-panel-fill")) return;
    captureNaturalHeight();
    window.parent.postMessage({ type: "GLYPH_PANEL_SIZE", height: naturalHeight }, "*");
  };
  new ResizeObserver(() => {
    sendSize();
    updateUiScale();
  }).observe(card);
  window.addEventListener("resize", updateUiScale);
  window.addEventListener("load", () => {
    sendSize();
    updateUiScale();
  });
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== "GLYPH_PANEL_MODE") return;
    const wantFill = !!e.data.fill;
    if (!wantFill || !naturalHeight) {
      root.removeAttribute("data-panel-fill");
      root.style.setProperty("--ui-scale", "1");
      captureNaturalHeight();
    }
    root.toggleAttribute("data-panel-fill", wantFill);
    updateUiScale();
    sendSize();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopup();
  });
  window.parent.postMessage({ type: "GLYPH_PANEL_READY" }, "*");
  sendSize();
  updateUiScale();
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

(async () => {
  const { theme } = await chrome.storage.local.get("theme");
  applyTheme(theme);
})();

if (btnTheme) {
  btnTheme.addEventListener("click", async () => {
    const current = document.documentElement.getAttribute("data-theme");
    const isDark = current
      ? current === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = isDark ? "light" : "dark";
    applyTheme(next);
    await chrome.storage.local.set({ theme: next });
  });
}

const RESTRICTED_URL_PREFIXES = ["chrome://", "chrome-extension://", "edge://", "about:", "https://chrome.google.com/webstore"];

async function injectAndStart(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (!tab.url || RESTRICTED_URL_PREFIXES.some((p) => tab.url.startsWith(p))) {
    showError("Glyph can't run on this page. Try it on a regular website.");
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content.css"],
    });
    chrome.tabs.sendMessage(tab.id, { type: "GLYPH_START", mode });
    closePopup();
  } catch (err) {
    showError("Glyph can't run on this page. Try it on a regular website.");
  }
}

document.getElementById("btn-snip").addEventListener("click", () => injectAndStart("snip"));
document.getElementById("btn-highlight").addEventListener("click", () => injectAndStart("highlight"));

document.getElementById("btn-website").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://h4l-git.github.io/Glyph/" });
  closePopup();
});

document.getElementById("btn-rate").addEventListener("click", () => {
  chrome.tabs.create({
    url: "https://chromewebstore.google.com/detail/glyph/ibioikhlalicigjadkpjfcjhdlkeegnj/reviews",
  });
  closePopup();
});

const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><rect x="5.5" y="3.5" width="7" height="9" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 5.5h1.8v8.2c0 .7.6 1.3 1.3 1.3h5.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><rect x="7.2" y="1.5" width="3.6" height="2.4" rx="0.7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3.5 8.5 6.6 11.5 12.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function makeHistoryProp(prop) {
  const value = typeof prop === "string" ? prop : prop.value;
  const copyValue = typeof prop === "string" ? value : (prop.copy != null ? String(prop.copy) : value);
  const wrap = document.createElement("span");
  wrap.className = "history-prop";
  wrap.appendChild(document.createTextNode(value));

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "history-copy";
  btn.title = "Copy";
  btn.setAttribute("aria-label", `Copy ${copyValue}`);
  btn.innerHTML = COPY_ICON;

  const flashCopied = () => {
    btn.innerHTML = CHECK_ICON;
    btn.classList.add("history-copy--done");
    btn.title = "Copied";
    clearTimeout(btn._glyphCopyTimer);
    btn._glyphCopyTimer = setTimeout(() => {
      btn.innerHTML = COPY_ICON;
      btn.classList.remove("history-copy--done");
      btn.title = "Copy";
    }, 1200);
  };

  const onCopy = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (await copyText(copyValue)) flashCopied();
  };

  wrap.addEventListener("click", onCopy);
  wrap.appendChild(btn);
  return wrap;
}

const HISTORY_KEY = "fontHistory";
const HISTORY_LIMIT = 10;
const SAVED_KEY = "savedFonts";
const SOURCE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7"/><path d="M21 3 11 13"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
const GFONTS_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2.6 13 8 3 13.4 13" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.7 9.3h6.6" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>';
const BOOKMARK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
const DELETE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
const PREVIEW_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const GENERIC_FONT_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
  "emoji", "math", "fangsong", "inherit", "initial", "unset", "revert",
  "revert-layer", "caption", "icon", "menu", "message-box", "small-caption",
  "status-bar", "blinkmacsystemfont",
]);

const savedList = document.getElementById("saved-list");
const savedHeading = document.getElementById("saved-heading");
const recentHeading = document.getElementById("recent-heading");
const btnFoldSaved = document.getElementById("btn-fold-saved");
const btnFoldRecent = document.getElementById("btn-fold-recent");
const FOLD_KEY = "historyFold";
let historyEntries = [];
let savedEntries = [];
let foldState = { saved: false, recent: false };
let openPreviewId = null;

function fillHistoryCard(body, content) {
  body.replaceChildren();
  const props = content.properties || [];
  const styles = content.styles || [];
  props.forEach((prop, i) => {
    if (prop.before) body.appendChild(document.createTextNode(prop.before));
    else if (i > 0 && !prop.adjacent) body.appendChild(document.createTextNode(" \u00b7 "));
    body.appendChild(makeHistoryProp(prop));
    if (i === 0 && styles.length) {
      const group = document.createElement("span");
      group.className = "history-marks";
      styles.forEach((style) => {
        const mark = document.createElement("span");
        mark.className = "history-mark history-mark--" + style.kind;
        mark.textContent = style.letter;
        mark.title = style.title;
        group.appendChild(mark);
      });
      body.appendChild(group);
    }
    if (prop.after) body.appendChild(document.createTextNode(prop.after));
  });
  if (content.swatchColor) {
    const swatch = document.createElement("span");
    swatch.className = "history-swatch";
    swatch.style.background = content.swatchColor;
    swatch.title = "Text colour";
    body.appendChild(swatch);
  }
}

function pageHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (err) {
    return "";
  }
}

function pageLinkLabel(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return host + path;
  } catch (err) {
    return pageHost(url) || "Open page";
  }
}

function isOpenableUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch (err) {
    return false;
  }
}

function openExternalUrl(url) {
  if (chrome?.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, "_blank", "noopener");
  closePopup();
}

function fontNameFromEntry(entry) {
  const props = entry?.properties || [];
  const first = props[0];
  if (first == null) return "";
  return String(typeof first === "string" ? first : first.value || "").trim();
}

function googleFontsFamilySlug(name) {
  const family = String(name || "").replace(/["']/g, "").trim();
  if (!family || family.toLowerCase() === "unknown") return "";
  if (GENERIC_FONT_FAMILIES.has(family.toLowerCase())) return "";
  if (family.startsWith(".") || family.startsWith("-")) return "";
  return family.split(/[\s_]+/).filter(Boolean).map(encodeURIComponent).join("+");
}

function requestFontSource(family) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.sendMessage) return resolve(null);
      chrome.runtime.sendMessage({ type: "GLYPH_FONT_SOURCE", family }, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res && res.url ? res : null);
      });
    } catch (err) {
      resolve(null);
    }
  });
}

function attachFontSourceLink(card, family) {
  if (!googleFontsFamilySlug(family)) return;
  requestFontSource(family).then((source) => {
    if (!source?.url || !card.isConnected) return;
    if (card.querySelector(".history-gfonts")) return;
    const link = makeHistoryLink(
      "history-gfonts",
      GFONTS_ICON,
      source.label || "Font source",
      `View ${family} on ${source.label}`,
      () => openExternalUrl(source.url)
    );
    const pageLink = card.querySelector(".history-source");
    if (pageLink) card.insertBefore(link, pageLink);
    else card.appendChild(link);
  });
}

function isSaved(id) {
  return savedEntries.some((entry) => entry.id === id);
}

async function persistSaved() {
  if (!chrome?.storage?.local) return;
  await chrome.storage.local.set({ [SAVED_KEY]: savedEntries });
}

async function persistHistory() {
  if (!chrome?.storage?.local) return;
  await chrome.storage.local.set({ [HISTORY_KEY]: historyEntries.slice(0, HISTORY_LIMIT) });
}

async function removeFromRecent(entry) {
  historyEntries = historyEntries.filter((item) => {
    if (entry.id != null) return item.id !== entry.id;
    return item !== entry;
  });
  try {
    await persistHistory();
  } catch (err) {
    // Keep the in-memory list even if storage is unavailable.
  }
  renderHistoryPage();
}

async function toggleSave(entry) {
  if (entry.id == null) entry.id = Date.now();
  if (isSaved(entry.id)) {
    savedEntries = savedEntries.filter((item) => item.id !== entry.id);
  } else {
    savedEntries = [{ ...entry }, ...savedEntries];
  }
  try {
    await persistSaved();
  } catch (err) {
    // Keep the in-memory list even if storage is unavailable.
  }
  renderHistoryPage();
}

function makeHistoryLink(className, icon, label, title, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "history-link " + className;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = icon;
  const text = document.createElement("span");
  text.className = "history-link-label";
  text.textContent = label;
  btn.appendChild(text);
  btn.addEventListener("click", onClick);
  return btn;
}

function makeHistoryCard(entry, options = {}) {
  const card = document.createElement("div");
  card.className = "history-card";

  const body = document.createElement("div");
  body.className = "history-card-body";
  fillHistoryCard(body, entry);
  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "history-actions";

  const previewBtn = document.createElement("button");
  previewBtn.type = "button";
  previewBtn.className = "history-action history-preview";
  previewBtn.title = "Preview font";
  previewBtn.setAttribute("aria-label", "Preview font");
  previewBtn.setAttribute("aria-expanded", openPreviewId === entry.id ? "true" : "false");
  previewBtn.innerHTML = PREVIEW_ICON;
  previewBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePreview(entry, previewBtn);
  });
  actions.appendChild(previewBtn);

  if (options.allowDelete) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "history-action history-delete";
    deleteBtn.title = "Remove from recent";
    deleteBtn.setAttribute("aria-label", "Remove from recent");
    deleteBtn.innerHTML = DELETE_ICON;
    deleteBtn.addEventListener("click", () => removeFromRecent(entry));
    actions.appendChild(deleteBtn);
  }

  const saved = isSaved(entry.id);
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "history-action history-save" + (saved ? " history-save--on" : "");
  saveBtn.title = saved ? "Remove from saved" : "Save font";
  saveBtn.setAttribute("aria-label", saved ? "Remove from saved" : "Save font");
  saveBtn.setAttribute("aria-pressed", saved ? "true" : "false");
  saveBtn.innerHTML = BOOKMARK_ICON;
  saveBtn.addEventListener("click", () => toggleSave(entry));
  actions.appendChild(saveBtn);
  card.appendChild(actions);
  if (actions.childElementCount === 2) card.classList.add("history-card--actions-2");
  if (actions.childElementCount >= 3) card.classList.add("history-card--actions-3");

  const family = fontNameFromEntry(entry);
  attachFontSourceLink(card, family);

  if (isOpenableUrl(entry.pageUrl)) {
    const label = pageLinkLabel(entry.pageUrl);
    const title = entry.pageTitle ? `${entry.pageTitle}\n${entry.pageUrl}` : entry.pageUrl;
    card.appendChild(makeHistoryLink(
      "history-source",
      SOURCE_ICON,
      label,
      title,
      () => openExternalUrl(entry.pageUrl)
    ));
  }

  return card;
}

function applyFoldState() {
  savedList.classList.toggle("hidden", foldState.saved);
  historyList.classList.toggle("hidden", foldState.recent);
  if (savedHeading) {
    savedHeading.textContent = `Saved fonts (${savedEntries.length})`;
  }
  if (recentHeading) {
    recentHeading.textContent = `Recent fonts (${Math.min(historyEntries.length, HISTORY_LIMIT)})`;
  }
  const setFoldBtn = (btn, collapsed, label) => {
    if (!btn) return;
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const action = collapsed ? "Expand" : "Minimise";
    btn.title = `${action} ${label}`;
    btn.setAttribute("aria-label", `${action} ${label}`);
  };
  setFoldBtn(btnFoldSaved, foldState.saved, "saved fonts");
  setFoldBtn(btnFoldRecent, foldState.recent, "recent fonts");
}

async function persistFoldState() {
  if (!chrome?.storage?.local) return;
  await chrome.storage.local.set({ [FOLD_KEY]: foldState });
}

async function toggleFold(section) {
  foldState[section] = !foldState[section];
  applyFoldState();
  closePreview();
  try {
    await persistFoldState();
  } catch (err) {
    // Fold state is best-effort.
  }
}

function closePreview() {
  openPreviewId = null;
  const pop = document.getElementById("history-preview-pop");
  if (pop) pop.remove();
  document.querySelectorAll(".history-preview[aria-expanded='true']").forEach((btn) => {
    btn.setAttribute("aria-expanded", "false");
  });
  document.removeEventListener("mousedown", onPreviewPointerDown, true);
  document.removeEventListener("keydown", onPreviewKeyDown, true);
}

function onPreviewPointerDown(e) {
  const pop = document.getElementById("history-preview-pop");
  if (!pop) return;
  if (pop.contains(e.target) || e.target.closest(".history-preview")) return;
  closePreview();
}

function onPreviewKeyDown(e) {
  if (e.key === "Escape") closePreview();
}

const PREVIEW_PANGRAM = "The quick brown fox jumps over the lazy dog";
const PREVIEW_FONT_TIMEOUT_MS = 1600;
const googleFontStylesheets = new Map();

function isGenericFontFamily(name) {
  return GENERIC_FONT_FAMILIES.has(String(name || "").trim().toLowerCase());
}

function cssQuotedFamily(name) {
  const cleaned = String(name || "").replace(/["']/g, "").trim();
  if (!cleaned) return "";
  if (isGenericFontFamily(cleaned)) return cleaned;
  return `"${cleaned.replace(/\\/g, "\\\\")}"`;
}

function previewSampleText(entry) {
  const t = String(entry?.sampleText || "").replace(/\s+/g, " ").trim();
  return t || PREVIEW_PANGRAM;
}

function previewFontWeight(entry) {
  const styles = entry?.styles || [];
  if (styles.some((s) => s.kind === "bold")) return "700";
  const props = entry?.properties || [];
  for (let i = 1; i < props.length; i++) {
    const prop = props[i];
    const v = String(typeof prop === "string" ? prop : prop.value || "").trim().toLowerCase();
    if (v === "bold" || v === "bolder") return "700";
    if (v === "normal" || v === "lighter") return "400";
    if (/^[1-9]00$/.test(v)) return v;
  }
  return "400";
}

function previewFontSizePx(entry) {
  const props = entry?.properties || [];
  for (let i = 1; i < props.length; i++) {
    const prop = props[i];
    const v = String(typeof prop === "string" ? prop : prop.value || "").trim();
    const m = v.match(/^(-?[\d.]+)\s*(px|pt|em|rem)$/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = m[2].toLowerCase();
    let px = n;
    if (unit === "pt") px = n * (96 / 72);
    else if (unit === "em" || unit === "rem") px = n * 16;
    return Math.max(12, Math.min(32, px));
  }
  return 0;
}

function parseCssColorChannels(cssColor) {
  const s = String(cssColor || "").trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function previewSurfaceForColor(cssColor) {
  const rgb = parseCssColorChannels(cssColor);
  if (!rgb) return "";
  const lin = rgb.map((c) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return lum > 0.72 ? "#2a2a27" : "rgba(255,255,255,0.78)";
}

function previewFontSpec(family, weight, italic) {
  const quoted = cssQuotedFamily(family);
  if (!quoted) return "";
  return `${italic ? "italic" : "normal"} ${weight || "400"} 16px ${quoted}`;
}

function measureFamilyAvailable(family, sampleText) {
  const cleaned = String(family || "").replace(/["']/g, "").trim();
  if (!cleaned) return false;
  if (isGenericFontFamily(cleaned)) return true;
  const probe = "GlyphMmWw@IiLl 1234567890mmmmmmmmlli";
  const extra = String(sampleText || "").replace(/\s+/g, " ").trim().slice(0, 48);
  const testString = extra ? `${probe} ${extra}` : probe;
  const quoted = cssQuotedFamily(cleaned);
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;font-size:72px;line-height:normal;white-space:nowrap;";
  const bases = ["monospace", "serif", "sans-serif"];
  const pairs = bases.map((base) => {
    const fallback = document.createElement("span");
    fallback.style.fontFamily = base;
    fallback.textContent = testString;
    const candidate = document.createElement("span");
    candidate.style.fontFamily = `${quoted}, ${base}`;
    candidate.textContent = testString;
    host.append(fallback, candidate);
    return [fallback, candidate];
  });
  document.body.appendChild(host);
  let available = false;
  for (const [fallback, candidate] of pairs) {
    if (fallback.offsetWidth !== candidate.offsetWidth || fallback.offsetHeight !== candidate.offsetHeight) {
      available = true;
      break;
    }
  }
  host.remove();
  return available;
}

function fontIsLocallyAvailable(family, weight, italic, sampleText) {
  const cleaned = String(family || "").replace(/["']/g, "").trim();
  if (!cleaned || cleaned.toLowerCase() === "unknown") return false;
  if (isGenericFontFamily(cleaned)) return true;
  const spec = previewFontSpec(cleaned, weight, italic);
  try {
    if (document.fonts?.check && spec && document.fonts.check(spec) && measureFamilyAvailable(cleaned, sampleText)) {
      return true;
    }
  } catch (err) {
    // check() can throw on malformed names; measurement is the fallback.
  }
  return measureFamilyAvailable(cleaned, sampleText);
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        finish(value);
      },
      () => {
        clearTimeout(timer);
        finish(false);
      }
    );
  });
}

function googleFontsCssHref(family, weight, italic) {
  const slug = googleFontsFamilySlug(family);
  if (!slug) return "";
  const weights = new Set([400, 700]);
  const n = Number(weight);
  if (Number.isFinite(n) && n >= 100 && n <= 900) weights.add(n);
  const pairs = [];
  for (const w of [...weights].sort((a, b) => a - b)) {
    pairs.push(`0,${w}`);
    if (italic) pairs.push(`1,${w}`);
  }
  return `https://fonts.googleapis.com/css2?family=${slug}:ital,wght@${pairs.join(";")}&display=swap`;
}

function loadGoogleFontStylesheet(family, weight, italic) {
  const href = googleFontsCssHref(family, weight, italic);
  if (!href) return Promise.resolve(false);
  const key = href;
  if (googleFontStylesheets.has(key)) return googleFontStylesheets.get(key);
  const pending = new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.crossOrigin = "anonymous";
    link.addEventListener("load", () => resolve(true), { once: true });
    link.addEventListener("error", () => resolve(false), { once: true });
    document.head.appendChild(link);
  });
  googleFontStylesheets.set(key, pending);
  return pending;
}

async function ensurePreviewFont(entry) {
  const family = fontNameFromEntry(entry);
  const weight = previewFontWeight(entry);
  const italic = (entry?.styles || []).some((s) => s.kind === "italic");
  const sampleText = entry?.sampleText;
  if (fontIsLocallyAvailable(family, weight, italic, sampleText)) return true;
  const spec = previewFontSpec(family, weight, italic);
  if (spec && document.fonts?.load) {
    const loaded = await withTimeout(document.fonts.load(spec).then(() => true), PREVIEW_FONT_TIMEOUT_MS);
    if (loaded && fontIsLocallyAvailable(family, weight, italic, sampleText)) return true;
  }
  const cssOk = await withTimeout(loadGoogleFontStylesheet(family, weight, italic), PREVIEW_FONT_TIMEOUT_MS);
  if (!cssOk) return false;
  if (spec && document.fonts?.load) {
    await withTimeout(document.fonts.load(spec).then(() => true), PREVIEW_FONT_TIMEOUT_MS);
  }
  try {
    if (document.fonts?.ready) await withTimeout(document.fonts.ready.then(() => true), 800);
  } catch (err) {
    // fonts.ready is best-effort.
  }
  return fontIsLocallyAvailable(family, weight, italic, sampleText);
}

function previewSampleStyle(entry, el) {
  const family = fontNameFromEntry(entry);
  const quoted = cssQuotedFamily(family);
  if (quoted) el.style.fontFamily = quoted;
  const styles = entry.styles || [];
  if (styles.some((s) => s.kind === "italic")) el.style.fontStyle = "italic";
  el.style.fontWeight = previewFontWeight(entry);
  if (styles.some((s) => s.kind === "underline")) el.style.textDecoration = "underline";
  const sizePx = previewFontSizePx(entry);
  if (sizePx) el.style.fontSize = `${Math.round(sizePx * 10) / 10}px`;
  if (entry.swatchColor) {
    el.style.color = entry.swatchColor;
    const surface = previewSurfaceForColor(entry.swatchColor);
    if (surface) el.style.background = surface;
  }
}

function positionPreview(pop, anchor) {
  const btnRect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const margin = 8;
  let left = btnRect.right - popRect.width;
  left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));
  let top = btnRect.bottom + 6;
  if (top + popRect.height > window.innerHeight - margin) {
    top = Math.max(margin, btnRect.top - popRect.height - 6);
  }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function fillLivePreview(pop, entry) {
  pop.replaceChildren();
  pop.classList.remove("history-preview-pop--shot");
  const sample = document.createElement("p");
  sample.className = "history-preview-sample";
  sample.textContent = previewSampleText(entry);
  previewSampleStyle(entry, sample);
  pop.appendChild(sample);
}

function fillShotPreview(pop, entry, anchor) {
  pop.replaceChildren();
  pop.classList.add("history-preview-pop--shot");
  const img = document.createElement("img");
  img.src = entry.preview;
  img.alt = "Captured font sample";
  img.addEventListener("load", () => positionPreview(pop, anchor));
  pop.appendChild(img);
}

function fillUnavailablePreview(pop, entry) {
  pop.replaceChildren();
  pop.classList.remove("history-preview-pop--shot");
  const note = document.createElement("p");
  note.className = "history-preview-note";
  const family = fontNameFromEntry(entry);
  note.textContent = family
    ? `${family} isn't available to render here.`
    : "This typeface isn’t available to render here.";
  pop.appendChild(note);
}

function showPreview(entry, anchor) {
  closePreview();
  openPreviewId = entry.id;
  anchor.setAttribute("aria-expanded", "true");

  const pop = document.createElement("div");
  pop.id = "history-preview-pop";
  pop.className = "history-preview-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Font preview");

  const family = fontNameFromEntry(entry);
  const weight = previewFontWeight(entry);
  const italic = (entry.styles || []).some((s) => s.kind === "italic");
  const localOk = fontIsLocallyAvailable(family, weight, italic, entry.sampleText);

  if (localOk) {
    fillLivePreview(pop, entry);
  } else if (entry.preview) {
    fillShotPreview(pop, entry, anchor);
  } else {
    pop.classList.add("history-preview-pop--pending");
  }

  document.querySelector(".popup").appendChild(pop);
  positionPreview(pop, anchor);

  const previewToken = entry.id;
  requestAnimationFrame(() => {
    if (openPreviewId !== previewToken) return;
    document.addEventListener("mousedown", onPreviewPointerDown, true);
    document.addEventListener("keydown", onPreviewKeyDown, true);
  });

  if (localOk) return;

  ensurePreviewFont(entry).then((ok) => {
    if (openPreviewId !== previewToken) return;
    pop.classList.remove("history-preview-pop--pending");
    if (ok) {
      fillLivePreview(pop, entry);
      positionPreview(pop, anchor);
      return;
    }
    if (entry.preview) {
      if (!pop.querySelector("img")) {
        fillShotPreview(pop, entry, anchor);
        positionPreview(pop, anchor);
      }
      return;
    }
    fillUnavailablePreview(pop, entry);
    positionPreview(pop, anchor);
  });
}

function togglePreview(entry, anchor) {
  if (openPreviewId != null && openPreviewId === entry.id) {
    closePreview();
    return;
  }
  showPreview(entry, anchor);
}

function renderEntryList(list, entries, emptyText, options) {
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = emptyText;
    list.appendChild(empty);
    return;
  }
  entries.forEach((entry) => list.appendChild(makeHistoryCard(entry, options)));
}

function renderHistoryPage() {
  closePreview();
  renderEntryList(savedList, savedEntries, "Save a font from Recent to keep it here.");
  renderEntryList(
    historyList,
    historyEntries.slice(0, HISTORY_LIMIT),
    "Fonts you identify will show up here.",
    { allowDelete: true }
  );
  applyFoldState();
}

async function loadHistoryPage() {
  historyEntries = [];
  savedEntries = [];
  foldState = { saved: false, recent: false };
  try {
    const data = await chrome.storage.local.get([HISTORY_KEY, SAVED_KEY, FOLD_KEY]);
    if (Array.isArray(data[HISTORY_KEY])) historyEntries = data[HISTORY_KEY];
    if (Array.isArray(data[SAVED_KEY])) savedEntries = data[SAVED_KEY];
    if (data[FOLD_KEY] && typeof data[FOLD_KEY] === "object") {
      foldState = {
        saved: !!data[FOLD_KEY].saved,
        recent: !!data[FOLD_KEY].recent,
      };
    }
  } catch (err) {
    historyEntries = [];
    savedEntries = [];
  }
  renderHistoryPage();
}

document.getElementById("btn-history").addEventListener("click", async () => {
  menu.classList.add("hidden");
  settings.classList.add("hidden");
  history.classList.remove("hidden");
  document.querySelector(".popup").scrollTop = 0;
  await loadHistoryPage();
});

if (btnFoldSaved) btnFoldSaved.addEventListener("click", () => toggleFold("saved"));
if (btnFoldRecent) btnFoldRecent.addEventListener("click", () => toggleFold("recent"));

document.getElementById("btn-history-back").addEventListener("click", () => {
  closePreview();
  history.classList.add("hidden");
  settings.classList.add("hidden");
  menu.classList.remove("hidden");
  document.querySelector(".popup").scrollTop = 0;
});

const SELECTION_CARD_KEY = "selectionCard";
const SELECTION_ORIGINS = ["http://*/*", "https://*/*"];
const selectionCardToggle = document.getElementById("selection-card");

async function selectionCardAllowed() {
  try {
    return await chrome.permissions.contains({ origins: SELECTION_ORIGINS });
  } catch (err) {
    return false;
  }
}

async function syncSelectionCardToggle() {
  if (!selectionCardToggle) return;
  const data = await chrome.storage.local.get(SELECTION_CARD_KEY);
  const wanted = !!data[SELECTION_CARD_KEY];
  const allowed = wanted ? await selectionCardAllowed() : false;
  selectionCardToggle.checked = wanted && allowed;
  if (wanted && !allowed) {
    await chrome.storage.local.set({ [SELECTION_CARD_KEY]: false });
  }
}

async function setSelectionCardEnabled(enabled) {
  if (enabled) {
    const granted = await chrome.permissions.request({ origins: SELECTION_ORIGINS });
    if (!granted) {
      if (selectionCardToggle) selectionCardToggle.checked = false;
      return;
    }
  }
  await chrome.storage.local.set({ [SELECTION_CARD_KEY]: enabled });
  try {
    await chrome.runtime.sendMessage({ type: "GLYPH_SELECTION_CARD_SET", enabled });
  } catch (err) {
    // Background will pick the setting up from storage if the message fails.
  }
}

if (selectionCardToggle) {
  selectionCardToggle.addEventListener("change", () => {
    setSelectionCardEnabled(selectionCardToggle.checked);
  });
}

document.getElementById("btn-settings").addEventListener("click", async () => {
  closePreview();
  menu.classList.add("hidden");
  history.classList.add("hidden");
  settings.classList.remove("hidden");
  document.querySelector(".popup").scrollTop = 0;
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (apiKey) apiKeyInput.value = apiKey;
  await syncSelectionCardToggle();
  const commands = await chrome.commands.getAll();
  const snip = commands.find((c) => c.name === "start-snip");
  document.getElementById("shortcut-display").textContent =
    snip?.shortcut || "Not set";
});

document.getElementById("btn-shortcut").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  closePopup();
});

document.getElementById("btn-create-api-key").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://console.anthropic.com/settings/keys" });
  closePopup();
});

document.getElementById("btn-back").addEventListener("click", () => {
  settings.classList.add("hidden");
  menu.classList.remove("hidden");
  saveNote.classList.add("hidden");
  document.querySelector(".popup").scrollTop = 0;
});

document.getElementById("btn-save").addEventListener("click", async () => {
  await chrome.storage.local.set({ apiKey: apiKeyInput.value.trim() });
  saveNote.classList.remove("hidden");
  setTimeout(() => saveNote.classList.add("hidden"), 1500);
});
