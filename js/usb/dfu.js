// WebUSB DfuSe client for NumWorks calculators.
//
// Ported 1:1 (same control transfers, same order) from the `au` class and its
// helper functions in NumWorks' own app-loader bundle, with names restored.

export class DFUError extends Error {
  constructor(msg) { super(msg); this.name = 'DFUError'; }
}
export class DFUInterfaceError extends Error {
  constructor(msg) { super(msg); this.name = 'DFUInterfaceError'; }
}

// DFU class requests
const REQ_DNLOAD = 1;
const REQ_UPLOAD = 2;
const REQ_GETSTATUS = 3;
const REQ_CLRSTATUS = 4;
const REQ_GETSTATE = 5;
const REQ_ABORT = 6;

// DFU states
const STATE_IDLE = 2;
const STATE_DNBUSY = 4;
const STATE_DNLOAD_IDLE = 5;
const STATE_MANIFEST_WAIT_RESET = 7;
const STATE_ERROR = 10;

// DfuSe commands (first byte of a block-0 DNLOAD)
const DFUSE_SET_ADDRESS = 0x21;
const DFUSE_ERASE_PAGE = 0x41;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DFU {
  constructor(device, transferSize = 2048) {
    this.device = device;
    this.transferSize = transferSize;
    this.settings = findDfuInterface(device);
  }

  // ---- low-level control transfers ------------------------------------
  async requestIn(request, length, value = 0) {
    let res;
    try {
      res = await this.device.controlTransferIn({
        requestType: 'class', recipient: 'interface', request, value,
        index: this.settings.interface.interfaceNumber,
      }, length);
    } catch (e) { throw new Error('ControlTransferIn failed --> ' + e); }
    if (res.status !== 'ok') throw new Error('Wrong requestIn status: ' + res.status);
    return res.data;
  }

  async requestOut(request, data, value = 0) {
    let res;
    try {
      res = await this.device.controlTransferOut({
        requestType: 'class', recipient: 'interface', request, value,
        index: this.settings.interface.interfaceNumber,
      }, data);
    } catch (e) { throw new Error('ControlTransferOut failed --> ' + e); }
    if (res.status !== 'ok') throw new Error('Wrong requestOut status: ' + res.status);
    return res.bytesWritten;
  }

  async getState() {
    try { return (await this.requestIn(REQ_GETSTATE, 1)).getUint8(0); }
    catch (e) { throw new Error('Get state failed --> ' + e); }
  }

  async getStatus() {
    try {
      const d = await this.requestIn(REQ_GETSTATUS, 6);
      return {
        status: d.getUint8(0),
        pollTimeout: d.getUint32(1, true) & 0xffffff,
        state: d.getUint8(4),
      };
    } catch (e) { throw new Error('Get status failed --> ' + e); }
  }

  async abortToIdle() {
    try {
      await this.requestOut(REQ_ABORT);
      let state = await this.getState();
      if (state === STATE_ERROR) {
        await this.requestOut(REQ_CLRSTATUS);
        state = await this.getState();
      }
      if (state !== STATE_IDLE) throw new Error('State is ' + state + ' instead of DFU IDLE (2).');
    } catch (e) { throw new Error('Abort to idle failed --> ' + e); }
  }

  // Poll until predicate(state) is true (or the device reports the error state).
  async pollUntil(predicate, fixedDelay = null) {
    try {
      let st = await this.getStatus();
      if (st.status !== 0) throw 'Status is ' + st.status + ' instead of Status OK (0).';
      const delay = fixedDelay != null ? fixedDelay : st.pollTimeout;
      while (!predicate(st.state) && st.state !== STATE_ERROR) {
        await sleep(delay);
        st = await this.getStatus();
        if (st.status !== 0) throw 'Status is ' + st.status + ' instead of Status OK (0).';
      }
      return st;
    } catch (e) { throw new Error('Poll until failed --> ' + e); }
  }

  async setAddress(address) {
    const buf = new ArrayBuffer(5);
    const v = new DataView(buf);
    v.setUint8(0, DFUSE_SET_ADDRESS);
    v.setUint32(1, address, true);
    try {
      let st;
      do {
        await this.requestOut(REQ_DNLOAD, buf, 0);
        st = await this.pollUntil((s) => s !== STATE_DNBUSY, 0);
      } while (st.state !== STATE_DNLOAD_IDLE);
    } catch (e) { throw new Error('Set address to ' + address + ' failed --> ' + e); }
  }

  // ---- open / close ---------------------------------------------------
  async open() {
    try { await this.device.open(); }
    catch (e) { throw new DFUError('OPEN failed --> ' + e); }

    const cfg = this.settings.configuration.configurationValue;
    if (this.device.configuration == null || this.device.configuration.configurationValue !== cfg) {
      try { await this.device.selectConfiguration(cfg); }
      catch (e) { throw new DFUError('OPEN failed: could not select configuration --> ' + e); }
    }

    const itf = this.settings.interface.interfaceNumber;
    if (!this.device.configuration.interfaces[itf].claimed) {
      try { await this.device.claimInterface(itf); }
      catch (e) { throw new DFUInterfaceError('OPEN failed: could not claim interface --> ' + e); }
    }

    const alt = this.settings.alternate.alternateSetting;
    const cur = this.device.configuration.interfaces[itf].alternate;
    if (cur == null || cur !== alt) {
      try { await this.device.selectAlternateInterface(itf, alt); }
      catch (e) { throw new DFUError('OPEN failed: could not select alternate interface --> ' + e); }
    }
  }

  async close() {
    try { await this.device.close(); }
    catch (e) { throw new DFUError('CLOSE failed --> ' + e); }
  }

  // ---- descriptors / memory layout -----------------------------------
  async getMemoryLayout() {
    try {
      const dev = this.device;
      const ctl = async (setup, length, what) => {
        let r;
        try { r = await dev.controlTransferIn(setup, length); }
        catch (e) { throw new Error(what + ' failed --> ' + e); }
        if (r.status !== 'ok') throw new Error('Wrong ' + what + ' status: ' + r.status);
        return r.data;
      };

      const cfgIndex = (await ctl({ requestType: 'standard', recipient: 'device', request: 8, value: 0, index: 0 }, 1, 'Get configuration')).getInt8(0);
      const descIndex = cfgIndex - 1;

      // Configuration descriptor: first 4 bytes tell us the total length.
      const head = await ctl({ requestType: 'standard', recipient: 'device', request: 6, value: 0x200 | descIndex, index: 0 }, 4, 'Get configuration descriptor');
      const total = head.getUint16(2, true);
      const full = await ctl({ requestType: 'standard', recipient: 'device', request: 6, value: 0x200 | descIndex, index: 0 }, total, 'Get configuration descriptor');
      const config = parseConfigurationDescriptor(full);

      const altSetting = (await ctl({ requestType: 'standard', recipient: 'interface', request: 10, value: 0, index: this.settings.interface.interfaceNumber }, 1, 'Get interface')).getInt8(0);
      const iInterface = config.interfaces[altSetting].iInterface;

      const strData = await ctl({ requestType: 'standard', recipient: 'device', request: 6, value: 0x300 | iInterface, index: 0x409 }, 255, 'Get string descriptor');
      if (strData.getInt8(1) !== 3) throw new Error('Wrong descriptor type: ' + strData.getInt8(1));
      const str = new TextDecoder('utf-16').decode(new Uint16Array(strData.buffer, strData.byteOffset + 2, (strData.byteLength - 2) >> 1));

      // "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg/0x90000000/..."
      const parts = str.split('/');
      const name = parts[0];
      const layout = [];
      for (let i = 1; i < parts.length; i += 2) {
        let address = parseInt(parts[i]);
        for (const seg of parts[i + 1].split(',')) {
          const m = seg.match(/(\d+)\*(\d+)([B|K|M])(\w)/);
          const nbPage = parseInt(m[1]);
          let pageSize = parseInt(m[2]);
          if (m[3] === 'K') pageSize *= 1024; else if (m[3] === 'M') pageSize *= 1048576;
          const size = nbPage * pageSize;
          layout.push({ name, address, lastAddress: address + size - 1, size, nbPage, pageSize, type: m[4] });
          address += size;
        }
      }
      return layout;
    } catch (e) { throw new DFUError('GET MEMORY LAYOUT failed --> ' + e); }
  }

  async getDeviceDescriptor() {
    try {
      const r = await this.device.controlTransferIn({ requestType: 'standard', recipient: 'device', request: 6, value: 0x100, index: 0 }, 255);
      if (r.status !== 'ok') throw new Error('Wrong privateGetDeviceDescriptor status: ' + r.status);
      return r.data.buffer;
    } catch (e) { throw new DFUError('getDeviceDescriptor failed --> ' + e); }
  }

  // ---- memory access --------------------------------------------------
  async upload(address, length, onProgress, alt = 0) {
    try {
      await this.device.selectAlternateInterface(0, alt);
      if ((await this.getState()) !== STATE_IDLE) await this.abortToIdle();
      await this.setAddress(address);
      await this.abortToIdle();
      let block = 2;
      const out = new Uint8Array(length);
      let got = 0;
      if (onProgress) onProgress(0);
      do {
        const n = Math.min(this.transferSize, length - got);
        const data = await this.requestIn(REQ_UPLOAD, n, block++);
        if (data.byteLength > 0) {
          out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), got);
          got += data.byteLength;
        }
        if (onProgress) onProgress(got / length);
      } while (got < length);
      await this.abortToIdle();
      return out;
    } catch (e) {
      await this.abortToIdle().catch(() => {});
      throw new DFUError('UPLOAD failed at address ' + address + ' of length ' + length + ' --> ' + e);
    } finally {
      if (alt !== 0) await this.device.selectAlternateInterface(0, 0);
    }
  }

  async download(address, data, onProgress, alt = 0) {
    try {
      await this.device.selectAlternateInterface(0, alt);
      let done = 0;
      const total = data.byteLength;
      let addr = address;
      if (onProgress) onProgress(0);
      while (done < total) {
        const n = Math.min(total - done, this.transferSize);
        await this.setAddress(addr);
        const written = await this.requestOut(REQ_DNLOAD, data.slice(done, done + n), 2);
        await this.pollUntil((s) => s === STATE_DNLOAD_IDLE);
        addr += n;
        done += written;
        if (onProgress) onProgress(done / total);
      }
    } catch (e) {
      throw new DFUError('DOWNLOAD failed at address ' + Number(address).toString(16) + ' --> ' + e);
    } finally {
      if (alt !== 0) await this.device.selectAlternateInterface(0, 0);
    }
  }

  // Leave DFU and (re)start the device, jumping to `address`.
  async leave(address) {
    try {
      await this.setAddress(address);
      await this.requestOut(REQ_DNLOAD, new ArrayBuffer(0), 2);
      await this.pollUntil((s) => s === STATE_MANIFEST_WAIT_RESET);
    } catch (e) {
      throw new DFUError('LEAVE failed at address ' + Number(address).toString(16) + ' --> ' + e);
    }
  }

  async eraseSegment(address) {
    try {
      if ((await this.getState()) !== STATE_IDLE) await this.abortToIdle();
      const buf = new ArrayBuffer(5);
      const v = new DataView(buf);
      v.setUint8(0, DFUSE_ERASE_PAGE);
      v.setUint32(1, address, true);
      let st;
      do {
        await this.requestOut(REQ_DNLOAD, buf, 0);
        st = await this.getStatus();
        if (st.status !== 0) throw 'wrong DFU status: ' + st.status;
      } while (st.state !== STATE_DNBUSY);
      st = await this.pollUntil((s) => s !== STATE_DNBUSY);
      if (st.status !== 0) throw 'wrong DFU status: ' + st.status;
    } catch (e) {
      throw new DFUError('ERASE SEGMENT failed at address ' + address + ' --> ' + e);
    }
  }
}

