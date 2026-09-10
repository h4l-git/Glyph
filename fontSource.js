/* Resolves an official specimen/download page for a font family.
   Runs in the background service worker so page CSP cannot block catalog fetches. */

const FONT_SOURCE_CACHE_KEY = "fontSourceResults";
const FONT_SOURCE_CATALOGS_KEY = "fontSourceCatalogs";
const RESULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_MS = 8000;
const CACHE_LIMIT = 250;

const GENERIC_FONT_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
  "emoji", "math", "fangsong", "inherit", "initial", "unset", "revert",
  "revert-layer", "caption", "icon", "menu", "message-box", "small-caption",
  "status-bar", "blinkmacsystemfont",
]);

const WEIGHT_SUFFIX = /\s+(?:thin|hairline|ultra\s*light|extra\s*light|light|regular|book|roman|normal|medium|semi(?:\s*|-)?bold|demi(?:\s*|-)?bold|bold|extra\s*bold|ultra\s*bold|black|heavy|italic|oblique)(?:\s+(?:italic|oblique))*$/i;

const MS = (slug) => ({
  url: "https://learn.microsoft.com/en-us/typography/font-list/" + slug,
  label: "Microsoft",
});
const APPLE = { url: "https://developer.apple.com/fonts/", label: "Apple" };

// Common system / foundry families that public webfont catalogs omit.
const KNOWN_SOURCES = {
  "arial": MS("arial"),
  "arial black": MS("arial-black"),
  "arial narrow": MS("arial-narrow"),
  "arial nova": MS("arial-nova"),
  "calibri": MS("calibri"),
  "cambria": MS("cambria"),
  "cambria math": MS("cambria-math"),
  "candara": MS("candara"),
  "comic sans ms": MS("comic-sans-ms"),
  "consolas": MS("consolas"),
  "constantia": MS("constantia"),
  "corbel": MS("corbel"),
  "courier new": MS("courier-new"),
  "franklin gothic medium": MS("franklin-gothic-medium"),
  "georgia": MS("georgia"),
  "impact": MS("impact"),
  "lucida console": MS("lucida-console"),
  "lucida sans unicode": MS("lucida-sans-unicode"),
  "microsoft sans serif": MS("microsoft-sans-serif"),
  "palatino linotype": MS("palatino-linotype"),
  "segoe ui": MS("segoe-ui"),
  "segoe ui emoji": MS("segoe-ui-emoji"),
  "segoe ui symbol": MS("segoe-ui-symbol"),
  "segoe ui variable": MS("segoe-ui-variable"),
  "tahoma": MS("tahoma"),
  "times new roman": MS("times-new-roman"),
  "trebuchet ms": MS("trebuchet-ms"),
  "verdana": MS("verdana"),
  "sitka": MS("sitka"),
  "sitka text": MS("sitka"),
  "bahnschrift": MS("bahnschrift"),
  "cascadia code": MS("cascadia-code"),
  "cascadia mono": MS("cascadia-mono"),
  "sf pro": APPLE,
  "sf pro text": APPLE,
  "sf pro display": APPLE,
  "sf pro rounded": APPLE,
  "sf compact": APPLE,
  "sf compact text": APPLE,
  "sf compact display": APPLE,
  "sf mono": APPLE,
  "sf arabic": APPLE,
  "san francisco": APPLE,
  "new york": APPLE,
  "helvetica neue": APPLE,
  "helvetica": { url: "https://fonts.adobe.com/fonts/helvetica", label: "Adobe Fonts" },
  "futura": { url: "https://fonts.adobe.com/fonts/futura-pt", label: "Adobe Fonts" },
  "lucida grande": APPLE,
  "menlo": APPLE,
  "monaco": APPLE,
  "geneva": APPLE,
  "hoefler text": APPLE,
  "marker felt": APPLE,
  "noteworthy": APPLE,
  "chalkboard se": APPLE,
  "apple color emoji": APPLE,
  "gotham": { url: "https://www.typography.com/fonts/gotham/overview", label: "Hoefler" },
  "gotham rounded": { url: "https://www.typography.com/fonts/gotham/overview", label: "Hoefler" },
  "graphik": { url: "https://commercialtype.com/catalog/graphik", label: "Commercial Type" },
  "circular": { url: "https://lineto.com/typefaces/circular", label: "Lineto" },
  "circular std": { url: "https://lineto.com/typefaces/circular", label: "Lineto" },
};

