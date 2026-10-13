// Gets ld.wasm / objcopy.wasm from (in order): this device's cache, the app's own
// /vendor folder, NumWorks' CDN, or a file the user imports by hand.
import { setWasmBinaries, wasmReady } from './nwa/linker.js';

const CACHE = 'numflash-wasm-v1';
const SOURCES = {
  ld: { local: './vendor/ld.wasm', cdn: 'https://cdn.numworks.com/b9dadb68.wasm' },
  objcopy: { local: './vendor/objcopy.wasm', cdn: 'https://cdn.numworks.com/9a1d84f2.wasm' },
};

export const isWasm = (bytes) => bytes.length > 8 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;

async function cached(which) {
  try {
    const hit = await (await caches.open(CACHE)).match('/__wasm/' + which);
    if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); if (isWasm(b)) return b; }
  } catch { /* no Cache API */ }
  return null;
}
async function remember(which, bytes) {
  try { await (await caches.open(CACHE)).put('/__wasm/' + which, new Response(bytes, { headers: { 'content-type': 'application/wasm' } })); } catch { /* ignore */ }
}
async function tryFetch(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    const b = new Uint8Array(await res.arrayBuffer());
    return isWasm(b) ? b : null;        // a SPA fallback page is HTML, not wasm
  } catch { return null; }
}

/** Returns the list of tools that could not be found (empty when everything is loaded). */
export async function loadWasm() {
  const found = {};
  for (const which of Object.keys(SOURCES)) {
    let bytes = await cached(which);
    if (!bytes) {
      bytes = await tryFetch(SOURCES[which].local) || await tryFetch(SOURCES[which].cdn);
      if (bytes) await remember(which, bytes);
    }
    if (bytes) found[which] = bytes;
  }
  setWasmBinaries(found);
  return ['ld', 'objcopy'].filter((w) => !found[w]);
}

/** Manual import from a file picker. Accepts either tool; recognises it by file name. */
export async function importWasmFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isWasm(bytes)) throw new Error(file.name + ' is not a WebAssembly file');
  const n = file.name.toLowerCase();
  const which = n.includes('objcopy') ? 'objcopy' : n.includes('ld') ? 'ld' : null;
  if (!which) throw new Error('Name the file ld.wasm or objcopy.wasm so I know which one it is');
  await remember(which, bytes);
  setWasmBinaries({ [which]: bytes });
  return which;
}
export { wasmReady };
