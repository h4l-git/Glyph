(() => {
  if (window.__glyphLoaded) return;
  window.__glyphLoaded = true;

  let overlay = null;
  let mode = null;
  let darkTheme = false; // follows the popup's light/dark setting
  let selectionCardOn = false;
  let selectionListening = false;
  let selectingWithPointer = false;
  let lastSelectionFingerprint = "";
  let selectionRememberTimer = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "GLYPH_START") {
      cleanup();
      mode = msg.mode;
      loadTheme();
      chrome.runtime.sendMessage({ type: "GLYPH_MODE_CHANGED", active: true, mode });
      if (mode === "snip") startSnip();
      if (mode === "highlight") startHighlight();
    }
  });

  // The popup stores an explicit "light"/"dark" choice; otherwise follow the system.
  async function loadTheme() {
    try {
      const { theme } = await chrome.storage.local.get("theme");
      darkTheme = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (err) {
      darkTheme = false;
    }
    if (card) card.classList.toggle("glyph-card--dark", darkTheme);
  }

  function cleanup() {
    document.querySelectorAll(".glyph-overlay, .glyph-box, .glyph-card, .glyph-hl-outline").forEach((n) => n.remove());
    document.removeEventListener("mousemove", onHighlightMove, true);
    document.removeEventListener("click", onHighlightClick, true);
    document.removeEventListener("keydown", onEsc, true);
    document.removeEventListener("contextmenu", onRightClick, true);
    document.documentElement.classList.remove("glyph-hl-mode");
    overlay = null;
    card = null;
    hlOutline = null;
    hlLockedOutline = null;
    hlLockedRect = null;
    if (mode) {
      chrome.runtime.sendMessage({ type: "GLYPH_MODE_CHANGED", active: false });
      mode = null;
    }
  }

  function onEsc(e) {
    if (e.key === "Escape") cleanup();
  }

  // Right-click ends the active tool (and swallows the browser context menu).
  function onRightClick(e) {
    if (!mode) return;
    e.preventDefault();
    e.stopPropagation();
    cleanup();
  }

  /* ---------- Snip tool ---------- */

  function startSnip() {
    overlay = document.createElement("div");
    overlay.className = "glyph-overlay";
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onEsc, true);
    document.addEventListener("contextmenu", onRightClick, true);

    let startX = 0, startY = 0, box = null;

    overlay.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return; // right-click is handled by onRightClick
      startX = e.clientX;
      startY = e.clientY;
      if (box) box.remove();
      if (card) {
        card.remove();
        card = null;
      }
      box = document.createElement("div");
      box.className = "glyph-box";
      overlay.appendChild(box);
      positionBox(box, startX, startY, startX, startY);

      const onMove = (ev) => positionBox(box, startX, startY, ev.clientX, ev.clientY);
      const onUp = async (ev) => {
        overlay.removeEventListener("mousemove", onMove);
        overlay.removeEventListener("mouseup", onUp);
        const rect = {
          x: Math.min(startX, ev.clientX),
          y: Math.min(startY, ev.clientY),
          w: Math.abs(ev.clientX - startX),
          h: Math.abs(ev.clientY - startY),
        };
        // Keep the green box around a successful snip until dismiss.
        if (rect.w > 8 && rect.h > 8) {
          positionBox(box, startX, startY, ev.clientX, ev.clientY);
          captureAndIdentify(rect);
        } else {
          box.remove();
          box = null;
        }
      };
      overlay.addEventListener("mousemove", onMove);
      overlay.addEventListener("mouseup", onUp);
    });
  }

  function positionBox(box, x1, y1, x2, y2) {
    box.style.left = Math.min(x1, x2) + "px";
    box.style.top = Math.min(y1, y2) + "px";
    box.style.width = Math.abs(x2 - x1) + "px";
    box.style.height = Math.abs(y2 - y1) + "px";
  }

  // Hide Glyph chrome while the tab is captured so the tint/outlines aren't in the shot.
  // Result cards are left alone when hideCards is false — toggling a card that is
  // already on screen makes it blink. Calls are serialized so one capture cannot
  // restore chrome while another is still waiting for the hidden frame.
  let captureQueue = Promise.resolve();

  function captureScreen(options) {
    const job = captureQueue.then(() => captureScreenNow(options));
    captureQueue = job.then(() => {}, () => {});
    return job;
  }

  async function captureScreenNow(options) {
    const hideCards = !options || options.hideCards !== false;
    const hideOutlines = !options || options.hideOutlines !== false;
    const parts = [".glyph-overlay", ".glyph-box"];
    if (hideCards) parts.push(".glyph-card");
    if (hideOutlines) parts.push(".glyph-hl-outline");
    const nodes = document.querySelectorAll(parts.join(", "));
    const prev = [];
    nodes.forEach((n) => {
      prev.push([n, n.style.visibility]);
      n.style.visibility = "hidden";
    });
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));
    try {
      return await chrome.runtime.sendMessage({ type: "GLYPH_CAPTURE" });
    } finally {
      prev.forEach(([n, v]) => {
        n.style.visibility = v;
      });
    }
  }

  function compressPreview(dataUrl, maxEdge = 360, quality = 0.72) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height, 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (err) {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve("");
      img.src = dataUrl;
    });
  }

  // JPEG smears the terminals that distinguish a face. Keep a PNG, and enlarge a
  // short crop so the letters are large enough to read. Sonnet 5 accepts a long
  // edge up to 2576px.
  function prepareIdentifyImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxLong = 2000;
        const minShort = 480;
        const long = Math.max(img.width, img.height, 1);
        const short = Math.min(img.width, img.height, 1);
        let scale = short < minShort ? minShort / short : 1;
        if (long * scale > maxLong) scale = maxLong / long;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          resolve(canvas.toDataURL("image/png"));
        } catch (err) {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve("");
      img.src = dataUrl;
    });
  }

  function clampCaptureRect(rect) {
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    return {
      x,
      y,
      w: Math.max(1, Math.min(rect.w, window.innerWidth - x)),
      h: Math.max(1, Math.min(rect.h, window.innerHeight - y)),
    };
  }

  async function captureRegionPreview(rect, options) {
    const res = await captureScreen(options);
    if (!res?.dataUrl) return "";
    const cropped = await cropImage(res.dataUrl, clampCaptureRect(rect));
    return compressPreview(cropped);
  }

  async function captureAndIdentify(rect) {
    const res = await captureScreen();
    if (!res?.dataUrl) {
      showCard(rect.x, rect.y, "Couldn't capture the screen. Try again.");
      return;
    }
    const cropped = await cropImage(res.dataUrl, clampCaptureRect(rect));
    if (!cropped) {
      showCard(rect.x, rect.y, "Couldn't capture the screen. Try again.");
      return;
    }
    showCard(rect.x, rect.y, "Identifying font…");
    const { apiKey } = await chrome.storage.local.get("apiKey");
    if (!apiKey) {
      updateCard("No API key set. Add one in Glyph settings.");
      return;
    }
    try {
      const [image, sampledColor] = await Promise.all([
        prepareIdentifyImage(cropped),
        sampleTextColor(cropped),
      ]);
      const result = await identifyFont(image || cropped);
      const faces = Array.isArray(result?.fonts) && result.fonts.length ? result.fonts : [result];
      const formatted = faces.map((face) => formatIdentifyResult(face, faces.length === 1 ? sampledColor : ""));
      showResultCards(rect.x, rect.y, formatted);
      if (await historySavingEnabled()) {
        const preview = await compressPreview(cropped);
        for (const entry of formatted) await rememberResult(entry, preview);
      }
    } catch (err) {
      updateCard(identifyErrorMessage(err));
    }
  }

  function identifyErrorMessage(err) {
    switch (err && err.code) {
      case "no_key":
        return "No API key set. Add one in Glyph settings.";
      case "unauthorized":
        return "That API key was rejected. Check it in Glyph settings.";
      case "rate_limit":
        return "Anthropic rate limit reached. Wait a moment and try again.";
      case "overloaded":
        return "Anthropic is busy. Try again in a moment.";
      case "network":
        return "Couldn't reach Anthropic. Try again.";
      default:
        return "Identification failed. Try again.";
    }
  }

  function cropImage(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = img.width / window.innerWidth;
        const canvas = document.createElement("canvas");
        canvas.width = rect.w * scale;
        canvas.height = rect.h * scale;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(
          img,
          rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale,
          0, 0, canvas.width, canvas.height
        );
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = dataUrl;
    });
  }

  function identifyFont(imageDataUrl) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "GLYPH_IDENTIFY", image: imageDataUrl }, (res) => {
        if (chrome.runtime.lastError || !res) {
          reject(Object.assign(new Error("network"), { code: "network" }));
          return;
        }
        if (res.error) {
          reject(Object.assign(new Error(res.error), { code: res.error }));
          return;
        }
        resolve(res);
      });
    });
  }

  /* ---------- Highlight tool ---------- */

  const GLYPH_UI = ".glyph-overlay, .glyph-box, .glyph-card, .glyph-hl-outline";
  const SKIP_TEXT_PARENTS = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|HEAD)$/;
  let hlOutline = null;
  let hlLockedOutline = null;
  let hlLockedRect = null;
  let hlShowGeneration = 0;

  function makeOutline() {
    const el = document.createElement("div");
    el.className = "glyph-hl-outline";
    el.style.display = "none";
    document.body.appendChild(el);
    return el;
  }

  function startHighlight() {
    document.documentElement.classList.add("glyph-hl-mode");
    document.addEventListener("mousemove", onHighlightMove, true);
    document.addEventListener("click", onHighlightClick, true);
    document.addEventListener("keydown", onEsc, true);
    document.addEventListener("contextmenu", onRightClick, true);
    hlOutline = makeOutline();
    hlLockedOutline = makeOutline();
  }

  function glyphEl(node) {
    return node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  }

  function isGlyphUI(node) {
    const el = glyphEl(node);
    return !!(el && el.closest && el.closest(GLYPH_UI));
  }

  // Card/overlay swallow hits (including Text nodes inside B/I/U marks). Outline/box are pointer-events: none.
  function isInteractiveGlyphUI(node) {
    const el = glyphEl(node);
    return !!(el && el.closest && el.closest(".glyph-overlay, .glyph-card"));
  }

  function caretNodeFromPoint(x, y) {
    try {
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (pos && pos.offsetNode) return pos.offsetNode;
      }
    } catch (err) {}
    try {
      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        if (range && range.startContainer) return range.startContainer;
      }
    } catch (err) {}
    return null;
  }

  function textClientRects(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return [];
    if (!node.nodeValue || !node.nodeValue.trim()) return [];
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      return Array.from(range.getClientRects());
    } catch (err) {
      return [];
    }
  }

  function hitClientRect(rects, x, y, slop) {
    let best = null;
    let bestArea = Infinity;
    for (const r of rects) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      if (x < r.left - slop || x > r.right + slop || y < r.top - slop || y > r.bottom + slop) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        bestArea = area;
        best = r;
      }
    }
    return best;
  }

  function walkTextAtPoint(root, x, y) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || SKIP_TEXT_PARENTS.test(parent.tagName) || isGlyphUI(node)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    let best = null;
    let bestArea = Infinity;
    while ((node = walker.nextNode())) {
      const rect = hitClientRect(textClientRects(node), x, y, 2);
      if (!rect) continue;
      const area = rect.width * rect.height;
      if (area < bestArea) {
        bestArea = area;
        best = { node, rect };
      }
    }
    return best;
  }

  function pageElementFromPoint(x, y) {
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
      if (el.classList && (el.classList.contains("glyph-hl-outline") || el.classList.contains("glyph-box"))) continue;
      if (el.closest && el.closest(".glyph-overlay, .glyph-card")) return null;
      if (!isGlyphUI(el)) return el;
    }
    return null;
  }

  function targetFromTextNode(node, rect) {
    const el = node && node.parentElement;
    if (!el || !rect || isGlyphUI(el)) return null;
    return { el, rect, textNode: node };
  }

  const SAMPLE_TEXT_MAX = 100;

  function truncateSampleText(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    const chars = Array.from(t);
    if (chars.length <= SAMPLE_TEXT_MAX) return t;
    return chars.slice(0, SAMPLE_TEXT_MAX - 1).join("").replace(/\s+$/u, "") + "\u2026";
  }

  function sampleTextFromHighlightTarget(target) {
    if (!target) return "";
    const node = target.textNode;
    if (node && node.nodeType === Node.TEXT_NODE) {
      return truncateSampleText(node.nodeValue);
    }
    const el = target.el;
    if (!el) return "";
    return truncateSampleText(el.innerText || el.textContent || "");
  }

  // Innermost text under the cursor — not the wrapper elementFromPoint often returns.
  function textTargetFromPoint(x, y) {
    const caret = caretNodeFromPoint(x, y);
    if (isInteractiveGlyphUI(caret)) return null;
    if (caret && !isGlyphUI(caret)) {
      if (caret.nodeType === Node.TEXT_NODE) {
        const rect = hitClientRect(textClientRects(caret), x, y, 2);
        const hit = targetFromTextNode(caret, rect);
        if (hit) return hit;
      }
      const caretRoot = caret.nodeType === Node.ELEMENT_NODE ? caret : caret.parentElement;
      if (
        caretRoot &&
        caretRoot !== document.body &&
        caretRoot !== document.documentElement
      ) {
        const walked = walkTextAtPoint(caretRoot, x, y);
        if (walked) {
          const hit = targetFromTextNode(walked.node, walked.rect);
          if (hit) return hit;
        }
      }
    }

    const el = pageElementFromPoint(x, y);
    if (!el || el === document.body || el === document.documentElement) return null;
    const walked = walkTextAtPoint(el, x, y);
    return walked ? targetFromTextNode(walked.node, walked.rect) : null;
  }

  function placeHighlight(el, rect) {
    const pad = 2;
    el.style.display = "";
    el.style.left = rect.left - pad + "px";
    el.style.top = rect.top - pad + "px";
    el.style.width = rect.width + pad * 2 + "px";
    el.style.height = rect.height + pad * 2 + "px";
  }

  function rectsMatch(a, b) {
    if (!a || !b) return false;
    return (
      Math.abs(a.left - b.left) < 0.5 &&
      Math.abs(a.top - b.top) < 0.5 &&
      Math.abs(a.width - b.width) < 0.5 &&
      Math.abs(a.height - b.height) < 0.5
    );
  }

  function onHighlightMove(e) {
    if (isInteractiveGlyphUI(e.target)) return;
    const target = textTargetFromPoint(e.clientX, e.clientY);
    if (!target || rectsMatch(target.rect, hlLockedRect)) {
      if (hlOutline) hlOutline.style.display = "none";
      return;
    }
    placeHighlight(hlOutline, target.rect);
  }

  async function onHighlightClick(e) {
    if (isInteractiveGlyphUI(e.target)) return; // let the card's close/copy/fonts buttons work
    e.preventDefault();
    e.stopPropagation();
    const target = textTargetFromPoint(e.clientX, e.clientY);
    if (!target || isInteractiveGlyphUI(target.el)) return;
    const sampleText = sampleTextFromHighlightTarget(target);
    const content = fontContentFromElement(target.el, sampleText);
    if (!content) return;
    if (sampleText) content.sampleText = sampleText;

    // The tool stays active after a click; Esc / right-click / card close ends it.
    const showGen = ++hlShowGeneration;
    const point = { x: e.clientX, y: e.clientY };
    hlLockedRect = target.rect;
    if (hlOutline) hlOutline.style.display = "none";
    placeHighlight(hlLockedOutline, target.rect);
    const pad = 4;
    const previewRect = {
      x: target.rect.left - pad,
      y: target.rect.top - pad,
      w: target.rect.width + pad * 2,
      h: target.rect.height + pad * 2,
    };
    const stale = () => showGen !== hlShowGeneration || mode !== "highlight";

    const saving = await historySavingEnabled();
    if (stale()) return;

    // Build the card unpainted. A history shot hides page chrome for a frame,
    // and the font-source link can change the card's width — either one makes
    // the card flicker if it is already visible. Reveal it once both are done.
    showCard(point.x, point.y, content, { hidden: true });
    let dataUrl = "";
    if (saving) {
      try {
        const res = await captureScreen({ hideCards: false, hideOutlines: false });
        dataUrl = res?.dataUrl || "";
      } catch (err) {
        dataUrl = "";
      }
    }
    if (card && card._glyphSourceReady) {
      await Promise.race([
        card._glyphSourceReady,
        new Promise((resolve) => setTimeout(resolve, 80)),
      ]);
    }
    if (stale()) return;
    if (card) card.style.visibility = "";

    if (!saving || !dataUrl) return;
    try {
      const cropped = await cropImage(dataUrl, clampCaptureRect(previewRect));
      const preview = cropped ? await compressPreview(cropped) : "";
      if (!stale()) await rememberResult(content, preview);
    } catch (err) {
      // History is best-effort; the card is already on screen.
    }
  }

  // "16px" -> "16"; "1.5em" -> "1.5". Display still uses the original string.
  function numericCopyValue(cssSize) {
    const s = String(cssSize).trim();
    const m = s.match(/^-?[\d.]+/);
    return m ? m[0] : s;
  }

  // "rgb(26, 26, 24)" -> "#1a1a18"; "rgba(0, 0, 0, 0.5)" -> "#000000 50%".
  function toHex(cssColor) {
    const m = cssColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
    if (!m) return cssColor;
    const hex = "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
    const alpha = m[4] === undefined ? 1 : Number(m[4]);
    return alpha < 1 ? `${hex} ${Math.round(alpha * 100)}%` : hex;
  }

  function numericFontWeight(weight) {
    const w = String(weight).trim().toLowerCase();
    if (w === "bold" || w === "bolder") return 700;
    if (w === "normal" || w === "lighter") return 400;
    const n = Number(w);
    return Number.isFinite(n) ? n : 0;
  }

  function variationWeight(cs) {
    const fvs = cs.fontVariationSettings || "";
    const m = String(fvs).match(/["']wght["']\s+([\d.]+)/i);
    return m ? Number(m[1]) : 0;
  }

  // 500/600 is how YouTube, Twitch, and most UI kits make text look bold.
  function isBoldStyle(el, cs) {
    const n = Math.max(numericFontWeight(cs.fontWeight), variationWeight(cs));
    if (n >= 500) return true;
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      const tag = node.tagName;
      if (tag === "B" || tag === "STRONG") return true;
      node = node.parentElement;
    }
    return false;
  }

  function isItalicStyle(style) {
    const s = String(style).trim().toLowerCase();
    return s === "italic" || s === "oblique" || s.startsWith("oblique ");
  }

  function hasUnderline(el) {
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      const line = getComputedStyle(node).textDecorationLine || "";
      if (/\bunderline\b/.test(line)) return true;
      const tag = node.tagName;
      if (tag === "U" || tag === "INS") return true;
      node = node.parentElement;
    }
    return false;
  }

  // font-family is a stack. The first name is what the page asked for; the browser
  // paints the first family that is actually available and has the glyph.
  function splitFontFamily(fontFamily) {
    const out = [];
    let current = "";
    let quote = "";
    for (const ch of String(fontFamily || "")) {
      if (quote) {
        if (ch === quote) quote = "";
        else current += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === ",") {
        const name = current.trim();
        if (name) out.push(name);
        current = "";
        continue;
      }
      current += ch;
    }
    const name = current.trim();
    if (name) out.push(name);
    return out;
  }

  function isGenericFamilyName(name) {
    return GENERIC_FONT_FAMILIES.has(String(name || "").trim().toLowerCase());
  }

  function quoteFamilyForCanvas(name) {
    if (isGenericFamilyName(name)) return String(name).trim();
    return `"${String(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  function canvasFontStyle(style) {
    const s = String(style || "normal").trim().toLowerCase();
    if (s.startsWith("italic")) return "italic";
    if (s.startsWith("oblique")) return "oblique";
    return "normal";
  }

  function canvasFontWeight(weight) {
    const w = String(weight || "400").trim();
    if (/^(normal|bold|bolder|lighter|[1-9]00)$/i.test(w)) return w;
    const n = Number(w);
    if (Number.isFinite(n) && n > 0) return String(Math.round(n));
    return "400";
  }

  function canvasFont(weight, style, sizePx, families) {
    const list = families.map(quoteFamilyForCanvas).join(", ");
    return `${canvasFontStyle(style)} ${canvasFontWeight(weight)} ${sizePx}px ${list}`;
  }

  const GLYPH_BASELINES = ["monospace", "serif", "sans-serif"];
  const glyphAnswerCache = new Map();
  let glyphMeasureCtx = null;
  let glyphPixelCtx = null;

  function rememberGlyphAnswer(key, value) {
    if (glyphAnswerCache.size > 500) glyphAnswerCache.clear();
    glyphAnswerCache.set(key, value);
    return value;
  }

  function glyphMeasureContext() {
    if (!glyphMeasureCtx) glyphMeasureCtx = document.createElement("canvas").getContext("2d");
    return glyphMeasureCtx;
  }

  function glyphPixelContext() {
    if (!glyphPixelCtx) {
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 80;
      glyphPixelCtx = canvas.getContext("2d", { willReadFrequently: true });
    }
    return glyphPixelCtx;
  }

  function paintChars(text) {
    let raw = String(text || "").replace(/\s+/g, " ").trim();
    if (Array.from(raw).length >= SAMPLE_TEXT_MAX && raw.endsWith("\u2026")) raw = raw.slice(0, -1).trim();
    const sliced = Array.from(raw).slice(0, SAMPLE_TEXT_MAX).join("");
    const pieces = typeof Intl !== "undefined" && Intl.Segmenter
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(sliced), (part) => part.segment)
      : Array.from(sliced);
    const chars = [];
    const seen = new Set();
    for (const ch of pieces) {
      if (!ch.trim()) continue;
      if (seen.has(ch)) continue;
      seen.add(ch);
      chars.push(ch);
      if (chars.length >= 40) break;
    }
    return chars;
  }

  function widthsDiffer(a, b) {
    return Math.abs(a - b) > 0.2;
  }

  function textWidthDiffers(family, text, weight, style) {
    const key = `width\n${family}\n${weight}\n${style}\n${text}`;
    if (glyphAnswerCache.has(key)) return glyphAnswerCache.get(key);
    const ctx = glyphMeasureContext();
    if (!ctx || !text) return rememberGlyphAnswer(key, false);
    try {
      for (const baseline of GLYPH_BASELINES) {
        ctx.font = canvasFont(weight, style, 72, [baseline]);
        const baseWidth = ctx.measureText(text).width;
        ctx.font = canvasFont(weight, style, 72, [family, baseline]);
        if (widthsDiffer(ctx.measureText(text).width, baseWidth)) return rememberGlyphAnswer(key, true);
      }
    } catch (err) {
      return rememberGlyphAnswer(key, false);
    }
    return rememberGlyphAnswer(key, false);
  }

  // Width decides first. Pixels are only compared when one character matches every baseline width.
  function familyAffectsText(family, text, weight, style) {
    const key = `text\n${family}\n${weight}\n${style}\n${text}`;
    if (glyphAnswerCache.has(key)) return glyphAnswerCache.get(key);
    if (textWidthDiffers(family, text, weight, style)) return rememberGlyphAnswer(key, true);
    const single = Array.from(text).length === 1;
    if (!single) return rememberGlyphAnswer(key, false);
    return rememberGlyphAnswer(key, glyphPixelsDiffer(family, text, weight, style));
  }

  function glyphPixelsDiffer(family, text, weight, style) {
    const ctx = glyphPixelContext();
    if (!ctx) return false;
    const canvas = ctx.canvas;
    const draw = (families) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = canvasFont(weight, style, 48, families);
      ctx.fillStyle = "#000";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(text, 4, 58);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    try {
      for (const baseline of GLYPH_BASELINES) {
        const withFamily = draw([family, baseline]);
        const baseOnly = draw([baseline]);
        for (let i = 3; i < withFamily.length; i += 4) {
          if (withFamily[i] !== baseOnly[i]) return true;
        }
      }
    } catch (err) {
      return false;
    }
    return false;
  }

  function familyUsedInSample(family, chars, weight, style) {
    if (textWidthDiffers(family, chars.join(""), weight, style)) return true;
    for (const ch of chars.slice(0, 4)) {
      if (glyphPixelsDiffer(family, ch, weight, style)) return true;
    }
    return false;
  }

  function resolvePaintedFont(fontFamily, sampleText, weight, style) {
    const stack = splitFontFamily(fontFamily);
    if (!stack.length) return null;
    const chars = paintChars(sampleText);
    const counts = new Map();

    const claim = (family) => counts.set(family, (counts.get(family) || 0) + 1);

    if (!chars.length) {
      const probe = "AaBb0123";
      for (const family of stack) {
        if (isGenericFamilyName(family)) return { primary: family, fallbacks: [] };
        if (textWidthDiffers(family, probe, weight, style) || glyphPixelsDiffer(family, "A", weight, style)) {
          return { primary: family, fallbacks: [] };
        }
      }
      return { primary: stack[0], fallbacks: [] };
    }

    const pending = new Set(chars);
    let stopFamily = null;
    for (const family of stack) {
      if (!pending.size) break;
      if (isGenericFamilyName(family)) {
        stopFamily = family;
        break;
      }
      const remaining = Array.from(pending);
      if (!familyUsedInSample(family, remaining, weight, style)) continue;
      for (const ch of remaining) {
        if (!familyAffectsText(family, ch, weight, style)) continue;
        claim(family);
        pending.delete(ch);
      }
    }
    if (pending.size) {
      const rest = stopFamily || stack[stack.length - 1];
      pending.forEach(() => claim(rest));
    }

    let primary = stack[0];
    let best = -1;
    for (const family of stack) {
      const n = counts.get(family) || 0;
      if (n > best) {
        best = n;
        primary = family;
      }
    }
    const fallbacks = stack.filter((family) => family !== primary && counts.get(family));
    return { primary, fallbacks };
  }

  function fontContentFromElement(el, sampleText) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || isGlyphUI(el)) return null;
    const cs = getComputedStyle(el);
    const painted = resolvePaintedFont(cs.fontFamily, sampleText, cs.fontWeight, cs.fontStyle);
    const family = painted && painted.primary;
    if (!family) return null;
    const color = toHex(cs.color);
    const bold = isBoldStyle(el, cs);
    const properties = [{ value: family }];
    if (painted.fallbacks.length) {
      properties.push({
        value: painted.fallbacks.join(", "),
        before: " (",
        after: " for some characters)",
        adjacent: true,
      });
    }
    if (!bold) properties.push({ value: cs.fontWeight });
    properties.push({ value: cs.fontSize, copy: numericCopyValue(cs.fontSize) }, { value: color });
    const styles = [];
    if (bold) styles.push({ letter: "B", title: "Bold", kind: "bold" });
    if (isItalicStyle(cs.fontStyle)) styles.push({ letter: "I", title: "Italic", kind: "italic" });
    if (hasUnderline(el)) styles.push({ letter: "U", title: "Underline", kind: "underline" });
    return { properties, styles, swatchColor: cs.color };
  }

  /* ---------- Native text selection ---------- */

  function isEditingTarget(node) {
    const el = glyphEl(node);
    if (!el) return false;
    if (el.isContentEditable || el.closest("[contenteditable]:not([contenteditable='false'])")) return true;
    const tag = (el.closest("input, textarea, select") || el).tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function selectionAnchorElement(range) {
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    if (node === document.body || node === document.documentElement) {
      const walked = walkTextAtPoint(node, range.getBoundingClientRect().left + 1, range.getBoundingClientRect().top + 1);
      return walked ? walked.node.parentElement : null;
    }
    return node;
  }

  function readSelectionTarget() {
    if (mode || !selectionCardOn) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    if (!String(sel).trim()) return null;
    const range = sel.getRangeAt(0);
    const el = selectionAnchorElement(range);
    if (!el || isGlyphUI(el) || isEditingTarget(el)) return null;
    const rect = range.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) return null;
    const sampleText = truncateSampleText(String(sel));
    const content = fontContentFromElement(el, String(sel));
    if (!content) return null;
    if (sampleText) content.sampleText = sampleText;
    return { content, rect };
  }

  function selectionFingerprint(content) {
    return JSON.stringify({
      properties: content.properties,
      styles: content.styles,
      swatchColor: content.swatchColor,
      pageUrl: window.location.href,
    });
  }

  function dismissSelectionCard() {
    if (mode) return;
    document.querySelectorAll(".glyph-card").forEach((n) => n.remove());
    card = null;
    lastSelectionFingerprint = "";
    if (selectionRememberTimer) {
      clearTimeout(selectionRememberTimer);
      selectionRememberTimer = 0;
    }
  }

  function showSelectionResult(target) {
    loadTheme();
    const x = target.rect.left;
    const y = target.rect.bottom;
    if (card && !mode) {
      updateCard(target.content);
      card.style.left = Math.min(x, window.innerWidth - 280) + "px";
      card.style.top = Math.min(y + 12, window.innerHeight - 80) + "px";
      card.classList.toggle("glyph-card--copy-below", card.getBoundingClientRect().top < 32);
    } else {
      showCard(x, y, target.content, { keepTool: true });
    }
    const fingerprint = selectionFingerprint(target.content);
    if (fingerprint === lastSelectionFingerprint) return;
    lastSelectionFingerprint = fingerprint;
    const pad = 4;
    const previewRect = {
      x: target.rect.left - pad,
      y: target.rect.top - pad,
      w: Math.max(1, target.rect.width + pad * 2),
      h: Math.max(1, target.rect.height + pad * 2),
    };
    if (selectionRememberTimer) clearTimeout(selectionRememberTimer);
    selectionRememberTimer = setTimeout(() => {
      selectionRememberTimer = 0;
      rememberResultWithPreview(target.content, previewRect, { hideCards: false });
    }, 400);
  }

  function refreshSelectionCard() {
    if (!selectionCardOn || mode || selectingWithPointer) return;
    if (card && (card.matches(":hover") || isInteractiveGlyphUI(document.activeElement))) return;
    const target = readSelectionTarget();
    if (!target) {
      dismissSelectionCard();
      return;
    }
    showSelectionResult(target);
  }

  function onSelectionPointerDown(e) {
    if (isInteractiveGlyphUI(e.target)) return;
    selectingWithPointer = true;
  }

  function onSelectionPointerUp() {
    selectingWithPointer = false;
    refreshSelectionCard();
  }

  function onSelectionKeyUp(e) {
    if (e.key === "Escape" && !mode && card) {
      dismissSelectionCard();
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      return;
    }
    if (e.shiftKey || e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
      refreshSelectionCard();
    }
  }

  function onSelectionChange() {
    if (selectingWithPointer) return;
    refreshSelectionCard();
  }

  function setSelectionCardEnabled(on) {
    selectionCardOn = !!on;
    if (selectionCardOn) {
      loadTheme();
      if (!selectionListening) {
        document.addEventListener("mousedown", onSelectionPointerDown, true);
        document.addEventListener("mouseup", onSelectionPointerUp, true);
        document.addEventListener("keyup", onSelectionKeyUp, true);
        document.addEventListener("selectionchange", onSelectionChange);
        selectionListening = true;
      }
      refreshSelectionCard();
      return;
    }
    if (selectionListening) {
      document.removeEventListener("mousedown", onSelectionPointerDown, true);
      document.removeEventListener("mouseup", onSelectionPointerUp, true);
      document.removeEventListener("keyup", onSelectionKeyUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      selectionListening = false;
    }
    selectingWithPointer = false;
    dismissSelectionCard();
  }

  async function initSelectionCard() {
    try {
      const data = await chrome.storage.local.get("selectionCard");
      setSelectionCardEnabled(!!data.selectionCard);
    } catch (err) {
      setSelectionCardEnabled(false);
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.selectionCard) return;
      setSelectionCardEnabled(!!changes.selectionCard.newValue);
    });
  }

  /* ---------- Result card ---------- */

  let card = null;

  const COPY_ICON =
    '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><rect x="5.5" y="3.5" width="7" height="9" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 5.5h1.8v8.2c0 .7.6 1.3 1.3 1.3h5.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><rect x="7.2" y="1.5" width="3.6" height="2.4" rx="0.7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  const CHECK_ICON =
    '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3.5 8.5 6.6 11.5 12.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const GFONTS_ICON =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2.6 13 8 3 13.4 13" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.7 9.3h6.6" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>';
  const GENERIC_FONT_FAMILIES = new Set([
    "serif", "sans-serif", "monospace", "cursive", "fantasy",
    "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
    "emoji", "math", "fangsong", "inherit", "initial", "unset", "revert",
    "revert-layer", "caption", "icon", "menu", "message-box", "small-caption",
    "status-bar", "blinkmacsystemfont",
  ]);

  function fontNameFromContent(content) {
    if (!content || typeof content === "string") return null;
    const props = Array.isArray(content) ? content : content.properties || [];
    const first = props[0];
    if (first == null) return null;
    return String(typeof first === "string" ? first : first.value || "").trim();
  }

  function canResolveFontSource(name) {
    const family = String(name || "").replace(/["']/g, "").trim();
    if (!family || family.toLowerCase() === "unknown") return false;
    if (GENERIC_FONT_FAMILIES.has(family.toLowerCase())) return false;
    if (family.startsWith(".") || family.startsWith("-")) return false;
    return true;
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

  function applyFontSourceButton(host, family, source) {
    let link = host.querySelector(".glyph-card-gfonts");
    const url = source && source.url;
    if (!url) {
      if (link) link.remove();
      // Drop reserved padding only while the card is still unpainted. Once it
      // is visible, keep the width so the card doesn't resize as it appears.
      if (host.style.visibility === "hidden") host.classList.remove("glyph-card--has-gfonts");
      return;
    }
    host.classList.add("glyph-card--has-gfonts");
    if (!link) {
      link = document.createElement("a");
      link.className = "glyph-card-gfonts";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.innerHTML = GFONTS_ICON;
      link.addEventListener("click", (e) => e.stopPropagation());
      const close = host.querySelector(".glyph-card-close");
      if (close) host.insertBefore(link, close);
      else host.appendChild(link);
    }
    const label = source.label || "Font source";
    link.href = url;
    link.title = "View on " + label;
    link.setAttribute("aria-label", `View ${family} on ${label}`);
  }

  async function syncFontSourceButton(host, content) {
    const family = fontNameFromContent(content);
    const token = (host._glyphSourceToken = (host._glyphSourceToken || 0) + 1);
    if (!canResolveFontSource(family)) {
      applyFontSourceButton(host, family, null);
      return;
    }
    const source = await requestFontSource(family);
    if (!host.isConnected || host._glyphSourceToken !== token) return;
    applyFontSourceButton(host, family, source);
  }

  const HISTORY_KEY = "fontHistory";
  const SAVE_HISTORY_KEY = "saveFontHistory";
  const HISTORY_LIMIT = 10;

  async function historySavingEnabled() {
    try {
      const data = await chrome.storage.local.get(SAVE_HISTORY_KEY);
      return data[SAVE_HISTORY_KEY] !== false;
    } catch (err) {
      return true;
    }
  }

  function serializeProp(prop) {
    if (typeof prop === "string") return { value: prop };
    const out = { value: prop.value };
    if (prop.copy != null) out.copy = String(prop.copy);
    if (prop.before) out.before = prop.before;
    if (prop.after) out.after = prop.after;
    if (prop.adjacent) out.adjacent = true;
    return out;
  }

  async function persistHistoryEntries(entries) {
    await chrome.storage.local.set({ [HISTORY_KEY]: entries.slice(0, HISTORY_LIMIT) });
  }

  async function rememberResult(content, previewDataUrl) {
    if (!content || typeof content === "string") return;
    if (!(await historySavingEnabled())) return;
    const properties = (Array.isArray(content) ? content : content.properties || []).map(serializeProp);
    if (!properties.length) return;
    const entry = {
      id: Date.now(),
      properties,
      styles: Array.isArray(content.styles)
        ? content.styles.map((s) => ({ letter: s.letter, title: s.title, kind: s.kind }))
        : [],
      swatchColor: content.swatchColor || "",
      pageUrl: window.location.href || document.URL || "",
      pageTitle: document.title || "",
    };
    if (previewDataUrl) entry.preview = previewDataUrl;
    const sampleText = truncateSampleText(content.sampleText);
    if (sampleText) entry.sampleText = sampleText;
    try {
      const data = await chrome.storage.local.get(HISTORY_KEY);
      const prev = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
      const next = [entry, ...prev].slice(0, HISTORY_LIMIT);
      try {
        await persistHistoryEntries(next);
      } catch (err) {
        delete entry.preview;
        await persistHistoryEntries(next);
      }
    } catch (err) {
      // History is best-effort; identifying still works if storage fails.
    }
  }

  async function rememberResultWithPreview(content, rect, options) {
    if (!(await historySavingEnabled())) return;
    let preview = "";
    try {
      preview = await captureRegionPreview(rect, options);
    } catch (err) {
      preview = "";
    }
    await rememberResult(content, preview);
  }

  function sampleTextColor(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          resolve(textHexFromImage(img));
        } catch (err) {
          resolve("");
        }
      };
      img.onerror = () => resolve("");
      img.src = dataUrl;
    });
  }

  function textHexFromImage(img) {
    const canvas = document.createElement("canvas");
    const w = Math.max(1, Math.min(img.width, 160));
    const h = Math.max(1, Math.min(img.height, 160));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "";
    ctx.drawImage(img, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    const counts = new Map();
    for (let i = 0; i < pixels.length; i += 16) {
      if (pixels[i + 3] < 200) continue;
      const r = pixels[i] & 0xf0;
      const g = pixels[i + 1] & 0xf0;
      const b = pixels[i + 2] & 0xf0;
      const key = (r << 16) | (g << 8) | b;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return "";
    if (ranked.length === 1) return hexFromQuantized(ranked[0][0]);
    const bgLum = lumFromQuantized(ranked[0][0]);
    let best = null;
    let bestScore = 0;
    for (let i = 1; i < ranked.length && i < 8; i++) {
      const contrast = Math.abs(lumFromQuantized(ranked[i][0]) - bgLum);
      const score = ranked[i][1] * contrast;
      if (contrast > 0.12 && score > bestScore) {
        bestScore = score;
        best = ranked[i][0];
      }
    }
    return best == null ? "" : hexFromQuantized(best);
  }

  function lumFromQuantized(key) {
    const channels = [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff].map((c) => {
      const x = c / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function hexFromQuantized(key) {
    const fill = (n) => {
      const hi = n & 0xf0;
      return (hi | (hi >> 4)).toString(16).padStart(2, "0");
    };
    return "#" + fill(key >> 16) + fill(key >> 8) + fill(key & 0xff);
  }

  function formatIdentifyResult(data, sampledColor) {
    const font = data?.font || "Unknown";
    const properties = [{ value: font }];
    if (typeof data?.confidence === "number") {
      properties.push({
        value: `${Math.round(data.confidence * 100)}% match`,
        before: " (",
        after: ")",
      });
    }
    const weight = Number(data?.weight) || 0;
    const bold = weight >= 500;
    if (!bold && weight) properties.push({ value: String(weight) });
    const size = Number(data?.size) || 0;
    if (size) properties.push({ value: size + "px", copy: String(size) });
    const color = sampledColor || data?.color || "";
    if (color) properties.push({ value: color });
    const styles = [];
    if (bold) styles.push({ letter: "B", title: "Bold", kind: "bold" });
    if (data?.italic) styles.push({ letter: "I", title: "Italic", kind: "italic" });
    if (data?.underline) styles.push({ letter: "U", title: "Underline", kind: "underline" });
    const content = { properties, styles };
    if (color) content.swatchColor = color;
    return content;
  }

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

  function makeProp(prop) {
    const value = typeof prop === "string" ? prop : prop.value;
    const copyValue = typeof prop === "string" ? value : (prop.copy != null ? String(prop.copy) : value);
    const wrap = document.createElement("span");
    wrap.className = "glyph-prop";
    wrap.appendChild(document.createTextNode(value));

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "glyph-card-copy";
    btn.title = "Copy";
    btn.setAttribute("aria-label", `Copy ${copyValue}`);
    btn.innerHTML = COPY_ICON;

    const flashCopied = () => {
      btn.innerHTML = CHECK_ICON;
      btn.classList.add("glyph-card-copy--done");
      btn.title = "Copied";
      clearTimeout(btn._glyphCopyTimer);
      btn._glyphCopyTimer = setTimeout(() => {
        btn.innerHTML = COPY_ICON;
        btn.classList.remove("glyph-card-copy--done");
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

  function makeStyleMarks(styles) {
    const group = document.createElement("span");
    group.className = "glyph-style-marks";
    styles.forEach((style) => {
      const mark = document.createElement("span");
      mark.className = "glyph-style-mark glyph-style-mark--" + style.kind;
      mark.textContent = style.letter;
      mark.title = style.title;
      group.appendChild(mark);
    });
    return group;
  }

  function fillCardBody(body, content) {
    body.replaceChildren();
    if (typeof content === "string") {
      body.textContent = content;
      return;
    }
    const props = Array.isArray(content) ? content : content.properties || [];
    const swatchColor = content.swatchColor;
    const styles = content.styles || [];
    props.forEach((prop, i) => {
      if (prop.before) body.appendChild(document.createTextNode(prop.before));
      else if (i > 0 && !prop.adjacent) body.appendChild(document.createTextNode(" \u00b7 "));
      body.appendChild(makeProp(prop));
      if (i === 0 && styles.length) body.appendChild(makeStyleMarks(styles));
      if (prop.after) body.appendChild(document.createTextNode(prop.after));
    });
    if (swatchColor) {
      const swatch = document.createElement("span");
      swatch.className = "glyph-swatch";
      swatch.style.background = swatchColor;
      swatch.title = "Text colour";
      body.appendChild(swatch);
    }
  }

  function showCard(x, y, content, options) {
    document.querySelectorAll(".glyph-card").forEach((n) => n.remove());
    card = buildCard(content, options);
    placeCard(card, x, y + 12);
    if (options && options.hidden) card.style.visibility = "hidden";
    document.body.appendChild(card);
    if (card.getBoundingClientRect().top < 32) card.classList.add("glyph-card--copy-below");
  }

  function showResultCards(x, y, contents) {
    document.querySelectorAll(".glyph-card").forEach((n) => n.remove());
    const nodes = contents.map((content) => buildCard(content, { stack: true }));
    const left = Math.min(x, window.innerWidth - 280);
    let top = y + 12;
    nodes.forEach((node) => {
      node.style.left = left + "px";
      node.style.top = top + "px";
      document.body.appendChild(node);
      top += node.getBoundingClientRect().height + 8;
    });
    const overflow = top - (window.innerHeight - 8);
    if (overflow > 0) {
      nodes.forEach((node) => {
        node.style.top = Math.max(8, parseFloat(node.style.top) - overflow) + "px";
      });
    }
    nodes.forEach((node) => {
      if (node.getBoundingClientRect().top < 32) node.classList.add("glyph-card--copy-below");
    });
    card = nodes[0] || null;
  }

  function placeCard(node, x, y) {
    node.style.left = Math.min(x, window.innerWidth - 280) + "px";
    node.style.top = Math.min(y, window.innerHeight - 80) + "px";
  }

  function buildCard(content, options) {
    const node = document.createElement("div");
    node.className = "glyph-card" + (darkTheme ? " glyph-card--dark" : "");
    // Hold the source-link slot before the first paint so the card doesn't
    // grow when that button arrives.
    if (options && options.hidden && canResolveFontSource(fontNameFromContent(content))) {
      node.classList.add("glyph-card--has-gfonts");
    }

    const body = document.createElement("span");
    body.className = "glyph-card-body";
    node.appendChild(body);
    fillCardBody(body, content);

    const keepTool = !!(options && options.keepTool);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "glyph-card-close";
    close.textContent = "\u00d7";
    close.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (options && options.stack) {
        node.remove();
        const rest = document.querySelectorAll(".glyph-card");
        if (!rest.length) cleanup();
        else if (card === node) card = rest[0];
        return;
      }
      if (keepTool && !mode) {
        dismissSelectionCard();
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();
        return;
      }
      cleanup();
    });
    node.appendChild(close);
    node._glyphSourceReady = syncFontSourceButton(node, content);
    return node;
  }

  function updateCard(content) {
    if (!card) return;
    const body = card.querySelector(".glyph-card-body");
    if (body) fillCardBody(body, content);
    syncFontSourceButton(card, content);
  }

  initSelectionCard();
})();
