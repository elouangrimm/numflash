// App-shell cache so NumFlash opens offline. Release files and the wasm tools are
// stored separately (Cache Storage keys used by the page itself).
const SHELL = 'numflash-shell-v2';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/catalog.js', 'js/wasm-loader.js',
  'js/usb/dfu.js', 'js/usb/calculator.js', 'js/usb/storage.js',
  'js/nwa/linker.js', 'js/nwa/installer.js', 'js/nwa/lz4.js',
  'js/vendor/ld-glue.js', 'js/vendor/objcopy-glue.js', 'js/vendor/eadk-o.js', 'js/vendor/linker-script.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const OPTIONAL = ['vendor/ld.wasm', 'vendor/objcopy.wasm'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(FILES);
    for (const f of OPTIONAL) { try { await cache.add(f); } catch { /* not deployed */ } }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('numflash-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Same-origin GETs: cache first, refresh in the background (stale-while-revalidate).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/__') || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503 });
  })());
});
