// Constructs an ImageData-compatible object that works in both browser and Node.js.
export function mkImageData(data: Uint8ClampedArray, w: number, h: number): ImageData {
  if (typeof ImageData !== 'undefined') {
    return new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h);
  }
  return { data, width: w, height: h, colorSpace: 'srgb' } as ImageData;
}