const FONTSHARE_FALLBACK = {
  "alpino": "alpino",
  "array": "array",
  "author": "author",
  "bespoke sans": "bespoke-sans",
  "bespoke serif": "bespoke-serif",
  "bespoke slab": "bespoke-slab",
  "boska": "boska",
  "cabinet grotesk": "cabinet-grotesk",
  "chillax": "chillax",
  "clash display": "clash-display",
  "clash grotesk": "clash-grotesk",
  "excon": "excon",
  "general sans": "general-sans",
  "kola": "kola",
  "melodrama": "melodrama",
  "panchang": "panchang",
  "ranade": "ranade",
  "satoshi": "satoshi",
  "stardom": "stardom",
  "supreme": "supreme",
  "switzer": "switzer",
  "synonym": "synonym",
  "tanker": "tanker",
  "zodiak": "zodiak",
};

const inflight = new Map();
let memoryResults = null;
let memoryCatalogs = null;

function abortAfter(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

async function fetchOnce(url, opts) {
  const wait = abortAfter(FETCH_MS);
  try {
    return await fetch(url, { ...opts, signal: wait.signal, redirect: "follow" });
  } finally {
    wait.done();
  }
}

async function dropBody(resp) {
  try {
    if (resp && resp.body && resp.body.cancel) await resp.body.cancel();
  } catch (err) {
    // Ignore; status is all we needed.
  }
}

async function statusOf(url, method) {
  try {
    const resp = await fetchOnce(url, { method: method || "GET" });
    const status = resp.status;
    await dropBody(resp);
    return status;
  } catch (err) {
    return 0;
  }
}

function cleanFamily(name) {
  return String(name || "").replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

function isResolvableFamily(name) {
  const family = cleanFamily(name);
  if (!family || family.toLowerCase() === "unknown") return false;
  if (GENERIC_FONT_FAMILIES.has(family.toLowerCase())) return false;
  if (family.startsWith(".") || family.startsWith("-")) return false;
  return true;
}

function kebabSlug(name) {
  return cleanFamily(name)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function googleSpecimenUrl(name) {
  const slug = cleanFamily(name).split(/[\s_]+/).filter(Boolean).map(encodeURIComponent).join("+");
  return slug ? "https://fonts.google.com/specimen/" + slug : null;
}

function lookupCandidates(name) {
  const family = cleanFamily(name);
  const out = [];
  const add = (value) => {
    const next = cleanFamily(value);
    if (next && !out.some((item) => item.toLowerCase() === next.toLowerCase())) out.push(next);
  };
  add(family);
  add(family.replace(WEIGHT_SUFFIX, ""));
  add(family.replace(/\s*(?:ms|mt|ps)$/i, ""));
  const stripped = family.replace(WEIGHT_SUFFIX, "").replace(/\s*(?:ms|mt|ps)$/i, "");
  add(stripped);
  if (!/\s/.test(family) && /[a-z][A-Z]/.test(family)) {
    add(family.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"));
  }
  return out;
}

async function loadResultsCache() {
  if (memoryResults) return memoryResults;
  try {
    const data = await chrome.storage.local.get(FONT_SOURCE_CACHE_KEY);
    memoryResults = data[FONT_SOURCE_CACHE_KEY] && typeof data[FONT_SOURCE_CACHE_KEY] === "object"
      ? data[FONT_SOURCE_CACHE_KEY]
      : {};
  } catch (err) {
    memoryResults = {};
  }
  return memoryResults;
}

async function saveResultsCache() {
  if (!memoryResults) return;
  const keys = Object.keys(memoryResults);
  if (keys.length > CACHE_LIMIT) {
    keys.sort((a, b) => (memoryResults[a].ts || 0) - (memoryResults[b].ts || 0));
    keys.slice(0, keys.length - CACHE_LIMIT).forEach((key) => delete memoryResults[key]);
  }
  try {
    await chrome.storage.local.set({ [FONT_SOURCE_CACHE_KEY]: memoryResults });
  } catch (err) {
    // Cache is best-effort.
  }
}

async function loadCatalogs() {
  if (memoryCatalogs) return memoryCatalogs;
  try {
    const data = await chrome.storage.local.get(FONT_SOURCE_CATALOGS_KEY);
    memoryCatalogs = data[FONT_SOURCE_CATALOGS_KEY] && typeof data[FONT_SOURCE_CATALOGS_KEY] === "object"
      ? data[FONT_SOURCE_CATALOGS_KEY]
      : {};
  } catch (err) {
    memoryCatalogs = {};
  }
  return memoryCatalogs;
}

async function saveCatalogs() {
  if (!memoryCatalogs) return;
  try {
    await chrome.storage.local.set({ [FONT_SOURCE_CATALOGS_KEY]: memoryCatalogs });
  } catch (err) {
    // Catalog cache is best-effort.
  }
}

function cachedResult(entry) {
  if (!entry || typeof entry !== "object") return null;
  const ttl = entry.url ? RESULT_TTL_MS : MISS_TTL_MS;
  if (Date.now() - (entry.ts || 0) > ttl) return null;
  return entry;
}

async function googleFontsSource(name) {
  const family = encodeURIComponent(cleanFamily(name)).replace(/%20/g, "+");
  if (!family) return null;
  try {
    const resp = await fetchOnce("https://fonts.googleapis.com/css2?family=" + family);
    if (!resp.ok) {
      await dropBody(resp);
      return null;
    }
    const text = await resp.text();
    // License-preview kits return CSS with /l/font? and are not Google Fonts listings.
    if (!text.includes("@font-face") || text.includes("/l/font?")) return null;
    if (!/fonts\.gstatic\.com\/s\//.test(text)) return null;
    const url = googleSpecimenUrl(name);
    return url ? { url, label: "Google Fonts" } : null;
  } catch (err) {
    return null;
  }
}

async function fontsourceSource(name) {
  const id = kebabSlug(name);
  if (!id) return null;
  const url = "https://api.fontsource.org/v1/fonts/" + encodeURIComponent(id);
  let status = await statusOf(url, "HEAD");
  if (status === 0 || status === 405 || status === 501) status = await statusOf(url, "GET");
  if (status !== 200) return null;
  return { url: "https://fontsource.org/fonts/" + encodeURIComponent(id), label: "Fontsource" };
}

async function fontshareIndex() {
  const catalogs = await loadCatalogs();
  const cached = catalogs.fontshare;
  if (cached && cached.byFamily && Date.now() - (cached.ts || 0) < CATALOG_TTL_MS) {
    return cached.byFamily;
  }
  const byFamily = {};
  try {
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const resp = await fetchOnce("https://api.fontshare.com/v2/fonts?offset=" + offset + "&limit=100");
      if (!resp.ok) break;
      const data = await resp.json();
      const fonts = Array.isArray(data.fonts) ? data.fonts : [];
      fonts.forEach((font) => {
        const family = cleanFamily(font && font.name).toLowerCase();
        const slug = String((font && font.slug) || "").trim();
        if (family && slug) byFamily[family] = slug;
      });
      if (!data.has_more || !fonts.length) break;
      offset += fonts.length;
    }
  } catch (err) {
    if (cached && cached.byFamily) return cached.byFamily;
    return null;
  }
  if (!Object.keys(byFamily).length) {
    if (cached && cached.byFamily) return cached.byFamily;
    return null;
  }
  catalogs.fontshare = { ts: Date.now(), byFamily };
  memoryCatalogs = catalogs;
  await saveCatalogs();
  return byFamily;
}

function fontshareFromMap(name, index) {
  if (!index) return null;
  const slug = index[cleanFamily(name).toLowerCase()];
  if (!slug) return null;
  return { url: "https://www.fontshare.com/fonts/" + encodeURIComponent(slug), label: "Fontshare" };
}

function knownSource(name) {
  return KNOWN_SOURCES[cleanFamily(name).toLowerCase()] || null;
}

async function adobeSource(name) {
  const slug = kebabSlug(name);
  if (!slug || slug.length < 3) return null;
  const status = await statusOf("https://fonts.adobe.com/fonts/" + encodeURIComponent(slug), "GET");
  if (status !== 200) return null;
  return { url: "https://fonts.adobe.com/fonts/" + encodeURIComponent(slug), label: "Adobe Fonts" };
}

async function fontSquirrelSource(name) {
  const slug = kebabSlug(name);
  if (!slug || slug.length < 3) return null;
  const status = await statusOf("https://www.fontsquirrel.com/fonts/" + encodeURIComponent(slug), "GET");
  if (status !== 200) return null;
  return { url: "https://www.fontsquirrel.com/fonts/" + encodeURIComponent(slug), label: "Font Squirrel" };
}

async function lookupFamily(name) {
  return await googleFontsSource(name)
    || await fontsourceSource(name)
    || knownSource(name)
    || fontshareFromMap(name, FONTSHARE_FALLBACK)
    || await adobeSource(name)
    || fontshareFromMap(name, await fontshareIndex())
    || await fontSquirrelSource(name)
    || null;
}

async function resolveFontSource(name) {
  if (!isResolvableFamily(name)) return null;
  const cacheKey = cleanFamily(name).toLowerCase();
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const job = (async () => {
    const cache = await loadResultsCache();
    const hit = cachedResult(cache[cacheKey]);
    if (hit) return hit.url ? { url: hit.url, label: hit.label } : null;

    let found = null;
    for (const candidate of lookupCandidates(name)) {
      found = await lookupFamily(candidate);
      if (found) break;
    }
    cache[cacheKey] = found
      ? { url: found.url, label: found.label, ts: Date.now() }
      : { url: null, label: null, ts: Date.now() };
    memoryResults = cache;
    await saveResultsCache();
    return found;
  })();

  inflight.set(cacheKey, job);
  try {
    return await job;
  } finally {
    inflight.delete(cacheKey);
  }
}
