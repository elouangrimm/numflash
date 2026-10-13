import assert from 'node:assert/strict';
import { loadOfficial } from './official.mjs';
import { makeMock, EXT_APPS_START, EXT_APPS_END } from './mock-device.mjs';
import { Calculator } from '../js/usb/calculator.js';
import { regionFromInfos } from '../js/nwa/linker.js';

const official = loadOfficial();

// A fake "linked image": 3 sectors of recognisable data + final blank sector (like AppGroup.flatBin).
const SECTOR = 65536;
const image = new Uint8Array(SECTOR * 3 + SECTOR).fill(0xFF);
for (let i = 0; i < SECTOR * 3; i++) image[i] = (i * 7 + 13) & 0xFE;     // never 0xFF

async function runOfficial() {
  const m = makeMock();
  const calc = new official.aU(m.device);
  await calc.process((c) => c.extractInfos());
  const fw = calc.infos.firmware;
  const start = fw.externalAppsFlashStart;
  await calc.process(async (c) => {
    await c.downloadFlash(start, image, () => {}, () => {});
    await c.dfu.leave(start);
  });
  return { m, infos: calc.infos };
}
async function runMine() {
  const m = makeMock();
  const calc = new Calculator(m.device);
  await calc.process((c) => c.extractInfos());
  const region = regionFromInfos(calc.infos);
  await calc.process(async (c) => {
    await c.downloadFlash(region.flashStart, image, () => {}, () => {});
    await c.dfu.leave(region.flashStart);
  });
  return { m, infos: calc.infos, region };
}

const o = await runOfficial();
const p = await runMine();

// 1. same identification
assert.equal(p.infos.model.name, o.infos.model.name);
assert.deepEqual(p.infos.memoryLayout, o.infos.memoryLayout);
for (const k of Object.keys(o.infos.firmware)) assert.equal(p.infos.firmware[k], o.infos.firmware[k], 'firmware.' + k);
assert.equal(p.infos.displayedSerialNumber, o.infos.displayedSerialNumber);
console.log('✓ identification matches official:', p.infos.model.name, 'fw', p.infos.firmware.version,
  'ext apps', '0x' + p.infos.firmware.externalAppsFlashStart.toString(16), '-', '0x' + p.infos.firmware.externalAppsFlashEnd.toString(16),
  'trampoline 0x' + p.infos.firmware.trampolineAddress.toString(16));

// 2. byte-identical USB conversation (open … close)
const norm = (l) => l.filter((x) => !x.startsWith('open') && !x.startsWith('close') && !x.startsWith('selectConfiguration') && !x.startsWith('claim'));
assert.equal(norm(p.m.log).length, norm(o.m.log).length, 'number of USB operations');
for (let i = 0; i < norm(o.m.log).length; i++) assert.equal(norm(p.m.log)[i], norm(o.m.log)[i], 'USB op #' + i);
console.log('✓ identical USB transfer sequence (' + norm(o.m.log).length + ' operations)');

// 3. same flash result, same erase list, same restart address
assert.deepEqual(p.m.st.erases, o.m.st.erases);
assert.equal(p.m.st.leftAt, o.m.st.leftAt);
assert.ok(Buffer.from(p.m.mem.external.data).equals(Buffer.from(o.m.mem.external.data)), 'external flash identical');
const off = EXT_APPS_START - 0x90000000;
assert.ok(Buffer.from(p.m.mem.external.data.subarray(off, off + image.length)).equals(Buffer.from(image)), 'image landed at the right place');
assert.equal(p.m.st.leftAt, EXT_APPS_START);
console.log('✓ erased', p.m.st.erases.length, 'pages, wrote', image.length, 'bytes, restarted at 0x' + p.m.st.leftAt.toString(16));
// Untouched flash must remain untouched (garbage 0xAA before the app region and after the image)
assert.equal(p.m.mem.external.data[off - 1], 0xAA);
assert.equal(p.m.mem.external.data[off + image.length], 0xAA);
console.log('✓ neighbouring flash untouched');
