// Reads the real name and icon out of every .nwa in a folder, using the same objcopy.wasm the app uses,
// and writes them next to the app so icons show before anything is downloaded.
//
//   node scripts/build-icons.mjs <folder with .nwa files> <release tag>
// (Nwagyu apps: save them as "PeanutGB 1.2.2.nwa", "PeanutGBC 1.1.1.nwa", "Nofrendo 1.2.3.nwa" in a folder and run it on that folder.)
//
// Output: icons/apps/<file>.png (55x56, as stored in the .nwa) and data/apps.json
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setWasmBinaries, NwaApp } from '../js/nwa/linker.js';
import { nwiToRgba, ICON_WIDTH, ICON_HEIGHT } from '../js/nwa/lz4.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [dir, tag = ''] = process.argv.slice(2);
if (!dir) { console.error('usage: node scripts/build-icons.mjs <folder> <tag>'); process.exit(1); }
setWasmBinaries({ ld: readFileSync(join(root, 'vendor/ld.wasm')), objcopy: readFileSync(join(root, 'vendor/objcopy.wasm')) });

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(join(root, 'icons/apps'), { recursive: true });
mkdirSync(join(root, 'data'), { recursive: true });
// keep entries from earlier runs (other folders / other sources), only the files in this folder are replaced
const dataFile = join(root, 'data/apps.json');
const previous = existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, 'utf8')) : {};
const apps = { ...(previous.apps || {}) };
for (const f of readdirSync(dir).filter((x) => /\.nwa$/i.test(x)).sort()) {
  const bytes = new Uint8Array(readFileSync(join(dir, f)));
  const app = new NwaApp(bytes);
  const entry = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  try { entry.name = await app.loadName(); } catch (e) { entry.nameError = String(e.message || e); }
  try {
    const nwi = await app.section('.rodata.eadk_app_icon');
    const rgba = nwiToRgba(nwi);
    // blank (all-white / transparent) icons are legitimate (NumPlay-Invisible): keep them, flag them
    entry.blankIcon = rgba.every((v, i) => (i % 4 === 3) || v === 255);
    const file = 'icons/apps/' + f.replace(/\.nwa$/i, '').replace(/[^A-Za-z0-9._-]/g, '_') + '.png';
    writeFileSync(join(root, file), png(rgba, ICON_WIDTH, ICON_HEIGHT));
    entry.icon = file;
  } catch (e) { entry.iconError = String(e.message || e); }
  apps[f] = entry;
  console.log(f.padEnd(26), JSON.stringify(entry.name), entry.icon || 'NO ICON ' + entry.iconError, entry.blankIcon ? '(blank)' : '');
}
writeFileSync(dataFile, JSON.stringify({ tag: tag || previous.tag || '', generated: new Date().toISOString().slice(0, 10), apps }, null, 1));
