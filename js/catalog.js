// NumPlay release catalog, downloads (with progress + checksum) and offline storage.

export const REPO = 'Mason363/NumPlay';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CATALOG_KEY = 'numflash.catalog.v1';
const NWA_CACHE = 'numflash-nwa-v1';

// Curated apps that are hosted outside the NumPlay release.
const EXTRA_ASSETS = [
  { id: 'nwagyu-peanutgb-1.2.2', name: 'PeanutGB 1.2.2.nwa', size: 148972, digest: 'sha256:1b63183b9a69c4de67301ab7041746f2821df1dbd2828e2160f0abec1ed47eb0', url: 'https://nwagyu.org/assets/apps/peanutgb-1.2.2.nwa', source: 'Nwagyu' },
  { id: 'nwagyu-peanutgbc-1.1.1', name: 'PeanutGBC 1.1.1.nwa', size: 142676, digest: 'sha256:25421c773d07a1e354b16c7966fe76f792e2851e8c07ca7fb0a866d18314926c', url: 'https://nwagyu.org/assets/apps/peanutgbc-1.1.1.nwa', source: 'Nwagyu' },
  { id: 'nwagyu-nofrendo-1.2.3', name: 'Nofrendo 1.2.3.nwa', size: 523540, digest: 'sha256:bd022570395af627006953ad6ee76633b85721878041b762466ba777ab172614', url: 'https://nwagyu.org/assets/apps/nofrendo-1.2.3.nwa', source: 'Nwagyu' },
];

export const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

/** Latest release, falling back to the last copy we stored. */
export async function loadCatalog() {
  try {
    let rel;
    try {
      const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('GitHub answered ' + res.status);
      rel = await res.json();
    } catch (direct) {
      // Same-origin fallback (Vercel edge function) for networks/browsers that block api.github.com
      const res = await fetch('/api/github?releases=1');
      if (!res.ok) throw direct;
      rel = await res.json();
    }
    const cat = {
      tag: rel.tag_name, name: rel.name || rel.tag_name, published: rel.published_at, page: rel.html_url,
      fetchedAt: Date.now(), offline: false,
      assets: (rel.assets || []).filter((a) => /\.nwa$/i.test(a.name)).map((a) => ({
        id: a.id, name: a.name, size: a.size, apiUrl: a.url, url: a.browser_download_url,
        digest: a.digest || null, updated: a.updated_at,
      })).concat(EXTRA_ASSETS),
    };
    try { localStorage.setItem(CATALOG_KEY, JSON.stringify(cat)); } catch { /* full */ }
    return cat;
  } catch (e) {
    const stored = localStorage.getItem(CATALOG_KEY);
    if (stored) return { ...JSON.parse(stored), offline: true, error: String(e.message || e) };
    throw e;
  }
}

const keyFor = (cat, asset) => `/__nwa/${cat.tag}/${asset.name}`;

export async function isStored(cat, asset) {
  try { return !!(await (await caches.open(NWA_CACHE)).match(keyFor(cat, asset))); } catch { return false; }
}
async function readStored(cat, asset) {
  const hit = await (await caches.open(NWA_CACHE)).match(keyFor(cat, asset));
  return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
}
export async function removeStored(cat, asset) {
  try { await (await caches.open(NWA_CACHE)).delete(keyFor(cat, asset)); } catch { /* ignore */ }
}
export async function clearStored() { try { await caches.delete(NWA_CACHE); } catch { /* ignore */ } }
/** Drop stored files that belong to older releases. */
export async function pruneStored(cat) {
  try {
    const c = await caches.open(NWA_CACHE);
    for (const req of await c.keys()) if (!new URL(req.url).pathname.startsWith(`/__nwa/${cat.tag}/`)) await c.delete(req);
  } catch { /* ignore */ }
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function streamDownload(url, headers, expected, onProgress) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = +res.headers.get('content-length') || expected || 0;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (onProgress && total) onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Bytes of a release asset: stored copy if there is one, otherwise download
 * (API URL first, since it is CORS-enabled; then the plain download URL).
 */
export async function getAssetBytes(cat, asset, { onProgress, keep = true } = {}) {
  const stored = await readStored(cat, asset).catch(() => null);
  if (stored) return stored;
  let bytes, lastErr;
  for (const [url, headers] of [[asset.apiUrl, { Accept: 'application/octet-stream' }], [asset.url, {}], ['/api/github?id=' + asset.id, {}]]) {
    if (!url) continue;
    try { bytes = await streamDownload(url, headers, asset.size, onProgress); break; } catch (e) { lastErr = e; }
  }
  if (!bytes) throw new Error('Download failed: ' + (lastErr && lastErr.message || 'unknown error'));
  if (bytes.length !== asset.size) throw new Error(`Downloaded ${bytes.length} bytes but expected ${asset.size}`);
  if (asset.digest && asset.digest.startsWith('sha256:')) {
    const h = await sha256Hex(bytes);
    if (h !== asset.digest.slice(7)) throw new Error('Checksum mismatch for ' + asset.name);
  }
  if (keep) {
    try { await (await caches.open(NWA_CACHE)).put(keyFor(cat, asset), new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* quota */ }
  }
  return bytes;
}
