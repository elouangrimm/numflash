// Links .nwa apps for a given calculator, using the same GNU ld / objcopy
// WebAssembly builds that NumWorks' own uploader uses.
//
// Ported from the `a5` (NWA app), `a6` (app group) and `aZ` (objcopy runner)
// definitions in NumWorks' app-loader bundle.

import ldFactory from '../vendor/ld-glue.js';
import objcopyFactory from '../vendor/objcopy-glue.js';
import { EADK_O } from '../vendor/eadk-o.js';
import { renderLinkerScript } from '../vendor/linker-script.js';
import { nwiToRgba, rgbaToDataUrl } from './lz4.js';

export const APP_SECTOR_SIZE = 65536;

export class LinkerError extends Error {
  constructor(name, msg) { super(msg); this.name = name; }
}

// ---- WASM binaries ----------------------------------------------------------
const wasm = { ld: null, objcopy: null };

export function setWasmBinaries({ ld, objcopy }) {
  if (ld) wasm.ld = new Uint8Array(ld);
  if (objcopy) wasm.objcopy = new Uint8Array(objcopy);
}
export function wasmReady() { return !!(wasm.ld && wasm.objcopy); }

function needWasm(which) {
  if (!wasm[which]) throw new LinkerError('MissingWasm', which + '.wasm has not been loaded');
  return wasm[which];
}

// ---- running the tools --------------------------------------------------------
/** Run objcopy on a single input blob. Resolves with the output file. */
export function objcopy({ arguments: args, input }) {
  const wasmBinary = needWasm('objcopy');
  return new Promise((resolve, reject) => {
    const mod = {
      wasmBinary,
      locateFile: (f) => f,
      print: () => {},
      preRun() { mod.FS.writeFile('input.dat', input); },
      onAbort: reject,
      arguments: args.concat(['input.dat', 'output.dat']),
      postRun() { resolve(mod.FS.readFile('output.dat')); },
    };
    try {
      const ready = objcopyFactory(mod);
      if (ready && ready.catch) ready.catch(reject);
    } catch (e) { reject(e); }
  });
}

