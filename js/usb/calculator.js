// Calculator-level logic, ported from NumWorks' `ak` (base) and `aU` (graphing
// calculator) classes and the `aG` connection helper in their app-loader bundle.

import { DFU, DFUError } from './dfu.js';

export class CalculatorError extends Error {
  constructor(name, msg) { super(msg); this.name = name; }
}
const err = (name) => (msg) => new CalculatorError(name, msg);
export const MemoryCorruption = err('CalculatorMemoryCorruption');
export const WebUSBError = err('WebUSBError');
export const ForbiddenMemoryAccess = err('ForbiddenMemoryAccessError');
export const USBConnectionError = err('USBConnectionError');
export const BusyError = err('BusyCalculatorError');

// ---- device models ------------------------------------------------------
const N011x = {
  ElectronicSignatureAddress: 0x1ff07a10,
  RAMAddressStart: 0x20000000, RAMAddressEnd: 0x20040000,
  InternalFlashStart: 0x8000000, InternalFlashEnd: 0x8010000,
  ExternalFlashStart: 0x90000000, ExternalFlashEnd: 0x90800000,
};
const N0120x = {
  ElectronicSignatureAddress: 0x1ff1e800,
  RAMAddressStart: 0x24000000, RAMAddressEnd: 0x24050000,
  InternalFlashStart: 0x8000000, InternalFlashEnd: 0x8080000,
  ExternalFlashStart: 0x90000000, ExternalFlashEnd: 0x90800000,
};
export const MODELS = {
  N0100: {
    name: 'N0100', ElectronicSignatureAddress: 0x1fff7a10,
    RAMAddressStart: 0x20000000, RAMAddressEnd: 0x20040000,
    InternalFlashStart: 0x8000000, InternalFlashEnd: 0x8100000,
    ExternalFlashStart: -1, ExternalFlashEnd: -1,
  },
  N0110: { name: 'N0110', ...N011x },
  N0115: { name: 'N0115', ...N011x },
  N0120: { name: 'N0120', ...N0120x },
  N0120Prototype: { displayed_name: 'N0120', name: 'N0120_PORTUGAL_PROTOTYPE_20210930', ...N0120x },
  N0200: {
    name: 'N0200',
    InternalFlashStart: 0x98000000, InternalFlashEnd: 0x98040000,
    ExternalFlashStart: -1, ExternalFlashEnd: -1,
    RAMAddressStart: -1, RAMAddressEnd: -1,
    ResetLeaveAddress: 0x8000000,
  },
};

export const USB_VENDOR_ID = 1155;           // 0x0483 (STMicroelectronics)
export const PRODUCT_EPSILON = 41617;        // 0xA291 NumWorks Calculator (graphing)
export const PRODUCT_SCANDIUM = 42266;       // 0xA51A NumWorks Scientific Calculator

// Magic markers in firmware headers
const MAGIC_FIRMWARE = Uint8Array.of(0xF0, 0x0D, 0xC0, 0xDE);
const MAGIC_USERLAND = Uint8Array.of(0xFE, 0xED, 0xC0, 0xDE);
const MAGIC_SLOTINFO = Uint8Array.of(0xBA, 0xDB, 0xEE, 0xEF);

const startsWith = (a, p) => { if (a.length < p.length) return false; for (let i = 0; i < p.length; i++) if (a[i] !== p[i]) return false; return true; };
const endsWith = (a, p) => a.length >= p.length && startsWith(a.subarray(a.length - p.length), p);
const cString = (a) => { const z = a.indexOf(0); return new TextDecoder('utf-8').decode(z < 0 ? a : a.subarray(0, z)); };
const hex = (n) => Number(n).toString(16);

export class Calculator {
  constructor(device) {
    this.dfu = new DFU(device, 2048);
    this.running = false;
    this.infos = false;
  }

  get device() { return this.dfu.device; }

  /** Open the device, run `fn(this)`, close it again. */
  async process(fn) {
    if (this.running) throw BusyError('Calculator is already processing another request');
    this.running = true;
    try {
      await this.dfu.open();
      const result = await fn(this);
      return result;
    } finally {
      this.running = false;
      // After `leave()` the device re-enumerates, so close() may legitimately fail.
      try { if (this.dfu.device.opened) await this.dfu.close(); } catch { /* ignore */ }
    }
  }

