// Loads NumWorks' ORIGINAL calculator classes straight out of app-loader.js
// (lines of the webpack bundle) so we can run them against the mock device.
import fs from 'node:fs';
const SRC = process.env.APP_LOADER || '/mnt/user-data/uploads/app-loader.js';
export function loadOfficial() {
  if (!fs.existsSync(SRC)) return null;
  const lines = fs.readFileSync(SRC, 'utf8').split('\n');
  const a = lines.findIndex((l) => l.startsWith('        var iZ = class extends Error'));
  const b = lines.findIndex((l) => l.startsWith('        var aH = r(12104);'));
  if (a < 0 || b < 0) throw new Error('bundle layout changed');
  const code = lines.slice(a, b).join('\n') + '\nreturn { aU, au, ak, aw, i6 };';
  const r = () => ({});            // stand-in for bluebird, only used by reconnect helpers
  return new Function('r', code)(r);
}
