// Boots the extracted Emscripten glue in a browser-like VM (no real wasm available
// here) to check our wiring: it must reach WebAssembly compilation and report
// failure through our promise, not crash earlier on a missing browser/Node API.
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';

for (const name of ['ld', 'objcopy']) {
  let src = fs.readFileSync(new URL(`../js/vendor/${name}-glue.js`, import.meta.url), 'utf8');
  src = src.replace('export default mod.exports;', 'globalThis.__factory = mod.exports;');
  const ctx = vm.createContext({
    window: {}, document: { currentScript: null }, WebAssembly, TextDecoder, TextEncoder, URL,
    console, setTimeout, clearTimeout, atob, btoa, Uint8Array, ArrayBuffer, DataView, Promise,
  });
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.runInContext(src, ctx);
  assert.equal(typeof ctx.__factory, 'function');
  const outcome = await new Promise((resolve) => {
    const mod = {
      wasmBinary: new Uint8Array([1, 2, 3, 4]),         // deliberately not a valid module
      locateFile: (f) => f, print() {}, printErr() {},
      preRun() {}, onAbort: (e) => resolve('abort: ' + String(e).slice(0, 80)),
      arguments: [], postRun() { resolve('postRun'); },
    };
    try { const p = ctx.__factory(mod); if (p && p.catch) p.catch((e) => resolve('rejected: ' + String(e).slice(0, 80))); }
    catch (e) { resolve('threw: ' + String(e).slice(0, 80)); }
    setTimeout(() => resolve('timeout'), 3000);
  });
  console.log(name, '->', outcome);
  assert.ok(/abort|rejected|threw/.test(outcome) && /wasm|WebAssembly|compile|magic|Aborted/i.test(outcome), name + ': unexpected: ' + outcome);
}
console.log('✓ both glue modules reach WebAssembly instantiation and fail cleanly on a bad binary');
