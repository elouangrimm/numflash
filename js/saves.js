// Backups of the calculator's Python scripts and game saves, kept on this device per calculator
// (by serial number). Stored in IndexedDB; falls back to memory when the browser has none.
import { isBackupName } from './apps-meta.js';

const DB_NAME = 'numflash-saves';
const KEEP_VERSIONS = 5;

// ---- tiny key/value layer ------------------------------------------------------------------------
const memory = new Map();
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}
async function kv(mode, fn) {
  const db = await openDb();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    let out;
    Promise.resolve(fn(tx.objectStore('kv'))).then((r) => { out = r; }).catch(reject);
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const get = (key) => kv('readonly', (s) => (s ? wrap(s.get(key)) : memory.get(key)));
const put = (key, val) => kv('readwrite', (s) => (s ? wrap(s.put(val, key)) : void memory.set(key, val)));
const del = (key) => kv('readwrite', (s) => (s ? wrap(s.delete(key)) : void memory.delete(key)));

// ---- data model ------------------------------------------------------------------------------------
// 'calcs'            -> { "<serial>": { serial, model, lastSeen } }
// 'files:<serial>'   -> { "<name>": { name, versions: [ { ts, bytes: Uint8Array } ] } }   newest first
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function listCalculators() {
  const calcs = (await get('calcs')) || {};
  return Object.values(calcs).sort((a, b) => b.lastSeen - a.lastSeen);
}
async function touchCalculator(serial, model) {
  const calcs = (await get('calcs')) || {};
  calcs[serial] = { serial, model: model || (calcs[serial] && calcs[serial].model) || '', lastSeen: Date.now() };
  await put('calcs', calcs);
}

export async function listSaves(serial) {
  const files = (await get('files:' + serial)) || {};
  return Object.values(files).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Remember what is on the calculator now. Only Python scripts that are not the calculator's defaults are kept.
 * A new version is stored only when the bytes changed. Nothing is ever removed because it is missing.
 * Returns the names that got a new version.
 */
export async function rememberRecords(serial, model, records, now = Date.now()) {
  await touchCalculator(serial, model);
  const files = (await get('files:' + serial)) || {};
  const changed = [];
  for (const r of records) {
    if (!isBackupName(r.name)) continue;
    const entry = files[r.name] || (files[r.name] = { name: r.name, versions: [] });
    const newest = entry.versions[0];
    if (newest && same(newest.bytes, r.value)) continue;
    entry.versions.unshift({ ts: now, bytes: new Uint8Array(r.value) });
    entry.versions.length = Math.min(entry.versions.length, KEEP_VERSIONS);
    changed.push(r.name);
  }
  if (changed.length) await put('files:' + serial, files);
  return changed;
}

/** Cached scripts the calculator doesn't currently have: what to offer to restore. */
export async function missingOnCalculator(serial, records) {
  const have = new Set(records.map((r) => r.name));
  return (await listSaves(serial)).filter((f) => !have.has(f.name));
}

export async function forgetSave(serial, name) {
  const files = (await get('files:' + serial)) || {};
  delete files[name];
  await put('files:' + serial, files);
}

/** Start from scratch for one calculator, or everything. */
export async function clearSaves(serial) {
  if (serial) { await del('files:' + serial); const c = (await get('calcs')) || {}; delete c[serial]; await put('calcs', c); return; }
  for (const c of await listCalculators()) await del('files:' + c.serial);
  await del('calcs');
}

export const lastFour = (serial) => (serial ? String(serial).slice(-4) : '');

/** Download a script to the phone/computer as a normal file. */
export function exportFile(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/x-python' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
