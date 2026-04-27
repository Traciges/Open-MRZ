// Pure morphological operations on flat Uint8Array (row-major, single channel).
// All kernels are horizontal rectangles: height=1, width=kernelW.

function erodeRow(
  src: Uint8Array, dst: Uint8Array, w: number, h: number, kernelW: number
): void {
  const half = Math.floor(kernelW / 2);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let min = 255;
      const xStart = Math.max(0, x - half);
      const xEnd = Math.min(w - 1, x + half);
      for (let kx = xStart; kx <= xEnd; kx++) {
        const v = src[row + kx];
        if (v !== undefined && v < min) min = v;
      }
      dst[row + x] = min;
    }
  }
}

function dilateRow(
  src: Uint8Array, dst: Uint8Array, w: number, h: number, kernelW: number
): void {
  const half = Math.floor(kernelW / 2);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let max = 0;
      const xStart = Math.max(0, x - half);
      const xEnd = Math.min(w - 1, x + half);
      for (let kx = xStart; kx <= xEnd; kx++) {
        const v = src[row + kx];
        if (v !== undefined && v > max) max = v;
      }
      dst[row + x] = max;
    }
  }
}

export function erode(src: Uint8Array, w: number, h: number, kernelW: number): Uint8Array {
  const dst = new Uint8Array(src.length);
  erodeRow(src, dst, w, h, kernelW);
  return dst;
}

export function dilate(src: Uint8Array, w: number, h: number, kernelW: number): Uint8Array {
  const dst = new Uint8Array(src.length);
  dilateRow(src, dst, w, h, kernelW);
  return dst;
}

// Morphological close = dilate then erode
export function close(src: Uint8Array, w: number, h: number, kernelW: number): Uint8Array {
  const dilated = dilate(src, w, h, kernelW);
  return erode(dilated, w, h, kernelW);
}

// Bottom-hat = close(src) - src  (enhances dark valleys / fine bright structures below baseline)
// For MRZ: enhances horizontal text-like structures
export function bottomHat(src: Uint8Array, w: number, h: number, kernelW: number): Uint8Array {
  const closed = close(src, w, h, kernelW);
  const dst = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const diff = (closed[i] ?? 0) - (src[i] ?? 0);
    dst[i] = diff < 0 ? 0 : diff;
  }
  return dst;
}
