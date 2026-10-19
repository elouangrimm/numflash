// App-shell cache so NumFlash opens offline. Release files and the wasm tools are
// stored separately (Cache Storage keys used by the page itself).
const SHELL = 'numflash-shell-v3';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/catalog.js', 'js/wasm-loader.js', 'js/apps-meta.js', 'js/saves.js', 'data/apps.json',
  'js/usb/dfu.js', 'js/usb/calculator.js', 'js/usb/storage.js', 'js/usb/installed.js', 'js/info.js', 'js/saves-store.js',
  'data/apps.json', 'icons/apps/2048.png', 'icons/apps/Balatro.png', 'icons/apps/BlockBlast.png', 'icons/apps/BlockBreaker.png', 'icons/apps/BuckshotRoulette.png', 'icons/apps/Celeste.png', 'icons/apps/ChampionIsland.png', 'icons/apps/ConnectFour.png', 'icons/apps/CrossyRoad.png', 'icons/apps/FinalEarth2.png', 'icons/apps/FlappyBird.png', 'icons/apps/HollowKnight.png', 'icons/apps/Minesweeper.png', 'icons/apps/NumBlocks.png', 'icons/apps/NumChess.png', 'icons/apps/NumDash.png', 'icons/apps/NumDrive.png', 'icons/apps/NumPlay-Chinese.png', 'icons/apps/NumPlay-French.png', 'icons/apps/NumPlay-Invisible.png', 'icons/apps/NumPlay-Matrices.png', 'icons/apps/NumPlay-Upsilon.png', 'icons/apps/NumPlay.png', 'icons/apps/NumPowder.png', 'icons/apps/NumVisuals.png', 'icons/apps/PacMan.png', 'icons/apps/PortalReturns.png', 'icons/apps/Snake.png', 'icons/apps/Solitaire.png', 'icons/apps/Tetris.png', 'icons/apps/Undertale.png',
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
    // app icons (read from the .nwa files at build time) so they show offline too
    try {
      const apps = (await (await fetch('data/apps.json')).json()).apps || {};
      for (const a of Object.values(apps)) if (a.icon) { try { await cache.add(a.icon); } catch { /* ignore */ } }
    } catch { /* no icon list */ }
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
