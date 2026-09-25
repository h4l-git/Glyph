# Glyph

Find any font, instantly. Glyph is a Chrome extension that lets you snip or highlight text on any webpage to identify its typeface, powered by Claude.

## Features

- **Snip tool** (beta) — draw a box around any text on the page, including text in images, and Glyph sends that region to Claude to identify the font. Choose the model from the menu on the Snip row: Haiku 4.5 (fast), Sonnet 5 (balanced, the default), Opus 5.5, or Fable 5.1.
- **Highlight tool** — hover and click any element on the page to read off its font family, weight, and size directly from the computed styles.
- **Text selection** — turn on "Show card on text selection" in Settings to get the same result card when you highlight text with your cursor, without starting the Highlight tool.
- **History** — recent identifications, with copyable details, a preview, and a link back to the page. Save fonts you want to keep. New history can be turned off in Settings; fonts you have already saved stay either way.
- **Font source link** — when a result is shown, Glyph looks up an official specimen or download page (Google Fonts, Fontsource, Fontshare, Adobe Fonts, or Font Squirrel) and adds a link if it finds one.
- **Toolbar badge** — the extension icon shows ✂ while Snip mode is active and 🖍 while Highlight mode is active, so you always know which tool is running.
- **Light/dark mode** — toggle the window's theme from the button in the top-right corner; your choice is remembered across sessions.
- **Keyboard shortcuts** — launch a tool without opening the window. Snip defaults to `Alt+Shift+G` and Highlight to `Alt+Shift+H`, both configurable in Chrome's shortcut settings.
- **In-page window** — the menu opens as a transparent, rounded panel on the page. Drag the grip to resize it (double-click the grip to reset) and choose which corner it opens in.

## Installation (unpacked / developer mode)

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select the `glyph-extension` folder.
4. Pin the Glyph icon to your toolbar for quick access.

## Usage

1. Click the Glyph icon in your toolbar.
2. Choose **Snip tool** to drag-select a region of the page, or **Highlight tool** to click directly on text. For Snip, pick a Claude model from the badge on that row if you want something other than Sonnet 5.
3. The tool stays active after each result so you can check several fonts in a row. Right-click or press `Esc` to finish.
4. Results appear in a small card on the page, with the identified font (Snip) or the live computed font details (Highlight). Open **History** to review, preview, copy, or save them.

> Note: Glyph can't run on Chrome's internal pages (`chrome://`, the New Tab page, the Web Store, etc.) — this is a browser-level restriction on all extensions, not something Glyph can override. Use it on any regular `http(s)://` page instead. On those restricted pages, Glyph shows a short notice instead of the in-page window.

## Settings

Open **Settings** from the menu to:

- Add your API key for font identification (used by the Snip tool). It's stored locally on your device via `chrome.storage.local` and never leaves your machine except in requests to Anthropic. You can copy it from the field, or open Anthropic to create one.
- Show a result card when you highlight text with your cursor.
- Turn saving of new font history on or off.
- Choose which corner of the page the window opens in.
- View or change the Snip and Highlight tool keyboard shortcuts.

## Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3), version 0.1.4 |
| `popup.html` / `popup.css` / `popup.js` | Menu, settings, history, theme toggle, and model picker |
| `panel.js` | Injected on toolbar click; shows `popup.html` in a transparent, rounded in-page iframe with a drag-to-resize grip (double-click the grip to reset) |
| `unavailable.html` / `unavailable.css` / `unavailable.js` | Small native popup shown on pages Chrome won't let extensions run on (New Tab, `chrome://`, Web Store) |
| `content.js` / `content.css` | Injected into the page to run the Snip and Highlight tools and the optional selection card |
| `background.js` | Service worker — screenshot capture, Snip identification via Anthropic, keyboard shortcuts, and the mode badge |
| `fontSource.js` | Looks up an official specimen or download page for an identified family |
| `icons/` | Toolbar and store icons |
| `docs/` | Landing page and privacy policy, served via GitHub Pages |

## Permissions

- `activeTab` — required to inject the Snip/Highlight tools into the page you're currently viewing.
- `scripting` — required to run `panel.js`, `content.js`, and `content.css` on demand.
- `storage` — required to save your API key, theme, model choice, history, and other settings locally.
- Host access to `api.anthropic.com` — required so the Snip tool can send the cropped image and your API key to Claude.
- Host access to Google Fonts, Fontsource, Fontshare, Adobe Fonts, and Font Squirrel — required to resolve an official page for an identified family, and to load a live sample when you preview a Google Font in History.
- Optional access to websites — requested only if you enable "Show card on text selection", so Glyph can identify fonts when you highlight text.

## Development

This is a plain HTML/CSS/JS extension with no build step. Edit the files directly, then reload the extension from `chrome://extensions` to see your changes.

## Landing page

The `docs/` folder holds the project's landing page, served via GitHub Pages. The privacy policy is at [`docs/privacy/`](docs/privacy/).

## License

[MIT](LICENSE)
