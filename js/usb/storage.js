// NumWorks Epsilon storage (Python scripts, saves, ...): read, parse, encode, write.
//
// Layout in the calculator's RAM, as used by NumWorks' own tools (nwlink, numworks.js):
//
//   storageAddress ........ 0xBA 0xDD 0x0B 0xEE   (start tag)
//   storageAddress + 4 .... record, record, ... , 0x00 0x00, zero padding (storageSize bytes)
//   storageAddress + 4 + storageSize ... 0xBA 0xDD 0x0B 0xEE   (end tag)
//
// NumWorks reads (storageAddress, storageSize + 8) with the RAM alternate setting (alt 1)
// and writes the record area back at storageAddress + 4. A record is:
//
//   uint16 LE  TOTAL record size (these two bytes + name + 0 + value)
//   name       null-terminated, includes the extension ("numplay.py")
//   value      raw bytes
//
// Reading it with the flash alternate setting (alt 0) never works: the calculator answers
// with empty data, which used to make the install hang on "Backing up saves".

const TAG = Uint8Array.of(0xBA, 0xDD, 0x0B, 0xEE);
const same = (a, off, b) => { for (let i = 0; i < b.length; i++) if (a[off + i] !== b[i]) return false; return true; };

/** Parse the record area (between the two tags). Throws if it is not well formed. */
export function parseStorageRecords(area) {
  const records = [];
  const dec = new TextDecoder('utf-8');
  let off = 0;
  while (off + 2 <= area.length) {
    const size = area[off] | (area[off + 1] << 8);
    if (size === 0) return records;                        // end marker
    if (size < 4 || off + size > area.length) throw new Error('storage record at ' + off + ' has a bad size (' + size + ')');
    const rec = area.subarray(off + 2, off + size);
    const z = rec.indexOf(0);
    if (z <= 0) throw new Error('storage record at ' + off + ' has no name');
    records.push({ name: dec.decode(rec.subarray(0, z)), value: rec.slice(z + 1) });
    off += size;
  }
  return records;
}

/** Encode records into a record area of exactly `size` bytes (zero padded). */
export function encodeStorageRecords(records, size) {
  const out = new Uint8Array(size);
  const enc = new TextEncoder();
  let off = 0;
  for (const r of records) {
    const name = enc.encode(r.name);
    const value = r.value instanceof Uint8Array ? r.value : enc.encode(String(r.value ?? ''));
    const total = 2 + name.length + 1 + value.length;
    if (total > 0xffff || off + total + 2 > size) throw new Error('Not enough room in the calculator storage for ' + r.name);
    out[off] = total & 0xff; out[off + 1] = total >> 8;
    out.set(name, off + 2);
    out.set(value, off + 2 + name.length + 1);
    off += total;
  }
  return out;
}

/** True if any backed-up record is missing from `current` or has different bytes. */
export function areRecordsDifferent(backedUp, current) {
  if (!backedUp || backedUp.length === 0) return false;
  const cur = new Map((current || []).map((r) => [r.name, r.value]));
  for (const b of backedUp) {
    const v = cur.get(b.name);
    if (!v || v.length !== b.value.length) return true;
    for (let i = 0; i < v.length; i++) if (v[i] !== b.value[i]) return true;
  }
  return false;
}

/** Current records plus the backed-up ones (the backup wins for the same name). */
export function mergeRecords(current, backedUp) {
  const map = new Map();
  for (const r of current || []) map.set(r.name, r);
  for (const b of backedUp || []) map.set(b.name, b);
  return [...map.values()];
}

function storageRegion(calc) {
  const fw = calc && calc.infos && calc.infos.firmware;
  if (!fw) throw new Error('Calculator info not loaded');
  const address = fw.storageAddress, size = fw.storageSize;
  if (typeof address !== 'number' || typeof size !== 'number' || !(size > 0)) throw new Error('This calculator did not report where its storage is');
  const m = calc.infos.model;
  // Storage lives in RAM; refuse anything else rather than touching flash by mistake.
  if (!(m.RAMAddressStart >= 0 && address >= m.RAMAddressStart && address + size + 2 * TAG.length <= m.RAMAddressEnd))
    throw new Error('Storage address 0x' + address.toString(16) + ' is outside the calculator RAM');
  return { address, size };
}

/** Read all storage records from the calculator (opens/closes the USB device itself). */
export async function readStorageRecords(calc, onProgress) {
  const { address, size } = storageRegion(calc);
  const raw = await calc.process((c) => c.dfu.upload(address, size + 2 * TAG.length, onProgress, 1));
  if (!same(raw, 0, TAG) || !same(raw, raw.length - TAG.length, TAG))
    throw new Error('Calculator memory does not look like storage (tags not found)');
  return parseStorageRecords(raw.subarray(TAG.length, TAG.length + size));
}

/** Write records back to the calculator's RAM storage. */
export async function writeStorageRecords(calc, records) {
  const { address, size } = storageRegion(calc);
  const area = encodeStorageRecords(records, size);
  // Same as NumWorks: the data goes to address + tag length, RAM alternate setting.
  await calc.process((c) => c.dfu.download(address + TAG.length, area, undefined, 1));
}
