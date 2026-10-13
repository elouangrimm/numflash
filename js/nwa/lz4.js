// Minimal LZ4 *block* decompressor (used for the app icon inside .nwa files).
export function lz4DecompressBlock(src, dstSize) {
  const dst = new Uint8Array(dstSize);
  let sp = 0, dp = 0;
  while (sp < src.length) {
    const token = src[sp++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[sp++]; lit += b; } while (b === 255); }
    if (dp + lit > dstSize) throw new Error('LZ4: output overflow');
    for (let i = 0; i < lit; i++) dst[dp++] = src[sp++];
    if (sp >= src.length) break;                       // last sequence has no match
    const offset = src[sp] | (src[sp + 1] << 8); sp += 2;
    if (offset === 0 || offset > dp) throw new Error('LZ4: bad offset');
    let len = token & 15;
    if (len === 15) { let b; do { b = src[sp++]; len += b; } while (b === 255); }
    len += 4;
    if (dp + len > dstSize) throw new Error('LZ4: output overflow');
    for (let i = 0; i < len; i++, dp++) dst[dp] = dst[dp - offset];
  }
  return dst.subarray(0, dp);
}

export const ICON_WIDTH = 55;
export const ICON_HEIGHT = 56;

/** .nwi (LZ4 of RGB565 little-endian) -> RGBA8888 bytes */
export function nwiToRgba(nwi) {
  const raw = lz4DecompressBlock(nwi, ICON_WIDTH * ICON_HEIGHT * 2);
  const px = raw.length >> 1;
  const rgba = new Uint8ClampedArray(px * 4);
  const scale = (v, bits) => Math.round(255 / ((1 << bits) - 1) * v);
  for (let i = 0; i < px; i++) {
    const c = (raw[2 * i + 1] << 8) | raw[2 * i];
    rgba[4 * i] = scale((c >> 11) & 31, 5);
    rgba[4 * i + 1] = scale((c >> 5) & 63, 6);
    rgba[4 * i + 2] = scale(c & 31, 5);
    rgba[4 * i + 3] = 255;
  }
  return rgba;
}

export function rgbaToDataUrl(rgba) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = ICON_WIDTH; canvas.height = ICON_HEIGHT;
  canvas.getContext('2d').putImageData(new ImageData(rgba, ICON_WIDTH, ICON_HEIGHT), 0, 0);
  return canvas.toDataURL();
}
