// Scharr filter, x-direction only.
// Kernel: [[-3,0,3],[-10,0,10],[-3,0,3]]
// Input/output: Uint8Array grayscale, row-major.

export function scharrX(src: Uint8Array, w: number, h: number): Uint8Array {
  const dst = new Uint8Array(src.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl = src[(y - 1) * w + (x - 1)] ?? 0;
      const ml = src[y * w + (x - 1)] ?? 0;
      const bl = src[(y + 1) * w + (x - 1)] ?? 0;
      const tr = src[(y - 1) * w + (x + 1)] ?? 0;
      const mr = src[y * w + (x + 1)] ?? 0;
      const br = src[(y + 1) * w + (x + 1)] ?? 0;
      const gx = -3 * tl - 10 * ml - 3 * bl + 3 * tr + 10 * mr + 3 * br;
      const abs = gx < 0 ? -gx : gx;
      // Normalize: max theoretical value = 32*255 = 8160; scale to 0-255
      dst[y * w + x] = abs > 8160 ? 255 : (abs * 255 / 8160) | 0;
    }
  }
  return dst;
}
