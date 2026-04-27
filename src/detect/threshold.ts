// Otsu binarisation on a grayscale Uint8Array.

export function otsuThreshold(src: Uint8Array): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    hist[v] = (hist[v] ?? 0) + 1;
  }

  const total = src.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * (hist[i] ?? 0);

  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let maxVar = 0;
  let threshold = 0;

  for (let t = 0; t < 256; t++) {
    wB += hist[t] ?? 0;
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += t * (hist[t] ?? 0);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const diff = mB - mF;
    const varBetween = wB * wF * diff * diff;
    if (varBetween > maxVar) {
      maxVar = varBetween;
      threshold = t;
    }
  }
  return threshold;
}

export function binarize(src: Uint8Array, threshold: number): Uint8Array {
  const dst = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    dst[i] = (src[i] ?? 0) > threshold ? 255 : 0;
  }
  return dst;
}

export function otsuBinarize(src: Uint8Array): { binary: Uint8Array; threshold: number } {
  const threshold = otsuThreshold(src);
  return { binary: binarize(src, threshold), threshold };
}
