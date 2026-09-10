(async () => {
  const { theme } = await chrome.storage.local.get("theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
  }
})();
