// A fake WebUSB DfuSe device that behaves like a NumWorks N0120 in enough detail
// to exercise the whole flashing path. NOR-flash semantics: writing to a byte
// that is not 0xFF (i.e. not erased) is an error, so a missing erase is caught.

const MAGIC_FW = [0xF0, 0x0D, 0xC0, 0xDE];
const MAGIC_UL = [0xFE, 0xED, 0xC0, 0xDE];
const MAGIC_SLOT = [0xBA, 0xDB, 0xEE, 0xEF];

export const LAYOUT_STRING = '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,03*128Kg/0x90000000/128*064Kg';
export const EXT_APPS_START = 0x90200000;
export const EXT_APPS_END = 0x90800000;
export const RAM_START = 0x24000000;

function utf16le(s) { const u = new Uint8Array(2 + s.length * 2); u[0] = u.length; u[1] = 3; for (let i = 0; i < s.length; i++) { u[2 + 2 * i] = s.charCodeAt(i) & 255; u[3 + 2 * i] = s.charCodeAt(i) >> 8; } return u; }
const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const str8 = (s, n) => { const a = new Array(n).fill(0); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };

export function makeMock({ log = [] } = {}) {
  const mem = {
    internal: { base: 0x08000000, data: new Uint8Array(0x80000).fill(0x00) },
    external: { base: 0x90000000, data: new Uint8Array(0x800000).fill(0xAA) },   // garbage: must be erased
    ram: { base: RAM_START, data: new Uint8Array(0x50000) },
  };
  const put = (region, addr, bytes) => mem[region].data.set(bytes, addr - mem[region].base);
  // kernel header (24 bytes)
  put('internal', 0x08000100, [...MAGIC_FW, ...str8('26.4.0', 8), ...str8('abcdef0', 8), ...MAGIC_FW]);
  // userland header
  const ulAddr = 0x08020000;
  put('internal', ulAddr, [...MAGIC_UL, ...str8('26.4.0', 8),
    ...le32(0x90000000 + 0x100000), ...le32(0x100000),     // storage
    ...le32(EXT_APPS_START), ...le32(EXT_APPS_END),          // external apps flash
    ...le32(0x24010000), ...le32(0x24040000),                // external apps ram
    ...MAGIC_UL]);
  // slot info in RAM
  put('ram', RAM_START, [...MAGIC_SLOT, ...le32(0x08000100), ...le32(ulAddr), ...MAGIC_SLOT]);

  const find = (addr, len = 1) => {
    for (const r of Object.values(mem)) if (addr >= r.base && addr + len <= r.base + r.data.length) return r;
    throw new Error('mock: bad address 0x' + addr.toString(16) + '+' + len);
  };

  // Layout pages (for erase)
  const pages = [];
  { let a = 0x08000000; for (const [n, s] of [[4, 16384], [1, 65536], [3, 131072]]) for (let i = 0; i < n; i++) { pages.push([a, s]); a += s; } }
  for (let i = 0; i < 128; i++) pages.push([0x90000000 + i * 65536, 65536]);

  const st = { state: 2, pointer: 0, pending: null, alt: 0, writes: 0, erases: [], leftAt: null };

  const device = {
    vendorId: 1155, productId: 41617, productName: 'NumWorks Calculator', serialNumber: 'EAAbABVROTUxNDM4',
    opened: false, configuration: null,
    configurations: [{ configurationValue: 1, interfaces: [{ interfaceNumber: 0, claimed: false, alternate: null,
      alternates: [{ alternateSetting: 0, interfaceClass: 254, interfaceSubclass: 1, interfaceProtocol: 2 },
                   { alternateSetting: 1, interfaceClass: 254, interfaceSubclass: 1, interfaceProtocol: 2 }] }] }],
    async open() { this.opened = true; log.push('open'); },
    async close() { this.opened = false; log.push('close'); },
    async selectConfiguration(v) { this.configuration = this.configurations[0]; log.push('selectConfiguration ' + v); },
    async claimInterface(n) { this.configuration.interfaces[n].claimed = true; log.push('claim ' + n); },
    async selectAlternateInterface(n, alt) { st.alt = alt; if (this.configuration) this.configuration.interfaces[n].alternate = alt; log.push('alt ' + n + ',' + alt); },
    async controlTransferIn(setup, length) {
      log.push('IN ' + JSON.stringify(setup) + ' len=' + length);
      const ok = (bytes) => { const u = Uint8Array.from(bytes); return { status: 'ok', data: new DataView(u.buffer) }; };
      if (setup.requestType === 'standard') {
        if (setup.request === 8) return ok([1]);
        if (setup.request === 10) return ok([0]);
        if (setup.request === 6) {
          const t = setup.value >> 8;
          if (t === 1) { const d = new Array(18).fill(0); d[0] = 18; d[1] = 1; d[12] = 0x20; d[13] = 0x01; return ok(d); }
          if (t === 2) {
            const itf = (alt, i) => [9, 4, 0, alt, 0, 254, 1, 2, i];
            const body = [...itf(0, 4), ...itf(1, 5)];
            const d = [9, 2, ...[9 + body.length & 255, (9 + body.length) >> 8], 1, 1, 0, 0x80, 50, ...body];
            return ok(length === 4 ? d.slice(0, 4) : d);
          }
          if (t === 3) {
            const idx = setup.value & 255;
            const u = utf16le(idx === 4 ? LAYOUT_STRING : '@SRAM  /0x24000000/01*320Ke');
            return { status: 'ok', data: new DataView(u.buffer) };
          }
        }
        throw new Error('mock: standard IN ' + JSON.stringify(setup));
      }
      switch (setup.request) {
        case 5: return ok([st.state]);
        case 3: {
          if (st.state === 3) { // run the pending command
            const p = st.pending; st.pending = null;
            if (p) p();
            st.state = 4;
          } else if (st.state === 4) st.state = 5;
          else if (st.state === 6) st.state = 7;
          return ok([0, 0, 0, 0, st.state, 0]);
        }
        case 2: {
          const addr = st.pointer + (setup.value - 2) * 2048;
          const r = find(addr, length);
          return ok(r.data.subarray(addr - r.base, addr - r.base + length));
        }
      }
      throw new Error('mock: class IN ' + setup.request);
    },
    async controlTransferOut(setup, data) {
      const bytes = data ? new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data) : new Uint8Array(0);
      log.push('OUT req=' + setup.request + ' val=' + setup.value + ' data=' + Buffer.from(bytes).toString('hex').slice(0, 24) + (bytes.length > 12 ? '…(' + bytes.length + ')' : ''));
      switch (setup.request) {
        case 6: st.state = 2; return { status: 'ok', bytesWritten: 0 };
        case 4: st.state = 2; return { status: 'ok', bytesWritten: 0 };
        case 1: {
          if (setup.value === 0) {
            const dv = new DataView(bytes.buffer);
            const cmd = bytes[0], addr = dv.getUint32(1, true);
            if (cmd === 0x21) st.pending = () => { st.pointer = addr; };
            else if (cmd === 0x41) st.pending = () => {
              const pg = pages.find(([a, s]) => addr >= a && addr < a + s);
              if (!pg) throw new Error('mock: erase of non-page address ' + addr.toString(16));
              const r = find(pg[0], pg[1]); r.data.fill(0xFF, pg[0] - r.base, pg[0] - r.base + pg[1]);
              st.erases.push(pg[0]);
            };
            else throw new Error('mock: bad dfuse cmd ' + cmd);
            st.state = 3;
          } else if (bytes.length === 0) { st.leftAt = st.pointer; st.state = 6; }
          else {
            const addr = st.pointer;
            st.pending = () => {
              const r = find(addr, bytes.length);
              const off = addr - r.base;
              for (let i = 0; i < bytes.length; i++) {
                if (r.data[off + i] !== 0xFF && r.data[off + i] !== bytes[i] && addr >= 0x90000000)
                  throw new Error('mock: write to unerased flash at 0x' + (addr + i).toString(16));
              }
              r.data.set(bytes, off); st.writes++;
            };
            st.state = 3;
          }
          return { status: 'ok', bytesWritten: bytes.length };
        }
      }
      throw new Error('mock: class OUT ' + setup.request);
    },
  };
  return { device, mem, st, log };
}