  isAddressValidFlash(model, address, length) {
    const end = address + length;
    const inInternal = model.InternalFlashStart <= address && end <= model.InternalFlashEnd;
    const inExternal = model.ExternalFlashStart <= address && end <= model.ExternalFlashEnd;
    if (!inInternal && !inExternal)
      throw ForbiddenMemoryAccess('Access to address: ' + address + ' (length ' + length + ') is out of flash range');
  }

  isAddressValidRAM(model, address, length) {
    if (!(model.RAMAddressStart <= address && address + length <= model.RAMAddressEnd))
      throw ForbiddenMemoryAccess('Access to address: ' + address + ' (length ' + length + ') is out of RAM range');
  }

  // ---- identification ---------------------------------------------------
  async detectModel(layout) {
    const dev = this.dfu.device;
    const isCalc = dev.productName === 'NumWorks Calculator';
    const isSci = dev.productName === 'NumWorks Scientific Calculator';
    const isBootloader = dev.productName === 'STM32  BOOTLOADER';
    if (!isCalc && !isSci && !isBootloader) throw new Error('Device model cannot be retrieved.');
    if (isCalc || isSci) {
      const d = new Uint8Array(await this.dfu.getDeviceDescriptor());
      switch ((d[13] << 8) + d[12]) {          // bcdDevice
        case 0x200: return MODELS.N0200;
        case 0x120: return dev.serialNumber === 'EAAbABVROTUxNDM4' ? MODELS.N0120Prototype : MODELS.N0120;
        case 0x115: return MODELS.N0115;
        case 0x110: return MODELS.N0110;
        case 0x100: break;
        default: throw new Error('Device model cannot be retrieved.');
      }
    }
    const last = layout[layout.length - 1].lastAddress;
    return last > 0x80e0000 && last < 0x90000000 ? MODELS.N0100 : MODELS.N0110;
  }

