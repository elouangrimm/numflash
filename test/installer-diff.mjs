// AppGroup.flatBin (padding, end-of-list sector, overflow check) vs NumWorks' original,
// then a full install through installApps() on the mock device.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMock, EXT_APPS_START } from './mock-device.mjs';
import { Calculator } from '../js/usb/calculator.js';
import { AppGroup, APP_SECTOR_SIZE } from '../js/nwa/linker.js';
import { installApps } from '../js/nwa/installer.js';

// A fake app whose "link output" length depends on where it's placed, like the real thing.
function fakeApp(bytes, tag) {
  return { name: tag, size: Math.ceil(bytes / APP_SECTOR_SIZE) * APP_SECTOR_SIZE, needsExternalData: false,
    async flatBin(region) { const out = new Uint8Array(bytes); for (let i = 0; i < bytes; i++) out[i] = (region.flashStart >> 16) ^ (i & 0x7e) ^ tag.charCodeAt(0); return out; } };
}
const sizes = [100000, 65536, 262144 + 5, 1];     // unaligned, exactly one sector, >4 sectors, tiny
const region = { flashStart: EXT_APPS_START, flashLength: 0x90800000 - EXT_APPS_START, ramStart: 0x24010000, ramLength: 0x30000, trampolineStart: 0x8020030 };

const src = process.env.APP_LOADER || '/mnt/user-data/uploads/app-loader.js';
if (fs.existsSync(src)) {
  const lines = fs.readFileSync(src, 'utf8').split('\n');
  const a = lines.findIndex((l) => l.startsWith('        var a5 = class e {'));
  const b = lines.findIndex((l) => l.startsWith('        function a3(e, t, r, n, o, i, a, s)'));
  const origCode = lines.slice(a, b).join('\n')
    .replace(/\|\| =/g, '||=').replace(/async# e\(/g, 'async #e(').replace(/\}#\s*t\(\)/g, '}\n #t()').replace(/\? \./g, '?.')
    + '\nreturn { a5, a6, a4 };';
  class iZ extends Error { constructor(n, ...t) { super(...t); this.name = n; } }
  const stubs = { aJ: {}, aZ: () => {}, a1: () => '', a2: { data: [] }, a0: () => () => {}, r: () => ({}), iZ };
  const official = new Function(...Object.keys(stubs), origCode)(...Object.values(stubs));

  const mine = new AppGroup(); const theirs = new official.a6();
  sizes.forEach((s, i) => { mine.push(fakeApp(s, 'abcd'[i])); theirs.push(fakeApp(s, 'abcd'[i])); });
  const imgMine = await mine.flatBin(region);
  const imgTheirs = await theirs.flatBin(region);
  assert.equal(imgMine.length, imgTheirs.length);
  assert.ok(Buffer.from(imgMine).equals(Buffer.from(imgTheirs)));
  console.log('✓ AppGroup.flatBin identical to NumWorks\' (' + imgMine.length + ' bytes for', sizes.length, 'apps)');

  const tiny = { ...region, flashLength: APP_SECTOR_SIZE * 2 };
  await assert.rejects(() => mine.flatBin(tiny), /overflown/);
  await assert.rejects(() => theirs.flatBin(tiny), /overflown/);
  console.log('✓ overflow rejected like the original');
} else {
  console.log('✓ skipped official comparison (APP_LOADER file not found)');
}

const mine = new AppGroup();
sizes.forEach((s, i) => mine.push(fakeApp(s, 'abcd'[i])));
const imgMine = await mine.flatBin(region);

// --- full install via installApps on the mock device
const m = makeMock();
const calc = new Calculator(m.device);
const stages = []; let last = 0;
const res = await installApps(calc, mine.apps, { onStage: (s) => stages.push(s), onProgress: (p) => { assert.ok(p >= last - 1e-9); last = p; } });
const off = EXT_APPS_START - 0x90000000;
assert.ok(Buffer.from(m.mem.external.data.subarray(off, off + imgMine.length)).equals(Buffer.from(imgMine)));
assert.equal(m.st.leftAt, EXT_APPS_START);
assert.equal(m.mem.external.data[off - 1], 0xAA); assert.equal(m.mem.external.data[off + imgMine.length], 0xAA);
assert.ok(res.written && last > 0.99);
console.log('✓ installApps wrote + restarted; stages:', stages.join(' > '));

// dry run writes nothing
const m2 = makeMock(); const c2 = new Calculator(m2.device);
const dry = await installApps(c2, mine.apps, { dryRun: true });
assert.equal(m2.st.writes, 0); assert.equal(m2.st.erases.length, 0); assert.equal(dry.written, false);
console.log('✓ dry run touched nothing');

// too many apps -> refused before any erase
const big = new AppGroup(); for (let i = 0; i < 100; i++) big.push(fakeApp(MB(), 'z'));
function MB() { return 1 << 20; }
const m3 = makeMock(); const c3 = new Calculator(m3.device);
await assert.rejects(() => installApps(c3, big.apps), /Not enough room/);
assert.equal(m3.st.erases.length, 0);
console.log('✓ oversize install refused before erasing');
