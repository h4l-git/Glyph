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
  const pinned = new Set();
  let pinListening = false;
  let pinRaf = 0;
  let snipDrag = null;
  let snipGeneration = 0;
  let snipCaptureSerial = 0;
  let imgOutline = null;
  let imgLockedOutline = null;
  let imgLockedRect = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "GLYPH_SNIP_LIMIT") {
      showSnipLimit(msg.resetAt);
      return;
    }
    if (msg.type !== "GLYPH_START") return;
    beginTool(msg.mode);
  });

  function beginTool(next) {
    cleanup();
    mode = next;
    loadTheme();
    chrome.runtime.sendMessage({ type: "GLYPH_MODE_CHANGED", active: true, mode });
    if (mode === "snip") startSnip();
    if (mode === "image") startImagePick();
    if (mode === "highlight") startHighlight();
  }

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
    snipGeneration += 1;
    releaseAllPins();
    document.querySelectorAll(".glyph-overlay, .glyph-box, .glyph-card, .glyph-hl-outline, .glyph-img-hint").forEach((n) => n.remove());
    document.removeEventListener("mousemove", onHighlightMove, true);
    document.removeEventListener("click", onHighlightClick, true);
    document.removeEventListener("mousemove", onImageMove, true);
    document.removeEventListener("click", onImageClick, true);
    document.removeEventListener("keydown", onEsc, true);
    document.removeEventListener("contextmenu", onRightClick, true);
    document.documentElement.classList.remove("glyph-hl-mode", "glyph-img-mode");
    overlay = null;
    card = null;
    hlOutline = null;
    hlLockedOutline = null;
    hlLockedRect = null;
    imgOutline = null;
    imgLockedOutline = null;
    imgLockedRect = null;
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
      if (box) {
        releasePin(box);
        box.remove();
      }
      removeCards();
      card = null;
      box = document.createElement("div");
      box.className = "glyph-box";
      overlay.appendChild(box);
      positionBox(box, startX, startY, startX, startY);
      // The drag-start corner stays on the content if the page scrolls mid-drag.
      snipDrag = { pin: makePin(startX, startY), x2: startX, y2: startY, box };
      ensurePinListener();

      const onMove = (ev) => {
        if (!snipDrag || snipDrag.box !== box) return;
        snipDrag.x2 = ev.clientX;
        snipDrag.y2 = ev.clientY;
        const start = clientFromPin(snipDrag.pin) || { x: startX, y: startY };
        positionBox(box, start.x, start.y, ev.clientX, ev.clientY);
      };
      const onUp = async (ev) => {
        overlay.removeEventListener("mousemove", onMove);
        overlay.removeEventListener("mouseup", onUp);
        const start = (snipDrag && snipDrag.box === box && clientFromPin(snipDrag.pin)) || { x: startX, y: startY };
        snipDrag = null;
        const rect = {
          x: Math.min(start.x, ev.clientX),
          y: Math.min(start.y, ev.clientY),
          w: Math.abs(ev.clientX - start.x),
          h: Math.abs(ev.clientY - start.y),
        };
        // Keep the green box around a successful snip until dismiss.
        if (rect.w > 8 && rect.h > 8) {
          positionBox(box, start.x, start.y, ev.clientX, ev.clientY);
          pinElement(box, rect.x + rect.w / 2, rect.y + rect.h / 2);
          captureAndIdentify(rect);
        } else {
          releasePin(box);
          box.remove();
          box = null;
          if (!pinned.size) stopPinListener();
        }
      };
      overlay.addEventListener("mousemove", onMove);
      overlay.addEventListener("mouseup", onUp);
    });
  }

  // Fixed chrome tracks the element under the selection, so window and nested
  // scrolling both keep the box and card on the same part of the page.
  function pageAnchorAt(clientX, clientY) {
    const x = Math.min(window.innerWidth - 1, Math.max(0, clientX));
    const y = Math.min(window.innerHeight - 1, Math.max(0, clientY));
    let stack = [];
    try {
      stack = document.elementsFromPoint(x, y);
    } catch (err) {
      stack = [];
    }
    for (const el of stack) {
      if (!el || el === document.body || el === document.documentElement) continue;
      if (el.closest && el.closest(".glyph-overlay, .glyph-box, .glyph-card, .glyph-hl-outline")) continue;
      return el;
    }
    return document.documentElement;
  }

  function makePin(clientX, clientY) {
    const anchor = pageAnchorAt(clientX, clientY);
    const rect = anchor.getBoundingClientRect();
    return { anchor, dx: clientX - rect.left, dy: clientY - rect.top };
  }

  function clientFromPin(pin) {
    if (!pin || !pin.anchor || !pin.anchor.isConnected) return null;
    const rect = pin.anchor.getBoundingClientRect();
    return { x: rect.left + pin.dx, y: rect.top + pin.dy };
  }

  function liveOrigin(el, fallback) {
    return clientFromPin(el && el._glyphPin) || fallback;
  }

  function ensurePinListener() {
    if (pinListening) return;
    pinListening = true;
    window.addEventListener("scroll", schedulePinSync, true);
    window.addEventListener("resize", schedulePinSync);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("scroll", schedulePinSync);
      window.visualViewport.addEventListener("resize", schedulePinSync);
    }
  }

  function stopPinListener() {
    if (!pinListening) return;
    pinListening = false;
    window.removeEventListener("scroll", schedulePinSync, true);
    window.removeEventListener("resize", schedulePinSync);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("scroll", schedulePinSync);
      window.visualViewport.removeEventListener("resize", schedulePinSync);
    }
    if (pinRaf) {
      cancelAnimationFrame(pinRaf);
      pinRaf = 0;
    }
  }

  function schedulePinSync() {
    if (pinRaf) return;
    pinRaf = requestAnimationFrame(syncPinned);
  }

  function syncPinned() {
    pinRaf = 0;
    if (snipDrag && snipDrag.box.isConnected) {
      const start = clientFromPin(snipDrag.pin);
      if (start) positionBox(snipDrag.box, start.x, start.y, snipDrag.x2, snipDrag.y2);
    }
    for (const el of pinned) {
      if (!el.isConnected) {
        pinned.delete(el);
        continue;
      }
      const next = clientFromPin(el._glyphPin);
      if (!next) continue;
      el.style.left = next.x + "px";
      el.style.top = next.y + "px";
    }
    if (!pinned.size && !snipDrag) stopPinListener();
  }

  function pinElement(el, sampleX, sampleY) {
    if (!el) return;
    releasePin(el);
    const anchor = pageAnchorAt(sampleX, sampleY);
    const rect = anchor.getBoundingClientRect();
    el._glyphPin = {
      anchor,
      dx: (parseFloat(el.style.left) || 0) - rect.left,
      dy: (parseFloat(el.style.top) || 0) - rect.top,
    };
    pinned.add(el);
    ensurePinListener();
  }

  function pinSharing(el, source) {
    const anchor = source && source._glyphPin && source._glyphPin.anchor;
    if (!el) return;
    if (!anchor || !anchor.isConnected) {
      const sample = el._glyphPinAt;
      if (sample) pinElement(el, sample.x, sample.y);
      else pinElement(el, parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0);
      return;
    }
    releasePin(el);
    const rect = anchor.getBoundingClientRect();
    el._glyphPin = {
      anchor,
      dx: (parseFloat(el.style.left) || 0) - rect.left,
      dy: (parseFloat(el.style.top) || 0) - rect.top,
    };
    pinned.add(el);
    ensurePinListener();
  }

  function pinCard(node) {
    const source = mode === "snip"
      ? document.querySelector(".glyph-box")
      : mode === "highlight"
        ? hlLockedOutline
        : mode === "image"
          ? imgLockedOutline
          : null;
    pinSharing(node, source);
  }

  function releasePin(el) {
    if (!el) return;
    pinned.delete(el);
    el._glyphPin = null;
  }

  function releaseAllPins() {
    snipDrag = null;
    pinned.clear();
    stopPinListener();
  }

  function removeCards() {
    document.querySelectorAll(".glyph-card").forEach((node) => {
      releasePin(node);
      node.remove();
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

  // WhatFontIs matches shapes, and rejects images over a few megabytes.
  // A JPEG at a modest size stays under that cap without the PNG upscale.
  function prepareMatchImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxLong = 1400;
        const minShort = 280;
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
          resolve(canvas.toDataURL("image/jpeg", 0.86));
        } catch (err) {
          resolve("");
        }
      };
      img.onerror = () => resolve("");
      img.src = dataUrl;
    });
  }

  // The file is already the sharpest pixels we have. Downscale only, and give
  // transparent art a matte so JPEG doesn't turn the letters black.
  function prepareSourceImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxLong = 2000;
        const long = Math.max(img.width, img.height, 1);
        const scale = Math.min(1, maxLong / long);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const matte = sourceMatte(ctx, canvas.width, canvas.height);
        if (matte) {
          const copy = document.createElement("canvas");
          copy.width = canvas.width;
          copy.height = canvas.height;
          copy.getContext("2d").drawImage(canvas, 0, 0);
          ctx.fillStyle = matte;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(copy, 0, 0);
        }
        try {
          resolve(canvas.toDataURL("image/jpeg", 0.9));
        } catch (err) {
          resolve("");
        }
      };
      img.onerror = () => resolve("");
      img.src = dataUrl;
    });
  }

  function sourceMatte(ctx, w, h) {
    const points = [];
    const cols = 8;
    const rows = 8;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        points.push([
          Math.min(w - 1, Math.floor(((col + 0.5) * w) / cols)),
          Math.min(h - 1, Math.floor(((row + 0.5) * h) / rows)),
        ]);
      }
    }
    points.push([0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]);
    let lum = 0;
    let count = 0;
    let transparent = false;
    for (const [x, y] of points) {
      let px;
      try {
        px = ctx.getImageData(x, y, 1, 1).data;
      } catch (err) {
        return "";
      }
      if (px[3] < 250) {
        transparent = true;
        continue;
      }
      lum += (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255;
      count += 1;
    }
    if (!transparent) return "";
    return count && lum / count > 0.72 ? "#1a1a18" : "#ffffff";
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

  // Browser zoom repaints the glyphs. A canvas upscale of the same screenshot does not.
  const SHARP_TARGET_EDGE = 800;
  const SHARP_ENOUGH_EDGE = 640;
  const SHARP_MIN_RATIO = 1.2;
  const SHARP_FIT = 0.84;

  function sendRuntime(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res || null);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  async function sharpSnipEnabled() {
    try {
      const data = await chrome.storage.local.get("sharpSnip");
      return !!data.sharpSnip;
    } catch (err) {
      return false;
    }
  }

  function sharpZoomRatio(rect) {
    const dpr = window.devicePixelRatio || 1;
    const short = Math.min(rect.w, rect.h);
    if (short < 1 || short * dpr >= SHARP_ENOUGH_EDGE) return 0;
    const want = SHARP_TARGET_EDGE / (short * dpr);
    const fitW = (SHARP_FIT * window.innerWidth) / rect.w;
    const fitH = (SHARP_FIT * window.innerHeight) / rect.h;
    const ratio = Math.min(want, fitW, fitH);
    if (!Number.isFinite(ratio) || ratio < SHARP_MIN_RATIO) return 0;
    return Math.round(ratio * 100) / 100;
  }

  function setSnipHold(on) {
    if (!overlay) return;
    overlay.classList.toggle("glyph-overlay--hold", on);
    overlay.classList.toggle("glyph-overlay--dark", on && darkTheme);
  }

  function caretFromPoint(x, y) {
    const cx = Math.min(window.innerWidth - 1, Math.max(0, x));
    const cy = Math.min(window.innerHeight - 1, Math.max(0, y));
    try {
      const range = document.caretRangeFromPoint(cx, cy);
      if (range && range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE) return range;
    } catch (err) {
      return null;
    }
    return null;
  }

  // Live text only. A zoomed screenshot of a picture is the same pixels, drawn bigger.
  function textRangeInRect(rect) {
    const hits = [];
    const cols = Math.min(10, Math.max(2, Math.ceil(rect.w / 18)));
    const rows = Math.min(8, Math.max(1, Math.ceil(rect.h / 14)));
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const caret = caretFromPoint(
          rect.x + (rect.w * (col + 0.5)) / cols,
          rect.y + (rect.h * (row + 0.5)) / rows
        );
        if (caret) hits.push(caret);
      }
    }
    if (!hits.length) return null;
    hits.sort((a, b) => {
      try {
        return a.compareBoundaryPoints(Range.START_TO_START, b);
      } catch (err) {
        return 0;
      }
    });
    const range = document.createRange();
    const first = hits[0];
    const last = hits[hits.length - 1];
    try {
      range.setStart(first.startContainer, first.startOffset);
      const endNode = last.startContainer;
      let endOffset = last.startOffset;
      if (endNode.nodeType === Node.TEXT_NODE && endOffset < endNode.data.length) endOffset += 1;
      range.setEnd(endNode, endOffset);
    } catch (err) {
      return null;
    }
    return range.collapsed ? null : range;
  }

  function anchorFraction(anchor, rect) {
    if (!anchor || !anchor.getBoundingClientRect) return null;
    const box = anchor.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    return {
      anchor,
      dx: (rect.x - box.left) / box.width,
      dy: (rect.y - box.top) / box.height,
      dw: rect.w / box.width,
      dh: rect.h / box.height,
    };
  }

  function rectFromFraction(saved) {
    if (!saved || !saved.anchor || !saved.anchor.isConnected) return null;
    const box = saved.anchor.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    return {
      x: box.left + saved.dx * box.width,
      y: box.top + saved.dy * box.height,
      w: saved.dw * box.width,
      h: saved.dh * box.height,
    };
  }

  function rectFromRange(range) {
    let rects;
    try {
      rects = range.getClientRects();
    } catch (err) {
      return null;
    }
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    let count = 0;
    for (const part of rects) {
      if (part.width < 1 || part.height < 1) continue;
      count += 1;
      x1 = Math.min(x1, part.left);
      y1 = Math.min(y1, part.top);
      x2 = Math.max(x2, part.right);
      y2 = Math.max(y2, part.bottom);
    }
    if (!count) return null;
    const pad = 3;
    return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
  }

  function measuredSnipRect(range, fraction, original) {
    const fromRange = range ? rectFromRange(range) : null;
    const fromAnchor = rectFromFraction(fraction);
    if (fromRange && fromRange.w <= original.w * 2.2 + 24 && fromRange.h <= original.h * 3 + 24) return fromRange;
    return fromAnchor || fromRange;
  }

  function isScrollable(node) {
    if (!node || node.nodeType !== 1) return false;
    let style;
    try {
      style = getComputedStyle(node);
    } catch (err) {
      return false;
    }
    const scrollY = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2;
    const scrollX = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 2;
    return scrollX || scrollY;
  }

  function snapshotScrolls(anchor) {
    const items = [];
    const seen = new Set();
    const add = (node, left, top) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      items.push({ node, left, top });
    };
    let node = anchor && anchor.nodeType === 1 ? anchor : anchor && anchor.parentElement;
    while (node) {
      if (isScrollable(node) || node === document.scrollingElement || node === document.documentElement || node === document.body) {
        add(node, node.scrollLeft, node.scrollTop);
      }
      node = node.parentElement;
    }
    add(window, window.scrollX, window.scrollY);
    return items;
  }

  function restoreScrolls(items) {
    if (!items) return;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.node === window) {
        window.scrollTo(item.left, item.top);
        continue;
      }
      if (!item.node.isConnected) continue;
      item.node.scrollLeft = item.left;
      item.node.scrollTop = item.top;
    }
  }

  function nudgeScroll(start, dx, dy) {
    let node = start && start.nodeType === 1 ? start : start && start.parentElement;
    while (node) {
      if (isScrollable(node)) {
        const maxX = Math.max(0, node.scrollWidth - node.clientWidth);
        const maxY = Math.max(0, node.scrollHeight - node.clientHeight);
        const left = Math.min(maxX, Math.max(0, node.scrollLeft + dx));
        const top = Math.min(maxY, Math.max(0, node.scrollTop + dy));
        const usedX = left - node.scrollLeft;
        const usedY = top - node.scrollTop;
        if (usedX || usedY) {
          node.scrollLeft = left;
          node.scrollTop = top;
          dx -= usedX;
          dy -= usedY;
        }
      }
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      node = node.parentElement;
    }
    window.scrollBy(dx, dy);
  }

  function rangeStartElement(range) {
    const node = range && range.startContainer;
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  async function waitForViewportWidth(fromWidth, untilChanged) {
    const start = Date.now();
    while (Date.now() - start < 800) {
      const delta = Math.abs(window.innerWidth - fromWidth);
      if (untilChanged ? delta > 1 : delta < 2) break;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  async function centerSnipRect(getRect, anchor) {
    let rect = getRect();
    for (let i = 0; i < 5 && rect; i++) {
      const dx = (rect.x + rect.w / 2) - window.innerWidth / 2;
      const dy = (rect.y + rect.h / 2) - window.innerHeight / 2;
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) break;
      nudgeScroll(anchor, dx, dy);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      rect = getRect();
    }
    return rect;
  }

  function withOverlayHidden(read) {
    if (!overlay) return read();
    const prev = overlay.style.visibility;
    overlay.style.visibility = "hidden";
    try {
      return read();
    } finally {
      overlay.style.visibility = prev;
    }
  }

  async function captureSharperCrop(rect, alive, stillCurrent) {
    const ratio = sharpZoomRatio(rect);
    if (!ratio || !alive()) return "";
    // The snip overlay sits above the page, so caret hit-testing has to see through it.
    const sampled = withOverlayHidden(() => ({
      range: textRangeInRect(rect),
      anchor: pageAnchorAt(rect.x + rect.w / 2, rect.y + rect.h / 2),
    }));
    const range = sampled.range;
    const anchor = sampled.anchor;
    // Pictures stay at the normal capture. Live text and framed pages are redrawn by the zoom.
    if (!range && (!anchor || anchor.tagName !== "IFRAME")) return "";
    const fraction = anchorFraction(anchor, rect);
    const scrolls = snapshotScrolls(rangeStartElement(range) || anchor);
    const widthBefore = window.innerWidth;
    setSnipHold(true);
    let zoomId = 0;
    let zoomState = null;
    try {
      const begun = await sendRuntime({ type: "GLYPH_ZOOM_BEGIN", ratio });
      if (begun && begun.ok) {
        zoomId = begun.id;
        zoomState = begun.zoom || null;
      }
      if (!zoomId || !alive()) return "";
      await waitForViewportWidth(widthBefore, true);
      if (!alive()) return "";
      const scrollFrom = rangeStartElement(range) || anchor;
      const next = await centerSnipRect(() => measuredSnipRect(range, fraction, rect), scrollFrom);
      if (!alive() || !next || next.w < 8 || next.h < 8) return "";
      const viewW = window.innerWidth;
      const res = await captureScreen();
      if (!alive() || !res?.dataUrl) return "";
      return await cropImage(res.dataUrl, clampCaptureRect(next), viewW);
    } catch (err) {
      return "";
    } finally {
      if (zoomId) await sendRuntime({ type: "GLYPH_ZOOM_END", id: zoomId, zoom: zoomState });
      if (zoomId && stillCurrent()) {
        await waitForViewportWidth(widthBefore, false);
        restoreScrolls(scrolls);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        restoreScrolls(scrolls);
      }
      if (stillCurrent()) setSnipHold(false);
    }
  }

  async function captureAndIdentify(rect) {
    const serial = ++snipCaptureSerial;
    const generation = snipGeneration;
    const alive = () => serial === snipCaptureSerial && generation === snipGeneration && mode === "snip";
    const stillCurrent = () => serial === snipCaptureSerial;
    const getPoint = () => liveOrigin(document.querySelector(".glyph-box"), { x: rect.x, y: rect.y });
    let cropped = "";
    if (await sharpSnipEnabled()) cropped = await captureSharperCrop(rect, alive, stillCurrent);
    if (!alive()) return;
    if (!cropped) {
      const res = await captureScreen();
      if (!alive()) return;
      if (!res?.dataUrl) {
        const at = getPoint();
        showCard(at.x, at.y, "Couldn't capture the screen. Try again.");
        return;
      }
      cropped = await cropImage(res.dataUrl, clampCaptureRect(rect));
    }
    if (!alive()) return;
    if (!cropped) {
      const at = getPoint();
      showCard(at.x, at.y, "Couldn't capture the screen. Try again.");
      return;
    }
    await finishIdentify(getPoint, cropped, { alive });
  }

  async function finishIdentify(getPoint, raw, options) {
    const alive = (options && options.alive) || (() => true);
    const sourceImage = !!(options && options.sourceImage);
    if (!alive()) return;
    const at = getPoint();
    showCard(at.x, at.y, "Identifying font…");
    const stored = await chrome.storage.local.get(["apiKey", "snipModel"]);
    if (!alive()) return;
    try {
      const image = raw
        ? await (sourceImage ? prepareSourceImage(raw) : prepareMatchImage(raw))
        : "";
      const imageUrl = image ? "" : ((options && options.imageUrl) || "");
      if (!image && !imageUrl) {
        if (alive()) updateCard(sourceImage
          ? "Couldn't read that image. Try snipping the letters."
          : "Couldn't capture the screen. Try again.");
        return;
      }
      const sampledColor = raw ? await sampleTextColor(image || raw) : "";
      if (!alive()) return;
      const claudeFallback = typeof stored.snipModel === "string" && stored.snipModel.startsWith("claude-");
      const fallbackImage = claudeFallback && String(stored.apiKey || "").trim() && raw
        ? await prepareIdentifyImage(raw)
        : "";
      if (!alive()) return;
      const result = await identifyFont(image, fallbackImage, {
        detectText: !!(options && options.detectText),
        imageUrl,
      });
      if (!alive()) return;
      const faces = Array.isArray(result?.fonts) && result.fonts.length ? result.fonts : [result];
      const formatted = result?.engine === "whatfontis"
        ? [formatMatchResult(faces[0], sampledColor)]
        : faces.map((face) => formatIdentifyResult(face, faces.length === 1 ? sampledColor : ""));
      if (result?.fallback) {
        formatted.forEach((content) => {
          if (content && content.properties) content.properties.push({ value: "Closest guess" });
        });
      }
      const placed = getPoint();
      showResultCards(placed.x, placed.y, formatted);
      const previewSource = image || raw;
      if (previewSource && await historySavingEnabled()) {
        const preview = await compressPreview(previewSource);
        if (!alive()) return;
        for (const entry of formatted) await rememberResult(entry, preview);
      }
    } catch (err) {
      if (!alive()) return;
      if (err && err.code === "snip_limit") {
        showSnipLimit(err.resetAt);
        return;
      }
      updateCard(identifyErrorMessage(err));
    }
  }

  function nextWfiReset(now = Date.now()) {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  }

  function formatSnipReset(resetAt, now = Date.now()) {
    const end = Number(resetAt) || nextWfiReset(now);
    const minutes = Math.max(1, Math.ceil(Math.max(0, end - now) / 60000));
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours && mins) return `Resets in ${hours}h ${mins}m`;
    if (hours) return `Resets in ${hours}h`;
    return `Resets in ${mins}m`;
  }

  function showSnipLimit(resetAt) {
    const text = `Snip Limit Reached\n${formatSnipReset(resetAt)}`;
    const x = Math.max(12, Math.round(window.innerWidth / 2 - 110));
    const y = Math.max(12, Math.round(window.innerHeight / 3));
    cleanup();
    showCard(x, y, text);
  }

  function identifyErrorMessage(err) {
    switch (err && err.code) {
      case "no_wfi_key":
        return "Snip isn't available right now.";
      case "wfi_unauthorized":
        return "That WhatFontIs key was rejected. Check it in Glyph settings.";
      case "snip_limit":
      case "wfi_quota":
        return `Snip Limit Reached\n${formatSnipReset(err && err.resetAt)}`;
      case "no_chars":
        return "Couldn't separate the letters. Try a clearer line of text.";
      case "no_font":
        return "No font detected in selected area";
      case "wfi_image":
      case "bad_image":
        return "That image couldn't be read. Try a tighter box around the letters.";
      case "wfi_down":
        return "WhatFontIs is busy. Try again in a moment.";
      case "wfi_network":
        return "Couldn't reach WhatFontIs. Try again.";
      case "wfi_failed":
        return "Identification failed. Try again.";
      case "no_key":
        return "Add an Anthropic API key in Glyph settings to guess when letters overlap.";
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

  function cropImage(dataUrl, rect, viewportWidth) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const viewW = viewportWidth || window.innerWidth || img.width;
        const scale = img.width / viewW;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(rect.w * scale));
        canvas.height = Math.max(1, Math.round(rect.h * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(
          img,
          rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale,
          0, 0, canvas.width, canvas.height
        );
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => resolve("");
      img.src = dataUrl;
    });
  }

  function identifyFont(imageDataUrl, fallbackImage, options) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "GLYPH_IDENTIFY",
        image: imageDataUrl,
        fallbackImage: fallbackImage || "",
        detectText: !!(options && options.detectText),
        imageUrl: (options && options.imageUrl) || "",
      }, (res) => {
        if (chrome.runtime.lastError || !res) {
          reject(Object.assign(new Error("network"), { code: "network" }));
          return;
        }
        if (res.error) {
          reject(Object.assign(new Error(res.error), { code: res.error, resetAt: res.resetAt }));
          return;
        }
        resolve(res);
      });
    });
  }

  /* ---------- Image picker ---------- */

  const IMAGE_FETCH_MAX = 18 * 1024 * 1024;

  function startImagePick() {
    document.documentElement.classList.add("glyph-img-mode");
    document.addEventListener("mousemove", onImageMove, true);
    document.addEventListener("click", onImageClick, true);
    document.addEventListener("keydown", onEsc, true);
    document.addEventListener("contextmenu", onRightClick, true);
    imgOutline = makeOutline();
    imgLockedOutline = makeOutline();
    const hint = document.createElement("div");
    hint.className = "glyph-img-hint" + (darkTheme ? " glyph-img-hint--dark" : "");
    hint.textContent = "Click a picture to identify its font";
    document.body.appendChild(hint);
    loadTheme().then(() => {
      if (hint.isConnected) hint.classList.toggle("glyph-img-hint--dark", darkTheme);
    });
  }

  function onImageMove(e) {
    if (mode !== "image" || !imgOutline) return;
    if (isInteractiveGlyphUI(e.target)) {
      imgOutline.style.display = "none";
      return;
    }
    const target = imageTargetFromPoint(e.clientX, e.clientY);
    if (!target || rectsMatch(target.rect, imgLockedRect)) {
      imgOutline.style.display = "none";
      return;
    }
    placeHighlight(imgOutline, target.rect);
  }

  async function onImageClick(e) {
    if (mode !== "image") return;
    if (isInteractiveGlyphUI(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = imageTargetFromPoint(e.clientX, e.clientY);
    if (!target) return;
    const serial = ++snipCaptureSerial;
    const generation = snipGeneration;
    const alive = () => serial === snipCaptureSerial && generation === snipGeneration && mode === "image";
    imgLockedRect = target.rect;
    if (imgOutline) imgOutline.style.display = "none";
    placeHighlight(imgLockedOutline, target.rect);
    pinElement(
      imgLockedOutline,
      target.rect.left + target.rect.width / 2,
      target.rect.top + target.rect.height / 2
    );
    const point = { x: e.clientX, y: e.clientY };
    const anchorLeft = target.rect.left;
    const anchorTop = target.rect.top;
    const getPoint = () => {
      const origin = liveOrigin(imgLockedOutline, { x: anchorLeft, y: anchorTop });
      return {
        x: point.x - anchorLeft + origin.x,
        y: point.y - anchorTop + origin.y,
      };
    };
    const at = getPoint();
    showCard(at.x, at.y, "Reading image…");
    let raw = "";
    try {
      raw = await rasterFromTarget(target);
    } catch (err) {
      raw = "";
    }
    if (!alive()) return;
    await finishIdentify(getPoint, raw, {
      alive,
      sourceImage: true,
      detectText: true,
      imageUrl: publicHttpUrl(target.url),
    });
  }

  function imageTargetFromPoint(x, y) {
    let stack = [];
    try {
      stack = document.elementsFromPoint(x, y);
    } catch (err) {
      stack = [];
    }
    const page = [];
    for (const el of stack) {
      if (!el || isGlyphUI(el)) continue;
      if (el.closest && el.closest(".glyph-overlay, .glyph-card")) return null;
      page.push(el);
    }
    for (const el of page) {
      if (el === document.body || el === document.documentElement) break;
      const isPicture = el.tagName === "IMG"
        || el.tagName === "PICTURE"
        || el.tagName === "CANVAS"
        || (el.localName === "image" && el.namespaceURI === "http://www.w3.org/2000/svg");
      if (!isPicture) continue;
      // A tiny icon should not fall through to the page background behind it.
      return directImageTarget(el);
    }
    let node = page[0];
    for (let depth = 0; depth < 4 && node && node !== document.body && node !== document.documentElement; depth++) {
      const background = backgroundImageTarget(node);
      if (background) return background;
      node = node.parentElement;
    }
    return null;
  }

  function directImageTarget(el) {
    const img = el.tagName === "IMG"
      ? el
      : (el.tagName === "PICTURE" ? el.querySelector("img") : null);
    if (img) {
      const rect = imageBox(img);
      if (!rect || img.naturalWidth < 8 || img.naturalHeight < 8) return null;
      return { el: img, rect, url: bestRasterUrl(img), kind: "img" };
    }
    if (el.localName === "image" && el.namespaceURI === "http://www.w3.org/2000/svg") {
      const rect = imageBox(el);
      const href = el.getAttribute("href") || el.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
      const url = resolvePageUrl(href);
      if (!rect || !url) return null;
      return { el, rect, url, kind: "svg-image" };
    }
    if (el.tagName === "CANVAS") {
      const rect = imageBox(el);
      if (!rect || el.width < 32 || el.height < 32) return null;
      return { el, rect, url: "", kind: "canvas" };
    }
    return null;
  }

  function imageBox(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 12 || rect.height < 12) return null;
    const long = Math.max(rect.width, rect.height);
    const short = Math.min(rect.width, rect.height);
    if (long < 72 && short < 48) return null;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return null;
    return rect;
  }

  function backgroundImageTarget(el) {
    let style;
    try {
      style = getComputedStyle(el);
    } catch (err) {
      return null;
    }
    const bg = style.backgroundImage || "";
    if (!bg || bg === "none" || bg.indexOf("url(") === -1) return null;
    if (style.backgroundRepeat !== "no-repeat" && (style.backgroundSize === "auto" || style.backgroundSize === "auto auto")) return null;
    const rect = imageBox(el);
    const url = firstCssUrl(bg);
    if (!rect || !url) return null;
    return { el, rect, url, kind: "background" };
  }

  function resolvePageUrl(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    if (value.startsWith("data:") || value.startsWith("blob:")) return value;
    try {
      return new URL(value, document.baseURI).href;
    } catch (err) {
      return "";
    }
  }

  function publicHttpUrl(raw) {
    try {
      const url = new URL(String(raw || ""), document.baseURI);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      if (url.username || url.password) return "";
      return url.href;
    } catch (err) {
      return "";
    }
  }

  function firstCssUrl(value) {
    const match = String(value || "").match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);
    if (!match) return "";
    return resolvePageUrl(match[2]);
  }

  function srcsetCandidates(value) {
    const list = [];
    const re = /(\S+)\s+(\d+(?:\.\d+)?)([wx])\b/g;
    let match;
    const source = String(value || "");
    while ((match = re.exec(source))) {
      list.push({ url: match[1], amount: parseFloat(match[2]), unit: match[3] });
    }
    return list;
  }

  function bestRasterUrl(img) {
    const current = resolvePageUrl(img.currentSrc || img.getAttribute("src") || "");
    const pools = [];
    if (img.getAttribute("srcset")) pools.push(img.getAttribute("srcset"));
    const picture = img.closest && img.closest("picture");
    if (picture) {
      picture.querySelectorAll("source[srcset]").forEach((source) => {
        pools.push(source.getAttribute("srcset"));
      });
    }
    for (const pool of pools) {
      const cands = srcsetCandidates(pool).map((cand) => ({
        url: resolvePageUrl(cand.url),
        amount: cand.amount,
        unit: cand.unit,
      })).filter((cand) => cand.url);
      const ownsCurrent = !!current && cands.some((cand) => cand.url.split("#")[0] === current.split("#")[0]);
      if (!ownsCurrent) continue;
      const widths = cands.filter((cand) => cand.unit === "w");
      const densities = cands.filter((cand) => cand.unit === "x");
      const poolCands = widths.length ? widths : densities;
      const widest = poolCands.reduce((best, cand) => (!best || cand.amount > best.amount ? cand : best), null);
      if (widest) return widest.url;
    }
    return current;
  }

  function drawImageElement(el) {
    const w = el.naturalWidth || el.width || 0;
    const h = el.naturalHeight || el.height || 0;
    if (w < 2 || h < 2) return "";
    try {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(el, 0, 0, w, h);
      return canvas.toDataURL("image/png");
    } catch (err) {
      return "";
    }
  }

  function blobToDataUrlInPage(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
  }

  async function fetchImageBlob(url) {
    const attempts = [{ credentials: "omit", mode: "cors" }];
    if (!url.startsWith("data:")) attempts.push({ credentials: "include", mode: "cors" });
    for (const init of attempts) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (!blob.size || blob.size > IMAGE_FETCH_MAX) continue;
        const type = blob.type || "";
        if (type && !type.startsWith("image/") && type !== "application/octet-stream") continue;
        return blob;
      } catch (err) {
        // The next attempt, or the extension fetch, may still be able to read it.
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  function decodeImageUrl(url) {
    return new Promise((resolve) => {
      const img = new Image();
      if (!url.startsWith("data:") && !url.startsWith("blob:")) img.crossOrigin = "anonymous";
      img.onload = () => resolve(drawImageElement(img));
      img.onerror = () => resolve("");
      img.src = url;
    });
  }

  async function rasterFromTarget(target) {
    if (target.kind === "canvas") return drawImageElement(target.el);
    const current = target.kind === "img" ? (target.el.currentSrc || target.el.src || "") : "";
    const larger = !!(target.url && current && target.url.split("#")[0] !== current.split("#")[0]);
    if (!larger && target.kind === "img") {
      const drawn = drawImageElement(target.el);
      if (drawn) return drawn;
    }
    if (target.url && target.url.startsWith("data:image/")) return target.url;
    if (target.url) {
      const blob = await fetchImageBlob(target.url);
      if (blob) {
        const dataUrl = await blobToDataUrlInPage(blob);
        if (dataUrl) return dataUrl;
      }
      const decoded = await decodeImageUrl(target.url);
      if (decoded) return decoded;
      if (publicHttpUrl(target.url)) {
        const viaExt = await sendRuntime({ type: "GLYPH_FETCH_IMAGE", url: target.url });
        if (viaExt && viaExt.dataUrl) return viaExt.dataUrl;
      }
    }
    if (target.kind === "img") return drawImageElement(target.el);
    return "";
  }

  /* ---------- Highlight tool ---------- */

  const GLYPH_UI = ".glyph-overlay, .glyph-box, .glyph-card, .glyph-hl-outline, .glyph-img-hint";
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
    pinElement(
      hlLockedOutline,
      target.rect.left + target.rect.width / 2,
      target.rect.top + target.rect.height / 2
    );
    const outlineLeft = parseFloat(hlLockedOutline.style.left) || 0;
    const outlineTop = parseFloat(hlLockedOutline.style.top) || 0;
    const cardShift = { dx: point.x - outlineLeft, dy: point.y - outlineTop };
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
    const origin = liveOrigin(hlLockedOutline, { x: outlineLeft, y: outlineTop });
    showCard(origin.x + cardShift.dx, origin.y + cardShift.dy, content, { hidden: true });
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
    return {
      properties,
      styles,
      swatchColor: cs.color,
      css: cssFromElement(el, painted),
      fontStack: splitFontFamily(cs.fontFamily),
    };
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
    removeCards();
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
    const pinAt = {
      x: target.rect.left + target.rect.width / 2,
      y: target.rect.top + target.rect.height / 2,
    };
    if (card && !mode) {
      updateCard(target.content);
      card.style.left = Math.min(x, window.innerWidth - 280) + "px";
      card.style.top = Math.min(y + 12, window.innerHeight - 80) + "px";
      card._glyphPinAt = pinAt;
      card.classList.toggle("glyph-card--copy-below", card.getBoundingClientRect().top < 32);
      pinCard(card);
    } else {
      showCard(x, y, target.content, { keepTool: true, pinAt });
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
  const CSS_ICON =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6.2 4.2 3 8l3.2 3.8" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.8 4.2 13 8l-3.2 3.8" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const GFONTS_ICON =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2.6 13 8 3 13.4 13" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.7 9.3h6.6" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>';
  const NO_SOURCE_ICON =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.45"/><path d="M4.3 11.7 11.7 4.3" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>';
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

  function quoteCssFamily(name) {
    const cleaned = String(name || "").replace(/["']/g, "").trim();
    if (!cleaned || cleaned.toLowerCase() === "unknown") return "";
    if (GENERIC_FONT_FAMILIES.has(cleaned.toLowerCase())) return cleaned;
    return `"${cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  function cssDeclarations(fields) {
    const lines = [];
    const push = (prop, value) => {
      const v = String(value || "").trim();
      if (v) lines.push(`${prop}: ${v};`);
    };
    push("font-family", fields.family);
    push("font-size", fields.size);
    push("font-weight", fields.weight);
    push("font-style", fields.style);
    push("line-height", fields.lineHeight);
    push("letter-spacing", fields.letterSpacing);
    push("color", fields.color);
    push("text-decoration", fields.decoration);
    push("text-transform", fields.transform);
    return lines.join("\n");
  }

  function toCssColor(cssColor) {
    const s = String(cssColor || "").trim();
    const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i);
    if (!m) return s;
    const hex = "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
    const alpha = m[4] === undefined ? 1 : Number(m[4]);
    if (!(alpha < 1)) return hex;
    const a = Math.max(0, Math.min(255, Math.round(alpha * 255)));
    return hex + a.toString(16).padStart(2, "0");
  }

  function meaningfulSpacing(value) {
    const s = String(value || "").trim();
    if (!s || s === "normal" || s === "0" || s === "0px") return "";
    return s;
  }

  function textDecorationValue(el) {
    const found = [];
    const seen = new Set();
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      const line = getComputedStyle(node).textDecorationLine || "";
      for (const part of line.split(/\s+/)) {
        if (!part || part === "none" || seen.has(part)) continue;
        seen.add(part);
        found.push(part);
      }
      const tag = node.tagName;
      if ((tag === "U" || tag === "INS") && !seen.has("underline")) {
        seen.add("underline");
        found.push("underline");
      }
      node = node.parentElement;
    }
    return found.join(" ");
  }

  function cssFromElement(el, painted) {
    const cs = getComputedStyle(el);
    const families = [];
    const seen = new Set();
    for (const name of [painted && painted.primary, ...((painted && painted.fallbacks) || [])]) {
      const quoted = quoteCssFamily(name);
      const key = quoted.toLowerCase();
      if (!quoted || seen.has(key)) continue;
      seen.add(key);
      families.push(quoted);
    }
    const weightNum = Math.max(numericFontWeight(cs.fontWeight), variationWeight(cs));
    const transform = String(cs.textTransform || "").trim();
    return cssDeclarations({
      family: families.join(", "),
      size: cs.fontSize,
      weight: weightNum ? String(Math.round(weightNum)) : String(cs.fontWeight || "").trim(),
      style: String(cs.fontStyle || "normal").trim(),
      lineHeight: String(cs.lineHeight || "").trim(),
      letterSpacing: meaningfulSpacing(cs.letterSpacing),
      color: toCssColor(cs.color),
      decoration: textDecorationValue(el),
      transform: transform && transform !== "none" ? transform : "",
    });
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

  function cardTools(host) {
    let tools = host.querySelector(".glyph-card-tools");
    if (!tools) {
      tools = document.createElement("div");
      tools.className = "glyph-card-tools";
      host.appendChild(tools);
    }
    return tools;
  }

  function labelMissingFontSource(mark, family) {
    const name = String(family || "").trim();
    const label = name ? `No font page found for ${name}` : "No font page found";
    mark.title = label;
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", label);
  }

  function applyMissingFontSource(host, family, pending) {
    host.classList.add("glyph-card--has-gfonts");
    let mark = host.querySelector(".glyph-card-gfonts");
    if (!mark || !mark.classList.contains("glyph-card-gfonts--none")) {
      if (mark) mark.remove();
      mark = document.createElement("span");
      mark.className = "glyph-card-gfonts glyph-card-gfonts--none";
      mark.innerHTML = NO_SOURCE_ICON;
      cardTools(host).appendChild(mark);
    }
    mark.classList.toggle("glyph-card-gfonts--pending", !!pending);
    if (pending) {
      const name = String(family || "").trim();
      const label = name ? `Checking font sites for ${name}` : "Checking font sites";
      mark.title = label;
      mark.setAttribute("role", "img");
      mark.setAttribute("aria-label", label);
      return;
    }
    labelMissingFontSource(mark, family);
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
    if (!link || link.tagName !== "BUTTON") {
      if (link) link.remove();
      link = document.createElement("button");
      link.type = "button";
      link.className = "glyph-card-gfonts";
      link.innerHTML = GFONTS_ICON;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const href = link.dataset.url;
        if (href) window.open(href, "_blank", "noopener,noreferrer");
      });
      cardTools(host).appendChild(link);
    }
    const label = source.label || "Font source";
    link.dataset.url = url;
    link.title = "View on " + label;
    link.setAttribute("aria-label", `View ${family} on ${label}`);
  }

  function syncCssButton(host, content) {
    const css = content && typeof content.css === "string" ? content.css.trim() : "";
    let btn = host.querySelector(".glyph-card-css");
    if (!css) {
      if (btn) btn.remove();
      host.classList.remove("glyph-card--has-css");
      return;
    }
    host.classList.add("glyph-card--has-css");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "glyph-card-css";
      btn.title = "Copy CSS";
      btn.setAttribute("aria-label", "Copy CSS");
      btn.innerHTML = CSS_ICON;
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = btn._glyphCss || "";
        if (!text || !(await copyText(text))) return;
        btn.innerHTML = CHECK_ICON;
        btn.classList.add("glyph-card-css--done");
        btn.title = "Copied";
        btn.setAttribute("aria-label", "Copied");
        clearTimeout(btn._glyphCopyTimer);
        btn._glyphCopyTimer = setTimeout(() => {
          if (!btn.isConnected) return;
          btn.innerHTML = CSS_ICON;
          btn.classList.remove("glyph-card-css--done");
          btn.title = "Copy CSS";
          btn.setAttribute("aria-label", "Copy CSS");
        }, 1200);
      });
      cardTools(host).appendChild(btn);
    }
    btn._glyphCss = css;
  }

  function isPrivateFontName(name) {
    const family = String(name || "").trim();
    if (family.startsWith("__")) return true;
    return /_[a-f0-9]{6,}$/i.test(family);
  }

  function sourceNameCandidates(content) {
    const names = [];
    const add = (name) => {
      const cleaned = String(name || "").replace(/["']/g, "").trim();
      if (!cleaned || !canResolveFontSource(cleaned) || isPrivateFontName(cleaned)) return;
      if (names.some((item) => item.toLowerCase() === cleaned.toLowerCase())) return;
      names.push(cleaned);
    };
    add(fontNameFromContent(content));
    const stack = content && content.fontStack;
    if (Array.isArray(stack)) stack.forEach(add);
    const props = content && content.properties;
    if (Array.isArray(props)) {
      props.forEach((prop) => {
        if (!prop || !prop.after || !/for some characters/i.test(prop.after)) return;
        String(prop.value || "").split(",").forEach(add);
      });
    }
    return names.slice(0, 4);
  }

  async function syncFontSourceButton(host, content) {
    const token = (host._glyphSourceToken = (host._glyphSourceToken || 0) + 1);
    const names = sourceNameCandidates(content);
    const primary = names[0] || "";
    const family = primary || fontNameFromContent(content);
    // Keep a no symbol in the slot until a catalog confirms a real page.
    // A guessed Google Fonts specimen link opens a missing font page.
    if (primary) applyMissingFontSource(host, family, true);
    for (const candidate of names) {
      const source = await requestFontSource(candidate);
      if (!host.isConnected || host._glyphSourceToken !== token) return;
      if (source && source.url) {
        applyFontSourceButton(host, candidate, source);
        return;
      }
    }
    if (!host.isConnected || host._glyphSourceToken !== token) return;
    const matchUrl = content && content.matchUrl;
    if (matchUrl) {
      applyFontSourceButton(host, fontNameFromContent(content), { url: matchUrl, label: "WhatFontIs" });
      return;
    }
    if (primary) applyMissingFontSource(host, family, false);
    else applyFontSourceButton(host, family, null);
  }

  const HISTORY_KEY = "fontHistory";
  const SAVE_HISTORY_KEY = "saveFontHistory";
  const HISTORY_LIMIT = 20;

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
    if (content.matchUrl) entry.matchUrl = content.matchUrl;
    if (typeof content.css === "string" && content.css.trim()) entry.css = content.css.trim();
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

  function formatMatchResult(data, sampledColor) {
    const font = data?.font || "Unknown";
    const properties = [{ value: font }];
    if (data?.license === "Free" || data?.license === "Commercial") {
      properties.push({ value: data.license });
    }
    const similars = Array.isArray(data?.similars) ? data.similars.filter(Boolean).slice(0, 3) : [];
    if (similars.length) {
      properties.push({ value: similars.join(", "), before: " · Similar " });
    }
    const color = sampledColor || "";
    if (color) properties.push({ value: color });
    const content = {
      properties,
      styles: [],
      matchUrl: data?.matchUrl || "",
    };
    if (color) content.swatchColor = color;
    content.css = cssDeclarations({
      family: quoteCssFamily(font),
      color: color ? toCssColor(color) : "",
    });
    return content;
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
    content.css = cssDeclarations({
      family: quoteCssFamily(font),
      size: size ? size + "px" : "",
      weight: weight ? String(weight) : "",
      style: data?.italic ? "italic" : "",
      color: color ? toCssColor(color) : "",
      decoration: data?.underline ? "underline" : "",
    });
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
      if (content.includes("\n")) body.style.whiteSpace = "pre-line";
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
    removeCards();
    card = buildCard(content, options);
    if (options && options.pinAt) card._glyphPinAt = options.pinAt;
    placeCard(card, x, y + 12);
    if (options && options.hidden) card.style.visibility = "hidden";
    document.body.appendChild(card);
    if (card.getBoundingClientRect().top < 32) card.classList.add("glyph-card--copy-below");
    pinCard(card);
  }

  function showResultCards(x, y, contents) {
    removeCards();
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
      pinCard(node);
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
    if ((content && content.matchUrl) || (options && options.hidden && canResolveFontSource(fontNameFromContent(content)))) {
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
        releasePin(node);
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
    cardTools(node).appendChild(close);
    syncCssButton(node, content);
    node._glyphSourceReady = syncFontSourceButton(node, content);
    return node;
  }

  function updateCard(content) {
    if (!card) return;
    const body = card.querySelector(".glyph-card-body");
    if (body) fillCardBody(body, content);
    syncCssButton(card, content);
    syncFontSourceButton(card, content);
  }

  initSelectionCard();
})();
