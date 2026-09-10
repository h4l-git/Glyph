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
  async function captureScreen() {
    const nodes = document.querySelectorAll(".glyph-overlay, .glyph-box, .glyph-card, .glyph-hl-outline");
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

  async function captureRegionPreview(rect) {
    const res = await captureScreen();
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
    const cropped = await cropImage(res.dataUrl, rect);
    showCard(rect.x, rect.y, "Identifying font…");
    const { apiKey } = await chrome.storage.local.get("apiKey");
    if (!apiKey) {
      updateCard("No API key set. Add one in Glyph settings.");
      return;
    }
    try {
      const result = await identifyFont(cropped, apiKey);
      const formatted = formatIdentifyResult(result);
      updateCard(formatted);
      rememberResult(formatted, await compressPreview(cropped));
    } catch (err) {
      updateCard("Identification failed. Check your API key and try again.");
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

  async function identifyFont(imageDataUrl, apiKey) {
    // Placeholder: swap in your font-recognition API endpoint here.
    // Expected contract: POST image, receive { font: string, confidence: number }
    const resp = await fetch("https://api.glyph.app/v1/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ image: imageDataUrl }),
    });
    if (!resp.ok) throw new Error("API error");
    return await resp.json();
  }

  /* ---------- Highlight tool ---------- */

  const GLYPH_UI = ".glyph-overlay, .glyph-box, .glyph-card, .glyph-hl-outline";
  const SKIP_TEXT_PARENTS = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|HEAD)$/;
  let hlOutline = null;
  let hlLockedOutline = null;
  let hlLockedRect = null;

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

  function onHighlightClick(e) {
    if (isInteractiveGlyphUI(e.target)) return; // let the card's close/copy/fonts buttons work
    e.preventDefault();
    e.stopPropagation();
    const target = textTargetFromPoint(e.clientX, e.clientY);
    if (!target || isInteractiveGlyphUI(target.el)) return;
    const content = fontContentFromElement(target.el);
    if (!content) return;
    content.sampleText = sampleTextFromHighlightTarget(target);
    placeHighlight(hlLockedOutline, target.rect);
    hlLockedRect = target.rect;
    if (hlOutline) hlOutline.style.display = "none";
    // The tool stays active after a click; Esc / right-click / card close ends it.
    showCard(e.clientX, e.clientY, content);
    const pad = 4;
    const previewRect = {
      x: target.rect.left - pad,
      y: target.rect.top - pad,
      w: target.rect.width + pad * 2,
      h: target.rect.height + pad * 2,
    };
    rememberResultWithPreview(content, previewRect);
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

  function fontContentFromElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || isGlyphUI(el)) return null;
    const cs = getComputedStyle(el);
    const family = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    if (!family) return null;
    const color = toHex(cs.color);
    const bold = isBoldStyle(el, cs);
    const properties = [{ value: family }];
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
    const content = fontContentFromElement(el);
    if (!content) return null;
    const sampleText = truncateSampleText(String(sel));
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
      rememberResultWithPreview(target.content, previewRect);
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
    host.classList.toggle("glyph-card--has-gfonts", !!url);
    if (!url) {
      if (link) link.remove();
      return;
    }
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
  const HISTORY_LIMIT = 10;

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

  async function rememberResultWithPreview(content, rect) {
    let preview = "";
    try {
      preview = await captureRegionPreview(rect);
    } catch (err) {
      preview = "";
    }
    await rememberResult(content, preview);
  }

  function formatIdentifyResult(data) {
    const font = data?.font || "Unknown";
    const props = [{ value: font }];
    if (typeof data?.confidence === "number") {
      props.push({
        value: `${Math.round(data.confidence * 100)}% match`,
        before: " (",
        after: ")",
      });
    }
    return { properties: props };
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
    card = document.createElement("div");
    card.className = "glyph-card" + (darkTheme ? " glyph-card--dark" : "");

    const body = document.createElement("span");
    body.className = "glyph-card-body";
    card.appendChild(body);
    fillCardBody(body, content);

    const keepTool = !!(options && options.keepTool);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "glyph-card-close";
    close.textContent = "\u00d7";
    close.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (keepTool && !mode) {
        dismissSelectionCard();
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();
        return;
      }
      cleanup();
    });
    card.appendChild(close);
    syncFontSourceButton(card, content);
    card.style.left = Math.min(x, window.innerWidth - 280) + "px";
    card.style.top = Math.min(y + 12, window.innerHeight - 80) + "px";
    document.body.appendChild(card);
    if (card.getBoundingClientRect().top < 32) card.classList.add("glyph-card--copy-below");
  }

  function updateCard(content) {
    if (!card) return;
    const body = card.querySelector(".glyph-card-body");
    if (body) fillCardBody(body, content);
    syncFontSourceButton(card, content);
  }

  initSelectionCard();
})();