  async readSerial(model) {
    const sn = this.dfu.device.serialNumber;
    if (sn.length === 16) return sn;
    const raw = (await this.dfu.upload(model.ElectronicSignatureAddress - 1, 13)).subarray(1, 13);
    let hexStr = '';
    for (const b of raw) hexStr += b.toString(16).padStart(2, '0').toUpperCase();
    return btoa(hexStr.match(/\w{2}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join(''));
  }

  async extractInfos() {
    if (this.infos !== false) return this;
    try {
      const memoryLayout = await this.dfu.getMemoryLayout();
      const model = await this.detectModel(memoryLayout);
      const firmware = await this.readHeader(memoryLayout, model);
      const displayedSerialNumber = await this.readSerial(model);
      this.infos = { displayedSerialNumber, model, memoryLayout, firmware };
      return this;
    } catch (e) {
      e.message = 'extractInfos failed --> ' + e.message;
      throw e;
    }
  }

  // Parse the "firmware header" (version, storage and external-apps regions).
  parseFirmwareHeader(buf, info) {
    if (!startsWith(buf, MAGIC_FIRMWARE)) return;
    info.version = cString(buf.subarray(4));
    info.patch = cString(buf.subarray(12));
    let rest = buf.subarray(20);
    if (startsWith(rest, MAGIC_FIRMWARE)) return;
    const dv = new DataView(buf.buffer, buf.byteOffset);
    info.storageAddress = dv.getUint32(20, true);
    rest = buf.subarray(24);
    if (!startsWith(rest, MAGIC_FIRMWARE)) info.storageSize = dv.getUint32(24, true);
  }

  async readHeader(layout, model) {
    const info = {
      version: '0.0.0', patch: '0000000', userlandVersion: 'unknown',
      trampolineAddress: 'unknown',
      externalAppsFlashStart: 'unknown', externalAppsFlashEnd: 'unknown',
      externalAppsRamStart: 'unknown', externalAppsRamEnd: 'unknown',
      deviceNameFlashStart: 'unknown', deviceNameFlashEnd: 'unknown',
      storageAddress: 'unknown', storageSize: 4096,
    };
    const dfu = this.dfu;
    try {
      // Older firmwares: the header sits at a fixed offset of the first segment.
      const tryOffset = async (offset, size) => {
        const address = layout[0].address + offset;
        this.isAddressValidFlash(model, address, size);
        const buf = await dfu.upload(address, size);
        if (startsWith(buf, MAGIC_FIRMWARE) && endsWith(buf, MAGIC_FIRMWARE)) {
          this.parseFirmwareHeader(buf, info);
          return true;
        }
        return false;
      };
      if (await tryOffset(428, 24) || await tryOffset(452, 32)) return info;

      // Newer firmwares: two slots. Slot info lives in RAM (alternate setting 1).
      const slotAddr = model.RAMAddressStart;
      this.isAddressValidRAM(model, slotAddr, 16);
      const slotBuf = await dfu.upload(slotAddr, 16, undefined, 1);
      try {
        if (!startsWith(slotBuf, MAGIC_SLOTINFO) || !endsWith(slotBuf, MAGIC_SLOTINFO))
          throw MemoryCorruption('The slot info was corrupted');
        const sdv = new DataView(slotBuf.buffer, slotBuf.byteOffset);
        const kernelHeaderAddress = sdv.getUint32(4, true);
        const userlandHeaderAddress = sdv.getUint32(8, true);

        this.isAddressValidFlash(model, kernelHeaderAddress, 24);
        this.parseFirmwareHeader(await dfu.upload(kernelHeaderAddress, 24), info);

        this.isAddressValidFlash(model, userlandHeaderAddress, 48);
        const u = await dfu.upload(userlandHeaderAddress, 48);
        if (!startsWith(u, MAGIC_USERLAND)) throw MemoryCorruption('The userland header was corrupted');
        const end = this.parseUserlandHeader(u, info);
        if (end < 0 || !startsWith(u.subarray(end), MAGIC_USERLAND))
          throw MemoryCorruption('The userland header was corrupted');
        info.trampolineAddress = userlandHeaderAddress + end + MAGIC_USERLAND.byteLength + 8;
      } catch (e) {
        // NumWorks' code swallows this too and keeps the defaults ("unknown" regions).
        // We keep the reason so the UI can refuse to flash with an unreadable header.
        info.headerError = e.message;
      }
      return info;
    } catch (e) {
      e.message = 'Upload header failed --> ' + e.message;
      throw e;
    }
  }

  // Returns the offset just after the fields that were parsed, or -1.
  parseUserlandHeader(buf, info) {
    if (!startsWith(buf, MAGIC_USERLAND)) return -1;
    info.userlandVersion = cString(buf.subarray(4));
    const dv = new DataView(buf.buffer, buf.byteOffset);
    let p = 12;
    info.storageAddress = dv.getUint32(p, true); p += 4;
    info.storageSize = dv.getUint32(p, true); p += 4;
    info.externalAppsFlashStart = dv.getUint32(p, true); p += 4;
    info.externalAppsFlashEnd = dv.getUint32(p, true); p += 4;
    if (startsWith(buf.subarray(p), MAGIC_USERLAND)) return p;
    info.externalAppsRamStart = dv.getUint32(p, true); p += 4;
    info.externalAppsRamEnd = dv.getUint32(p, true); p += 4;
    if (startsWith(buf.subarray(p), MAGIC_USERLAND)) return p;
    info.deviceNameFlashStart = dv.getUint32(p, true); p += 4;
    info.deviceNameFlashEnd = dv.getUint32(p, true); p += 4;
    return p;
  }

  // ---- what is installed ------------------------------------------------------
  /**
   * Names of the apps in the external-apps area (read only). Each app starts on a 64 KB sector with a
   * 32-byte header (magic, api level, name offset, icon size, icon offset, start, end, magic).
   * Returns [{ address, name }], or null when this calculator's layout is not known. Call inside process().
   */
  async readInstalledApps() {
    const fw = this.infos && this.infos.firmware;
    if (!fw || typeof fw.externalAppsFlashStart !== 'number' || typeof fw.externalAppsFlashEnd !== 'number') return null;
    const SECTOR = 65536, MAGIC = 0xDEC0BEBA;
    const model = this.infos.model, end = fw.externalAppsFlashEnd;
    const apps = [];
    let addr = fw.externalAppsFlashStart;
    for (let guard = 0; addr + SECTOR <= end && apps.length < 16 && guard < 200; guard++) {
      this.isAddressValidFlash(model, addr, 32);
      const h = await this.dfu.upload(addr, 32);
      const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
      if (dv.getUint32(0, true) === MAGIC && dv.getUint32(28, true) === MAGIC) {
        const nameOffset = dv.getUint32(8, true), endOffset = dv.getUint32(24, true);
        let name = '';
        if (nameOffset > 0 && nameOffset < 0x400000 && addr + nameOffset + 48 <= model.ExternalFlashEnd) {
          name = cString(await this.dfu.upload(addr + nameOffset, 48));
        }
        apps.push({ address: addr, name });
        // The app is at least `endOffset` long (its data section follows); keep scanning sector by sector from there.
        addr += Math.max(SECTOR, Math.ceil(endOffset / SECTOR) * SECTOR);
      } else if (h.every((b) => b === 0xff)) {
        break;                                  // erased sector: end of the list
      } else {
        addr += SECTOR;                          // inside an app (its data section), keep going
      }
    }
    return apps;
  }

  // ---- flash writes -----------------------------------------------------
  /**
   * Erase every page that `data` will cover, then write it.
   * onErase / onWrite receive progress in [0,1].
   */
  async downloadFlash(address, data, onErase, onWrite) {
    try {
      await this.extractInfos();
      this.isAddressValidFlash(this.infos.model, address, data.byteLength);
      await this.erasePagesFor(address, data, onErase);
      await this.dfu.download(address, data, onWrite);
    } catch (e) {
      e.message = 'downloadFlash failed --> ' + e.message;
      throw e;
    }
  }

  async erasePagesFor(address, data, onProgress) {
    const layout = this.infos.memoryLayout;
    let counted = 0;
    let startSeg = -1, startPage = -1, endSeg = -1, endPage = -1;

    // Find the first and last page touched by [address, address + data.byteLength)
    search:
    for (let s = 0; s < layout.length; s++) {
      if (startSeg < 0) {
        if (address > layout[s].lastAddress) continue;
        startSeg = s;
      }
      for (let p = 0; p < layout[s].nbPage; p++) {
        if (startPage < 0) {
          if (address !== layout[s].address + p * layout[s].pageSize) continue;
          startPage = p;
        }
        counted += layout[s].pageSize;
        if (counted >= data.byteLength) { endSeg = s; endPage = p; break search; }
      }
    }
    // Safety net (not in NumWorks' code): never write without a full, aligned erase plan.
    if (startSeg < 0 || startPage < 0 || endSeg < 0)
      throw new DFUError('Cannot plan the flash erase: address ' + hex(address) + ' is not page-aligned or the data does not fit');

    let erased = 0;
    for (let s = startSeg; s <= endSeg; s++) {
      const from = s === startSeg ? startPage : 0;
      const to = s === endSeg ? endPage + 1 : layout[s].nbPage;
      for (let p = from; p < to; p++) {
        await this.dfu.eraseSegment(layout[s].address + p * layout[s].pageSize);
        erased += layout[s].pageSize;
        if (onProgress) onProgress(erased / counted);
      }
    }
  }

  async reset() {
    await this.extractInfos();
    const addr = this.infos.model.ResetLeaveAddress || this.infos.model.InternalFlashStart;
    await this.dfu.leave(addr);
    this.running = false;
    this.infos = false;
    return true;
  }
}

// ---- connection ---------------------------------------------------------
const PRODUCT_IDS = [PRODUCT_EPSILON, PRODUCT_SCANDIUM];

export function webUsbAvailable() { return typeof navigator !== 'undefined' && navigator.usb != null; }

/** Previously-authorised devices (no prompt). Returns Calculator[]. */
export async function getKnownCalculators(usb = navigator.usb) {
  if (!usb) throw WebUSBError('Web usb unvailable');
  const devices = await usb.getDevices();
  return devices
    .filter((d) => d.vendorId === USB_VENDOR_ID && PRODUCT_IDS.includes(d.productId))
    .map((d) => new Calculator(d));
}

/** Shows the browser's device picker. Must be called from a user gesture. */
export async function requestCalculator(usb = navigator.usb) {
  if (!usb) throw WebUSBError('Web usb unvailable');
  let device;
  try {
    device = await usb.requestDevice({ filters: PRODUCT_IDS.map((productId) => ({ vendorId: USB_VENDOR_ID, productId })) });
  } catch (e) {
    throw USBConnectionError('Usb device selection failure: ' + e);
  }
  return new Calculator(device);
}
