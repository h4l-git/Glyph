# Glyph

Find any font, instantly. Glyph is a Chrome extension that lets you snip or highlight text on any webpage to identify its typeface, powered by Claude.

## Features

- **Snip tool** — draw a box around any text on the page and Glyph captures that region to identify the font.
- **Highlight tool** — hover and click any element on the page to read off its font family, weight, and size directly from the computed styles.
- **Toolbar badge** — the extension icon shows ✂ while Snip mode is active and 🖍 while Highlight mode is active, so you always know which tool is running.
- **Light/dark mode** — toggle the popup's theme from the button in the top-right corner; your choice is remembered across sessions.
- **Keyboard shortcut** — launch the Snip tool without opening the popup (default: `Alt+Shift+G`, configurable in Chrome's shortcut settings).

## Installation (unpacked / developer mode)

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select the `glyph-extension` folder.
4. Pin the Glyph icon to your toolbar for quick access.

## Usage

1. Click the Glyph icon in your toolbar.
2. Choose **Snip tool** to drag-select a region of the page, or **Highlight tool** to click directly on text.
3. Press `Esc` at any time to cancel the active tool.
4. Results appear in a small card on the page, with the identified font (Snip) or the live computed font details (Highlight).

> Note: Glyph can't run on Chrome's internal pages (`chrome://`, the New Tab page, the Web Store, etc.) — this is a browser-level restriction on all extensions, not something Glyph can override. Use it on any regular `http(s)://` page instead.

## Settings

Open **Settings** from the popup menu to:

- Add your API key for font identification (used by the Snip tool). It's stored locally on your device via `chrome.storage.local` and never leaves your machine except in requests to the identification API.
- View or change the Snip tool's keyboard shortcut.

## Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup UI, settings panel, theme toggle |
| `content.js` / `content.css` | Injected into the page to run the Snip and Highlight tools |
| `background.js` | Service worker — handles screenshot capture, keyboard shortcut, and the mode badge |
| `icons/` | Toolbar and store icons |

## Permissions

- `activeTab` — required to inject the Snip/Highlight tools into the page you're currently viewing.
- `scripting` — required to run `content.js` and `content.css` on demand.
- `storage` — required to save your API key, theme preference, and keyboard shortcut locally.

## Development

This is a plain HTML/CSS/JS extension with no build step. Edit the files directly, then reload the extension from `chrome://extensions` to see your changes.

## Landing page

The `docs/` folder holds the project's landing page, served via GitHub Pages.
