// NumWorks Epsilon Storage utilities: parsing, encoding, reading, and writing records.

/** Check if a string looks like a valid record name (e.g. "numplay_saves.py", "code.py", "data.csv") */
export function isValidRecordName(name) {
  if (!name || typeof name !== 'string' || name.length > 128) return false;
  // Non-control printable characters, must contain a dot extension
  return /^[\w\-. ]+$/i.test(name) && name.includes('.') && !name.startsWith('.') && !name.endsWith('.');
}

/** Parse records from a raw Storage Uint8Array buffer */
export function parseStorageRecords(buffer) {
  const records = [];
  if (!buffer) return records;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength || 0);
  let offset = 0;
  const len = bytes.length;

  while (offset + 2 <= len) {
    const b0 = bytes[offset];
    const b1 = bytes[offset + 1];

    // End of records marker in Flash (0xFFFF) or empty RAM (0x0000)
    if ((b0 === 0x00 && b1 === 0x00) || (b0 === 0xff && b1 === 0xff)) {
      break;
    }

    // Layout 1: uint16_t valueSize LE, followed by null-terminated string fullName, followed by value bytes
    const valueSize = b0 | (b1 << 8);
    let nullIdx = -1;
    const maxSearch = Math.min(len, offset + 2 + 256);
    for (let i = offset + 2; i < maxSearch; i++) {
      if (bytes[i] === 0) {
        nullIdx = i;
        break;
      }
    }

    if (nullIdx !== -1) {
      const nameBytes = bytes.subarray(offset + 2, nullIdx);
      const name = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes);
      const valueStart = nullIdx + 1;
      const valueEnd = valueStart + valueSize;

      if (valueEnd <= len && isValidRecordName(name)) {
        const value = bytes.slice(valueStart, valueEnd);
        records.push({ name, value });
        offset = valueEnd;
        continue;
      }
    }

    // Fallback Layout 2: null-terminated string fullName, followed by uint16_t valueSize LE, followed by value bytes
    let nullIdx2 = -1;
    const maxSearch2 = Math.min(len, offset + 256);
    for (let i = offset; i < maxSearch2; i++) {
      if (bytes[i] === 0) {
        nullIdx2 = i;
        break;
      }
    }

    if (nullIdx2 > offset && nullIdx2 + 2 <= len) {
      const nameBytes = bytes.subarray(offset, nullIdx2);
      const name = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes);
      const valSize = bytes[nullIdx2 + 1] | (bytes[nullIdx2 + 2] << 8);
      const valStart = nullIdx2 + 3;
      const valEnd = valStart + valSize;

      if (valEnd <= len && isValidRecordName(name)) {
        const value = bytes.slice(valStart, valEnd);
        records.push({ name, value });
        offset = valEnd;
        continue;
      }
    }

    offset++;
  }

  return records;
}

/** Encode an array of record objects [{ name, value }] into a Uint8Array of storageSize */
export function encodeStorageRecords(records, storageSize, fillByte = 0x00) {
  const out = new Uint8Array(storageSize).fill(fillByte);
  let offset = 0;
  const encoder = new TextEncoder();

  for (const rec of records) {
    if (!rec || !rec.name) continue;
    const valBytes = typeof rec.value === 'string'
      ? encoder.encode(rec.value)
      : (rec.value ? new Uint8Array(rec.value.buffer || rec.value, rec.value.byteOffset || 0, rec.value.byteLength) : new Uint8Array(0));
    const nameBytes = encoder.encode(rec.name);
    const recLen = 2 + nameBytes.length + 1 + valBytes.length;

    if (offset + recLen > storageSize) {
      console.warn(`Storage limit reached (${storageSize} bytes), skipping record ${rec.name}`);
      break;
    }

    // Write uint16_t valueSize
    out[offset] = valBytes.length & 0xff;
    out[offset + 1] = (valBytes.length >> 8) & 0xff;
    offset += 2;

    // Write name + null terminator
    out.set(nameBytes, offset);
    offset += nameBytes.length;
    out[offset] = 0x00;
    offset += 1;

    // Write value
    out.set(valBytes, offset);
    offset += valBytes.length;
  }

  return out;
}

/** Compare two record sets. Returns true if any backed up record is missing or has different bytes in current. */
export function areRecordsDifferent(backedUp, current) {
  if (!backedUp || backedUp.length === 0) return false;
  const currMap = new Map();
  for (const r of current || []) currMap.set(r.name, r.value);

  for (const b of backedUp) {
    const currVal = currMap.get(b.name);
    if (!currVal) return true; // Missing in current
    if (currVal.length !== b.value.length) return true; // Size difference
    for (let i = 0; i < currVal.length; i++) {
      if (currVal[i] !== b.value[i]) return true; // Byte difference
    }
  }
  return false;
}

/** Merge backedUp records into current records, preferring backedUp for any duplicates */
export function mergeRecords(current, backedUp) {
  const map = new Map();
  for (const r of current || []) map.set(r.name, r);
  for (const b of backedUp || []) map.set(b.name, b);
  return Array.from(map.values());
}

/** Read all storage records from a Calculator instance */
export async function readStorageRecords(calc) {
  if (!calc || !calc.infos || !calc.infos.firmware) return [];
  const fw = calc.infos.firmware;
  const addr = fw.storageAddress;
  const size = fw.storageSize;
  if (!addr || addr === 'unknown' || !size || typeof size !== 'number' || size <= 0) return [];

  const raw = await calc.process(async (c) => {
    return await c.dfu.upload(addr, size);
  });
  return parseStorageRecords(raw);
}

/** Write an array of record objects to a Calculator instance's storage address */
export async function writeStorageRecords(calc, records) {
  if (!calc || !calc.infos || !calc.infos.firmware) throw new Error('Calculator info not loaded');
  const fw = calc.infos.firmware;
  const addr = fw.storageAddress;
  const size = fw.storageSize;
  if (!addr || addr === 'unknown' || !size || typeof size !== 'number' || size <= 0) throw new Error('Storage region unknown');

  const encoded = encodeStorageRecords(records, size);

  await calc.process(async (c) => {
    const isFlash = (addr >= 0x08000000 && addr < 0x08200000) || (addr >= 0x90000000 && addr < 0x98000000);
    if (isFlash) {
      await c.downloadFlash(addr, encoded);
    } else {
      await c.dfu.download(addr, encoded);
    }
  });
}
