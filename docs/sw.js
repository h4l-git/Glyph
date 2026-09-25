var CACHE = "glyph-home-v3";

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return cache.add("index.html");
  }));
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) {
      return key !== CACHE;
    }).map(function (key) {
      return caches.delete(key);
    }));
  }).then(function () {
    return self.clients.claim();
  }));
});

function isHome(url) {
  var path = url.pathname.replace(/\/+$/, "");
  var scopePath = new URL(self.registration.scope).pathname.replace(/\/+$/, "");
  return path === scopePath || path === scopePath + "/index.html";
}

self.addEventListener("fetch", function (event) {
  if (event.request.mode !== "navigate") return;
  if (!isHome(new URL(event.request.url))) return;

  event.respondWith((async function () {
    var cache = await caches.open(CACHE);
    var cached = await cache.match("index.html");
    var network = fetch(event.request).then(function (response) {
      if (response && response.ok) cache.put("index.html", response.clone());
      return response;
    }).catch(function () {
      return cached;
    });
    if (!cached) return network;
    return Promise.race([
      network,
      new Promise(function (resolve) {
        setTimeout(function () { resolve(cached); }, 250);
      })
    ]);
  })());
});
