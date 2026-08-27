(() => {
  if (window.__glyphLoaded) return;
  window.__glyphLoaded = true;

  let overlay = null;
  let mode = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "GLYPH_START") {
      cleanup();
      mode = msg.mode;
      chrome.runtime.sendMessage({ type: "GLYPH_MODE_CHANGED", active: true, mode });
      if (mode === "snip") startSnip();
      if (mode === "highlight") startHighlight();
    }
  });

  function cleanup() {
    document.querySelectorAll(".glyph-overlay, .glyph-box, .glyph-card, .glyph-hl-outline").forEach((n) => n.remove());
    document.removeEventListener("mousemove", onHighlightMove, true);
    document.removeEventListener("click", onHighlightClick, true);
    document.removeEventListener("keydown", onEsc, true);
    overlay = null;
    if (mode) {
      chrome.runtime.sendMessage({ type: "GLYPH_MODE_CHANGED", active: false });
      mode = null;
    }
  }

  function onEsc(e) {
    if (e.key === "Escape") cleanup();
  }

  /* ---------- Snip tool ---------- */

  function startSnip() {
    overlay = document.createElement("div");
    overlay.className = "glyph-overlay";
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onEsc, true);

    let startX = 0, startY = 0, box = null;

    overlay.addEventListener("mousedown", (e) => {
      startX = e.clientX;
      startY = e.clientY;
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
        cleanup();
        if (rect.w > 8 && rect.h > 8) captureAndIdentify(rect);
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

  async function captureAndIdentify(rect) {
    const res = await chrome.runtime.sendMessage({ type: "GLYPH_CAPTURE" });
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
      updateCard(result);
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
    const data = await resp.json();
    return `${data.font} (${Math.round(data.confidence * 100)}% match)`;
  }

  /* ---------- Highlight tool ---------- */

  let hlOutline = null;

  function startHighlight() {
    document.addEventListener("mousemove", onHighlightMove, true);
    document.addEventListener("click", onHighlightClick, true);
    document.addEventListener("keydown", onEsc, true);
    hlOutline = document.createElement("div");
    hlOutline.className = "glyph-hl-outline";
    document.body.appendChild(hlOutline);
  }

  function onHighlightMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.classList.contains("glyph-hl-outline")) return;
    const r = el.getBoundingClientRect();
    hlOutline.style.left = r.left + "px";
    hlOutline.style.top = r.top + "px";
    hlOutline.style.width = r.width + "px";
    hlOutline.style.height = r.height + "px";
  }

  function onHighlightClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    const cs = getComputedStyle(el);
    const family = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    const detail = `${family} · ${cs.fontWeight} · ${cs.fontSize}`;
    cleanup();
    showCard(e.clientX, e.clientY, detail);
  }

  /* ---------- Result card ---------- */

  let card = null;

  function showCard(x, y, text) {
    card = document.createElement("div");
    card.className = "glyph-card";
    card.textContent = text;
    const close = document.createElement("button");
    close.className = "glyph-card-close";
    close.textContent = "\u00d7";
    close.addEventListener("click", () => card.remove());
    card.appendChild(close);
    card.style.left = Math.min(x, window.innerWidth - 260) + "px";
    card.style.top = Math.min(y + 12, window.innerHeight - 80) + "px";
    document.body.appendChild(card);
  }

  function updateCard(text) {
    if (!card) return;
    card.childNodes[0].textContent = text;
  }
})();
