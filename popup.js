const menu = document.getElementById("menu-main");
const settings = document.getElementById("panel-settings");
const apiKeyInput = document.getElementById("api-key");
const saveNote = document.getElementById("save-note");
const btnTheme = document.getElementById("btn-theme");

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
    alert("Glyph can't run on this page. Try it on a regular website.");
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
    window.close();
  } catch (err) {
    alert("Glyph can't run on this page. Try it on a regular website.");
  }
}

document.getElementById("btn-snip").addEventListener("click", () => injectAndStart("snip"));
document.getElementById("btn-highlight").addEventListener("click", () => injectAndStart("highlight"));

document.getElementById("btn-website").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://h4l-git.github.io/Glyph/" });
});

document.getElementById("btn-settings").addEventListener("click", async () => {
  menu.classList.add("hidden");
  settings.classList.remove("hidden");
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (apiKey) apiKeyInput.value = apiKey;
  const commands = await chrome.commands.getAll();
  const snip = commands.find((c) => c.name === "start-snip");
  document.getElementById("shortcut-display").textContent =
    snip?.shortcut || "Not set";
});

document.getElementById("btn-shortcut").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

document.getElementById("btn-back").addEventListener("click", () => {
  settings.classList.add("hidden");
  menu.classList.remove("hidden");
  saveNote.classList.add("hidden");
});

document.getElementById("btn-save").addEventListener("click", async () => {
  await chrome.storage.local.set({ apiKey: apiKeyInput.value.trim() });
  saveNote.classList.remove("hidden");
  setTimeout(() => saveNote.classList.add("hidden"), 1500);
});
