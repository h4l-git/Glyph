# Glyph

Find any font, instantly. Glyph is a Chrome extension that lets you snip text, pick a picture, or highlight live text on any webpage to identify its typeface. Identification uses WhatFontIs, with Claude as an optional fallback.

## Features

- **Snip tool** — draw a box around any text on the page, including text in images. Glyph sends that region to WhatFontIs and shows the closest catalog match, plus a few similar faces. The menu on the Snip row chooses the identifier. WhatFontIs is the default. Haiku 4.5, Sonnet 5, Opus 5.5, and Fable 5.1 are used only when WhatFontIs can't separate the letters and an Anthropic key is saved.
- **Image Selector** — click a picture on the page, including a background image or a canvas. Glyph reads the picture file, preferring a larger version than the one drawn on the page, and sends that file to WhatFontIs. If the file can't be read, it sends the picture's web address so WhatFontIs can fetch it. The same Claude fallback applies when a Claude model is selected.
- **Daily limit** — Snip and Image Selector share 20 identifications a day. The count resets at midnight UTC. At the limit, the menu disables both rows and shows when it resets.
- **Sharper snip** — turn this on in Settings to briefly zoom the tab around the region you box, capture a clearer picture of the letters, then restore the previous zoom.
- **Highlight text** — hover and click any element on the page to read off its font family, weight, and size directly from the computed styles.
- **Text selection** — turn on "Show card on text selection" in Settings to get the same result card when you highlight text with your cursor, without starting Highlight text.
- **History** — the 20 most recent identifications, with copyable details, a preview, and a link back to the page. Search saved and recent fonts, and collapse either list. Save up to 50 fonts you want to keep. New history can be turned off in Settings; fonts you have already saved stay either way.
- **Font source link** — when a result is shown, Glyph looks up an official specimen or download page (Google Fonts, Fontsource, Fontshare, Adobe Fonts, or Font Squirrel) and adds a link if it finds one. A WhatFontIs match can link to that catalog page directly.
- **Toolbar badge** — the extension icon shows ✂ while Snip is active, ▣ while Image Selector is active, and 🖍 while Highlight text is active.
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
2. Choose **Snip tool** to drag-select a region, **Image Selector** to click a picture, or **Highlight text** to click live text. Snip and Image Selector use the WhatFontIs key in `wfiKey.js`, and share 20 identifications a day. The badge on the Snip row defaults to WhatFontIs. Pick a Claude model there to use it only when WhatFontIs can't separate the letters, and only if an Anthropic key is saved.
3. The tool stays active after each result so you can check several fonts in a row. Right-click or press `Esc` to finish.
4. Results appear in a small card on the page, with the identified font (Snip and Image Selector) or the live computed font details (Highlight text). Open **History** to search, review, preview, copy, or save them.

> Note: Glyph can't run on Chrome's internal pages (`chrome://`, the New Tab page, the Web Store, etc.) — this is a browser-level restriction on all extensions, not something Glyph can override. Use it on any regular `http(s)://` page instead. On those restricted pages, Glyph shows a short notice instead of the in-page window.

## Settings

Open **Settings** from the menu to:

- Put your WhatFontIs API key in `wfiKey.js` (copy `wfiKey.example.js` if that file is missing). Snip and Image Selector use it for every user. Get one from [WhatFontIs credits](https://www.whatfontis.com/credits.html). `wfiKey.js` is gitignored.
- Optionally add an Anthropic API key in Settings. Glyph uses it when a Claude model is selected and WhatFontIs can't separate the letters, and sends that image and key to Anthropic. Users do not need this for a normal snip or picture.
- Show a result card when you highlight text with your cursor.
- Turn saving of new font history on or off.
- Turn **Sharper snip** on or off.
- Choose which corner of the page the window opens in.
- View or change the Snip and Highlight text keyboard shortcuts. Image Selector has no shortcut.

## Project structure

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3), version 1.0.0 |
| `popup.html` / `popup.css` / `popup.js` | Menu, settings, history, theme toggle, and model picker |
| `panel.js` | Injected on toolbar click; shows `popup.html` in a transparent, rounded in-page iframe with a drag-to-resize grip (double-click the grip to reset) |
| `unavailable.html` / `unavailable.css` / `unavailable.js` | Small native popup shown on pages Chrome won't let extensions run on (New Tab, `chrome://`, Web Store) |
| `content.js` / `content.css` | Injected into the page to run Snip, Image Selector, Highlight text, and the optional selection card |
| `background.js` | Service worker — screenshot capture, sharper-snip zoom, picture fetching, identification via WhatFontIs (Claude as fallback), the daily limit, keyboard shortcuts, and the mode badge |
| `wfiKey.js` | Your WhatFontIs API key, gitignored. Copy from `wfiKey.example.js` |
| `fontSource.js` | Looks up an official specimen or download page for an identified family |
| `icons/` | Toolbar and store icons |
| `docs/` | Landing page and privacy policy, served via GitHub Pages |

## Permissions

- `activeTab` — required to inject Snip, Image Selector, and Highlight text into the page you're currently viewing.
- `scripting` — required to run `panel.js`, `content.js`, and `content.css` on demand.
- `storage` — required to save your API keys, theme, model choice, history, daily identification count, and other settings locally.
- Host access to `www.whatfontis.com` — required so Snip and Image Selector can send the image with the WhatFontIs key in `wfiKey.js`.
- Host access to `api.anthropic.com` — required so Snip and Image Selector can fall back to Claude when a Claude model is selected and WhatFontIs can't separate the letters.
- Host access to Google Fonts, Fontsource, Fontshare, Adobe Fonts, and Font Squirrel — required to resolve an official page for an identified family, and to load a live sample when you preview a Google Font in History.
- Optional access to websites — requested if you enable "Show card on text selection", and when you use Image Selector, so Glyph can read picture files the page does not expose directly. If you decline, Image Selector still sends pictures it can read, and public picture addresses.

## Development

This is a plain HTML/CSS/JS extension with no build step. Edit the files directly, then reload the extension from `chrome://extensions` to see your changes.

## Landing page

The `docs/` folder holds the project's landing page, served via GitHub Pages. The privacy policy is at [`docs/privacy/`](docs/privacy/).

## License

[MIT](LICENSE)
