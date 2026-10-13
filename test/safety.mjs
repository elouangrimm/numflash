// Negative tests for the safety nets we added around NumWorks' logic.
import assert from 'node:assert/strict';
import { makeMock } from './mock-device.mjs';
import { Calculator } from '../js/usb/calculator.js';
import { regionFromInfos } from '../js/nwa/linker.js';

// 1. misaligned start address -> no erase, no write
{
  const m = makeMock(); const c = new Calculator(m.device);
  await assert.rejects(() => c.process(async (x) => { await x.extractInfos(); await x.downloadFlash(0x90200010, new Uint8Array(100), () => {}, () => {}); }), /page-aligned|not page/);
  assert.equal(m.st.erases.length, 0); assert.equal(m.st.writes, 0);
  console.log('✓ misaligned address refused');
}
// 2. address outside flash -> refused
{
  const m = makeMock(); const c = new Calculator(m.device);
  await assert.rejects(() => c.process(async (x) => { await x.extractInfos(); await x.downloadFlash(0x24000000, new Uint8Array(100)); }), /out of flash range/);
  assert.equal(m.st.writes, 0);
  console.log('✓ RAM / non-flash address refused');
}
// 3. data larger than flash -> refused
{
  const m = makeMock(); const c = new Calculator(m.device);
  await assert.rejects(() => c.process(async (x) => { await x.extractInfos(); await x.downloadFlash(0x90700000, new Uint8Array(0x200000)); }), /out of flash range|plan the flash erase/);
  assert.equal(m.st.writes, 0);
  console.log('✓ oversize write refused');
}
// 4. unreadable header -> regionFromInfos refuses (so we never compute addresses from "unknown")
{
  const m = makeMock();
  m.mem.ram.data.fill(0);                                  // destroy slot info
  const c = new Calculator(m.device);
  await c.process((x) => x.extractInfos());
  assert.throws(() => regionFromInfos(c.infos), /Could not read/);
  console.log('✓ unreadable firmware header -> refuses to build a flash region');
}