/** Run ld with a script and inputs, resolving with the linked ELF. */
function runLd(inputs, args) {
  const wasmBinary = needWasm('ld');
  return new Promise((resolve, reject) => {
    const mod = {
      wasmBinary,
      locateFile: (f) => f,
      print: () => {},
      preRun() { for (const [name, data] of Object.entries(inputs)) mod.FS.writeFile(name, data); },
      printErr(line) { mod.errorLog = (mod.errorLog || '') + line + '\n'; },
      onAbort: reject,
      arguments: args.concat(['--output', 'output.elf']),
      postRun() { mod.errorLog ? reject(mod.errorLog) : resolve(mod.FS.readFile('output.elf')); },
    };
    try {
      const ready = ldFactory(mod);
      if (ready && ready.catch) ready.catch(reject);
    } catch (e) { reject(e); }
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- one app -----------------------------------------------------------------
export class NwaApp {
  /** @param {Uint8Array} nwaData  raw .nwa file  @param {string} [label] */
  constructor(nwaData, label = '') {
    this.nwaData = nwaData;
    this.label = label;
    this.name = undefined;
    this.iconUrl = undefined;
    this.size = undefined;                // size on the calculator, in bytes (rounded to 64 KB)
    this.needsExternalData = undefined;
    this.externalData = undefined;
  }

  section(sectionName) {
    return objcopy({ arguments: ['--output-target', 'binary', '--only-section', sectionName], input: this.nwaData });
  }

  async loadName() {
    const raw = await this.section('.rodata.eadk_app_name');
    const z = raw.indexOf(0);
    this.name = new TextDecoder('utf-8').decode(z < 0 ? raw : raw.subarray(0, z));
    return this.name;
  }

  async loadIcon() {
    const nwi = await this.section('.rodata.eadk_app_icon');
    this.iconUrl = rgbaToDataUrl(nwiToRgba(nwi));
    return this.iconUrl;
  }

  /** Name, icon and size. Icon/name failures are not fatal. */
  async load() {
    await tick();
    try { await this.loadName(); } catch (e) { console.warn('name', e); }
    try { await this.loadIcon(); } catch (e) { console.warn('icon', e); }
    await this.refreshSize();
  }

  setExternalData(bytes) {
    this.externalData = bytes;
    return this.refreshSize();
  }

  /** An object file holding the external data blob, as expected by the linker script. */
  externalDataObject() {
    return objcopy({
      arguments: [
        '--input-target', 'binary', '--output-target', 'elf32-littlearm',
        '--rename-section', '.data=.rodata.eadk_external_data,alloc,load,readonly,data,contents',
        '--redefine-sym', '_binary_input_dat_start=_eadk_external_data_start',
        '--redefine-sym', '_binary_input_dat_size=_eadk_external_data_size',
        '--strip-symbol', '_binary_input_dat_end',
      ],
      input: this.externalData,
    });
  }

  async flatElf(region) {
    const args = ['--script', 'linker.ld', '--gc-sections', '--allow-multiple-definition', 'eadk.o', 'app.nwa'];
    const inputs = {
      'linker.ld': renderLinkerScript(region),
      'app.nwa': this.nwaData,
      'eadk.o': EADK_O,
    };
    if (this.externalData) {
      args.push('extra-data.o');
      inputs['extra-data.o'] = await this.externalDataObject();
    }
    return runLd(inputs, args);
  }

  async flatBin(region) {
    await tick();
    const elf = await this.flatElf(region);
    return objcopy({ arguments: ['--output-target', 'binary'], input: elf });
  }

  async refreshSize() {
    try {
      const bin = await this.flatBin({
        flashStart: 0x90000000, flashLength: 8388608,
        ramStart: 0x20000000, ramLength: 262144,
        trampolineStart: 0x90010030,
      });
      this.size = Math.ceil(bin.byteLength / APP_SECTOR_SIZE) * APP_SECTOR_SIZE;
      this.needsExternalData = false;
    } catch (e) {
      if (String(e).includes('_eadk_external_data')) {
        this.size = undefined;
        this.needsExternalData = true;
      } else {
        throw new LinkerError('LinkError', typeof e === 'string' ? e : (e && e.message) || String(e));
      }
    }
  }
}

// ---- a set of apps flashed together ---------------------------------------------
function concat(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0); out.set(b, a.byteLength);
  return out;
}

export class AppGroup {
  constructor() { this.apps = []; }
  push(app) { this.apps.push(app); }
  removeAt(i) { this.apps.splice(i, 1); }
  isReadyToUpload() { return this.apps.length > 0 && this.apps.every((a) => !a.needsExternalData); }
  totalSize() { return this.apps.reduce((s, a) => s + (a.size || 0), 0); }

  /**
   * Link all apps back-to-back into one image for the external-apps region.
   * @param region {flashStart, flashLength, ramStart, ramLength, trampolineStart}
   * @param onApp  optional (index, app) callback before each app is linked
   */
  async flatBin(region, onApp) {
    let out = new Uint8Array(0);
    const end = region.flashStart + region.flashLength;
    let addr = region.flashStart;
    for (let i = 0; i < this.apps.length; i++) {
      const app = this.apps[i];
      if (addr >= end) throw new LinkerError('CalculatorMemoryOverflow', 'External app sector would be overflown');
      if (onApp) onApp(i, app);
      const bin = await app.flatBin({
        flashStart: addr, flashLength: end - addr,
        ramStart: region.ramStart, ramLength: region.ramLength,
        trampolineStart: region.trampolineStart,
      });
      out = concat(out, bin);
      addr += bin.byteLength;
      const rem = bin.byteLength % APP_SECTOR_SIZE;
      if (rem > 0) {
        const pad = new Uint8Array(APP_SECTOR_SIZE - rem).fill(0xff);
        out = concat(out, pad);
        addr += pad.byteLength;
      }
    }
    // A blank sector after the last app marks the end of the list.
    if (addr < end) out = concat(out, new Uint8Array(APP_SECTOR_SIZE).fill(0xff));
    return out;
  }
}

/** Build the linker region from what we read out of the calculator's header. */
export function regionFromInfos(infos) {
  const fw = infos.firmware;
  const nums = ['externalAppsFlashStart', 'externalAppsFlashEnd', 'externalAppsRamStart', 'externalAppsRamEnd', 'trampolineAddress'];
  for (const k of nums) {
    if (typeof fw[k] !== 'number' || !Number.isFinite(fw[k]))
      throw new LinkerError('UnsupportedFirmware',
        'Could not read "' + k + '" from this calculator (' + (fw.headerError || 'header not recognised') + '). Update the calculator and try again.');
  }
  return {
    flashStart: fw.externalAppsFlashStart,
    flashLength: fw.externalAppsFlashEnd - fw.externalAppsFlashStart,
    ramStart: fw.externalAppsRamStart,
    ramLength: fw.externalAppsRamEnd - fw.externalAppsRamStart,
    trampolineStart: fw.trampolineAddress,
  };
}
