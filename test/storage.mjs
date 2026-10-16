import assert from 'node:assert/strict';
import {
  isValidRecordName,
  parseStorageRecords,
  encodeStorageRecords,
  areRecordsDifferent,
  mergeRecords,
  readStorageRecords,
  writeStorageRecords,
} from '../js/usb/storage.js';
import { makeMock } from './mock-device.mjs';
import { Calculator } from '../js/usb/calculator.js';

// 1. isValidRecordName
assert.equal(isValidRecordName('numplay_saves.py'), true);
assert.equal(isValidRecordName('code.py'), true);
assert.equal(isValidRecordName('balatro_save.py'), true);
assert.equal(isValidRecordName('invalid_name_no_dot'), false);
assert.equal(isValidRecordName('.hidden'), false);
assert.equal(isValidRecordName(null), false);
console.log('✓ isValidRecordName tests passed');

// 2. encode & parse roundtrip
const testRecords = [
  { name: 'numplay_saves.py', value: new TextEncoder().encode('SCORE=999\nLEVEL=5') },
  { name: 'code.py', value: new TextEncoder().encode('print("Hello World")') },
];
const encoded = encodeStorageRecords(testRecords, 4096);
const parsed = parseStorageRecords(encoded);

assert.equal(parsed.length, 2);
assert.equal(parsed[0].name, 'numplay_saves.py');
assert.equal(new TextDecoder().decode(parsed[0].value), 'SCORE=999\nLEVEL=5');
assert.equal(parsed[1].name, 'code.py');
assert.equal(new TextDecoder().decode(parsed[1].value), 'print("Hello World")');
console.log('✓ encode/parse roundtrip passed');

// 3. areRecordsDifferent & mergeRecords
const setA = [
  { name: 'numplay_saves.py', value: new Uint8Array([1, 2, 3]) },
  { name: 'code.py', value: new Uint8Array([4, 5]) },
];
const setB = [
  { name: 'numplay_saves.py', value: new Uint8Array([1, 2, 3]) },
];
const setC = [
  { name: 'numplay_saves.py', value: new Uint8Array([1, 2, 99]) },
];

assert.equal(areRecordsDifferent(setA, setA), false);
assert.equal(areRecordsDifferent(setA, setB), true); // code.py missing in setB
assert.equal(areRecordsDifferent(setA, setC), true); // content byte diff

const merged = mergeRecords(setB, setA);
assert.equal(merged.length, 2);
console.log('✓ diff & merge tests passed');

// 4. readStorageRecords & writeStorageRecords on Mock Device
const m = makeMock();
const calc = new Calculator(m.device);
await calc.process((c) => c.extractInfos());

// Write initial records to mock calculator storage
await writeStorageRecords(calc, testRecords);

// Read back records
const read = await readStorageRecords(calc);
assert.equal(read.length, 2);
assert.equal(read[0].name, 'numplay_saves.py');
assert.equal(new TextDecoder().decode(read[0].value), 'SCORE=999\nLEVEL=5');
console.log('✓ writeStorageRecords & readStorageRecords on mock device passed');

// 5. Simulate flash clearing storage and restoring saves
// Simulate memory cleared by filling storage area in mock device with 0xFF
const storageOffset = 0x90100000 - 0x90000000;
m.mem.external.data.fill(0xff, storageOffset, storageOffset + 0x100000);

// Verify storage is now empty
const clearedRead = await readStorageRecords(calc);
assert.equal(clearedRead.length, 0);
assert.equal(areRecordsDifferent(testRecords, clearedRead), true);

// Restore saves by merging and writing back
const mergedRestored = mergeRecords(clearedRead, testRecords);
await writeStorageRecords(calc, mergedRestored);

// Read back after restore
const restoredRead = await readStorageRecords(calc);
assert.equal(restoredRead.length, 2);
assert.equal(restoredRead[0].name, 'numplay_saves.py');
assert.equal(new TextDecoder().decode(restoredRead[0].value), 'SCORE=999\nLEVEL=5');
console.log('✓ full save backup, clear, and restoration flow verified on mock device!');