// ---- helpers ----------------------------------------------------------
function findDfuInterface(device) {
  for (const configuration of device.configurations)
    for (const itf of configuration.interfaces)
      for (const alternate of itf.alternates)
        if (alternate.interfaceClass === 254 && alternate.interfaceSubclass === 1 &&
            (alternate.interfaceProtocol === 1 || alternate.interfaceProtocol === 2))
          return { configuration, interface: itf, alternate };
  // Fallback used by NumWorks' code
  return {
    configuration: { configurationValue: 1 },
    interface: { interfaceNumber: 0 },
    alternate: { alternateSetting: 0 },
  };
}

function parseConfigurationDescriptor(dv) {
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const cfg = {
    bLength: bytes[0], bDescriptorType: bytes[1],
    wTotalLength: bytes[2] | (bytes[3] << 8),
    bNumInterfaces: bytes[4], bConfigurationValue: bytes[5],
    iConfiguration: bytes[6], bmAttributes: bytes[7], bMaxPower: bytes[8],
    interfaces: [],
  };
  let cur = null;
  let p = 9;
  while (bytes.length - p > 2) {
    const len = bytes[p];
    const type = bytes[p + 1];
    if (len < 2) break;                       // malformed, avoid an infinite loop
    if (type === 4) {
      cur = {
        bLength: len, bDescriptorType: type,
        bInterfaceNumber: bytes[p + 2], bAlternateSetting: bytes[p + 3],
        bNumEndpoints: bytes[p + 4], bInterfaceClass: bytes[p + 5],
        bInterfaceSubClass: bytes[p + 6], bInterfaceProtocol: bytes[p + 7],
        iInterface: bytes[p + 8], endpoints: [],
      };
      cfg.interfaces.push(cur);
    } else {
      const d = { bLength: len, bDescriptorType: type, data: bytes.slice(p, p + len) };
      if (cur) cur.endpoints.push(d); else cfg.interfaces.push(d);
    }
    p += len;
  }
  return cfg;
}
