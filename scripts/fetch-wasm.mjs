// Downloads the two WebAssembly tools (GNU ld + objcopy) that NumWorks' own uploader uses.
// Run once on your PC:  node scripts/fetch-wasm.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor');
const files = {
  'ld.wasm': 'https://cdn.numworks.com/b9dadb68.wasm',
  'objcopy.wasm': 'https://cdn.numworks.com/9a1d84f2.wasm',
};
fs.mkdirSync(dir, { recursive: true });
for (const [name, url] of Object.entries(files)) {
  const res = await fetch(url);
  if (!res.ok) { console.error(name, 'HTTP', res.status, url); process.exitCode = 1; continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.readUInt32BE(0) !== 0x0061736d) { console.error(name, 'is not a WebAssembly file'); process.exitCode = 1; continue; }
  fs.writeFileSync(path.join(dir, name), buf);
  console.log('saved', name, buf.length, 'bytes');
}
