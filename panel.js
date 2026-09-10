/*
 * In-page floating panel.
 *
 * Chrome paints its native action popup onto an opaque surface, so the popup
 * can never have a transparent backdrop. To get a floating rounded card, the
 * toolbar button instead injects this script, which embeds popup.html inside a
 * transparent iframe pinned to the top-right of the page. The iframe is an
 * extension-origin document, so the page cannot read anything inside it.
 *
 * A grip in the bottom-left corner lets the panel be resized by dragging; the
 * chosen size is stored and reused. Double-clicking the grip restores the
 * automatic size, where the panel follows the height of its content.
 *
 * The script is idempotent: every execution toggles the panel.
 */
(() => {
  const DEFAULT_WIDTH = 260;
  const MIN_WIDTH = 220;
  const MIN_HEIGHT = 120;
  const RADIUS = 12;
  const MARGIN = 8;
  const STORAGE_KEY = "panelSize";
  const EXT_ORIGIN = chrome.runtime.getURL("").replace(/\/$/, "");

  if (!window.__glyphPanel) {
    let host = null;
    let wrap = null;
    let iframe = null;
    let manualSize = null; // { w, h } once the user has resized, else null

    const clampSize = (w, h) => ({
      w: Math.round(Math.min(Math.max(w, MIN_WIDTH), window.innerWidth - MARGIN * 2)),
      h: Math.round(Math.min(Math.max(h, MIN_HEIGHT), window.innerHeight - MARGIN * 2)),
    });

    const postToFrame = (msg) => {
      if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage(msg, EXT_ORIGIN);
    };

    const applySize = () => {
      if (!wrap || !iframe) return;
      const w = manualSize ? manualSize.w : DEFAULT_WIDTH;
      wrap.style.width = `${w}px`;
      iframe.style.width = `${w}px`;
      if (manualSize) iframe.style.height = `${manualSize.h}px`;
      postToFrame({ type: "GLYPH_PANEL_MODE", fill: !!manualSize });
    };

    const onMessage = (event) => {
      if (!iframe || event.source !== iframe.contentWindow || event.origin !== EXT_ORIGIN) return;
      const data = event.data || {};
      if (data.type === "GLYPH_PANEL_SIZE" && typeof data.height === "number") {
        // Content-driven height only while the user hasn't chosen a size.
        if (!manualSize) iframe.style.height = `${Math.max(0, Math.ceil(data.height))}px`;
      } else if (data.type === "GLYPH_PANEL_READY") {
        applySize();
      } else if (data.type === "GLYPH_PANEL_CLOSE") {
        close();
      }
    };

    const onPointerDown = (event) => {
      // Clicks inside the iframe never reach this document, so anything that
      // does arrive is outside the panel (the grip is inside the host).
      if (host && !event.composedPath().includes(host)) close();
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") close();
    };

    function buildGrip() {
      const grip = document.createElement("button");
      grip.type = "button";
      grip.className = "grip";
      grip.title = "Drag to resize. Double-click to reset.";
      grip.setAttribute("aria-label", "Resize panel");
      grip.innerHTML =
        '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
        '<path d="M1 11 L11 1 M1 7 L7 1 M1 3 L3 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>' +
        "</svg>";

      let drag = null;

      grip.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const rect = wrap.getBoundingClientRect();
        drag = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          w: rect.width,
          h: iframe.getBoundingClientRect().height,
        };
        try {
          grip.setPointerCapture(event.pointerId);
        } catch (err) {
          // Synthetic events have no active pointer; the drag still works.
        }
        iframe.style.pointerEvents = "none"; // keep pointer events flowing while over the frame
        wrap.classList.add("resizing");
      });

      grip.addEventListener("pointermove", (event) => {
        if (!drag || event.pointerId !== drag.pointerId || event.buttons === 0) return;
        // Anchored top-right: dragging left widens, dragging down lengthens.
        manualSize = clampSize(drag.w + (drag.x - event.clientX), drag.h + (event.clientY - drag.y));
        applySize();
      });

      const endDrag = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag = null;
        if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
        iframe.style.pointerEvents = "";
        wrap.classList.remove("resizing");
        if (manualSize) chrome.storage.local.set({ [STORAGE_KEY]: manualSize });
      };
      grip.addEventListener("pointerup", endDrag);
      grip.addEventListener("pointercancel", endDrag);

      grip.addEventListener("dblclick", (event) => {
        event.preventDefault();
        manualSize = null;
        chrome.storage.local.remove(STORAGE_KEY);
        iframe.style.height = "0px";
        applySize(); // the frame replies with its content height
      });

      return grip;
    }

    async function open() {
      if (host) return;
      host = document.createElement("div");
      host.setAttribute("data-glyph-panel", "");
      host.style.cssText = `all: initial; position: fixed; top: ${MARGIN}px; right: ${MARGIN}px; z-index: 2147483647;`;
      const shadow = host.attachShadow({ mode: "closed" });

      const style = document.createElement("style");
      style.textContent = `
        .wrap {
          position: relative;
          width: ${DEFAULT_WIDTH}px;
          border-radius: ${RADIUS}px;
          overflow: hidden;
          background: transparent;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.12);
        }
        iframe {
          display: block;
          width: ${DEFAULT_WIDTH}px;
          height: 0;
          border: 0;
          margin: 0;
          padding: 0;
          background: transparent;
          /* Must match the popup document's color-scheme, otherwise Chrome
             paints an opaque backdrop behind cross-origin frames. */
          color-scheme: normal;
        }
        .grip {
          position: absolute;
          left: 0;
          bottom: 0;
          width: 22px;
          height: 22px;
          margin: 0;
          padding: 0 0 4px 4px;
          border: 0;
          background: transparent;
          color: rgba(128, 128, 128, 0.55);
          cursor: nesw-resize;
          display: flex;
          align-items: flex-end;
          justify-content: flex-start;
          touch-action: none;
          -webkit-user-select: none;
          user-select: none;
        }
        .grip:hover, .resizing .grip { color: rgba(128, 128, 128, 0.95); }
        .grip:focus-visible { outline: 2px solid #7FC4BB; outline-offset: -2px; border-radius: 4px; }
        .grip svg { transform: scaleX(-1); }
      `;

      wrap = document.createElement("div");
      wrap.className = "wrap";

      iframe = document.createElement("iframe");
      iframe.src = chrome.runtime.getURL("popup.html");
      iframe.setAttribute("allowtransparency", "true");
      iframe.title = "Glyph";

      wrap.appendChild(iframe);
      wrap.appendChild(buildGrip());
      shadow.appendChild(style);
      shadow.appendChild(wrap);
      (document.body || document.documentElement).appendChild(host);

      window.addEventListener("message", onMessage);
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);

      try {
        const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
        if (stored && typeof stored.w === "number" && typeof stored.h === "number") {
          manualSize = clampSize(stored.w, stored.h);
        }
      } catch (err) {
        manualSize = null;
      }
      if (host) applySize();
    }

    function close() {
      if (!host) return;
      window.removeEventListener("message", onMessage);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      host.remove();
      host = null;
      wrap = null;
      iframe = null;
    }

    window.__glyphPanel = {
      toggle() {
        if (host) close();
        else open();
      },
    };
  }

  window.__glyphPanel.toggle();
})();
