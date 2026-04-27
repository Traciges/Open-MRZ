import type { MRZFormat } from '../types.js';

export interface FormatSpec {
  lines: number;
  charsPerLine: number;
}

export const FORMAT_SPECS: Record<MRZFormat, FormatSpec> = {
  TD1: { lines: 3, charsPerLine: 30 },
  TD2: { lines: 2, charsPerLine: 36 },
  TD3: { lines: 2, charsPerLine: 44 },
  'MRV-A': { lines: 2, charsPerLine: 44 },
  'MRV-B': { lines: 2, charsPerLine: 36 },
};

const LINE_HEIGHT_PX = 40;
const CHAR_SIZE = 20;

function bilinearSample(
  data: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  x: number,
  y: number,
  channel: number,
): number {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(srcW - 1, x0 + 1);
  const y1 = Math.min(srcH - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = data[(y0 * srcW + x0) * 4 + channel] ?? 0;
  const v10 = data[(y0 * srcW + x1) * 4 + channel] ?? 0;
  const v01 = data[(y1 * srcW + x0) * 4 + channel] ?? 0;
  const v11 = data[(y1 * srcW + x1) * 4 + channel] ?? 0;
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
    v01 * (1 - fx) * fy + v11 * fx * fy;
}

/**
 * Extract character patches from an MRZ crop image.
 *
 * Returns a Float32Array of shape [N, 1, 20, 20] where N = lines × charsPerLine.
 * Pixel values are normalized to [0, 1] (grayscale).
 */
export function extractCharPatches(crop: ImageData, format: MRZFormat): Float32Array {
  const spec = FORMAT_SPECS[format];
  const { lines, charsPerLine } = spec;

  // Target height: 40 px per line
  const stdHeight = lines * LINE_HEIGHT_PX;
  // Preserve aspect ratio
  const stdWidth = Math.max(1, Math.round((crop.width / crop.height) * stdHeight));

  // Scale factors to map standardised coords back to original image
  const scaleX = crop.width / stdWidth;
  const scaleY = crop.height / stdHeight;

  const totalChars = lines * charsPerLine;
  // Shape [N, 1, 20, 20] flattened — 1 channel implicit; caller sets tensor dims
  const patches = new Float32Array(totalChars * CHAR_SIZE * CHAR_SIZE);

  const cellW = stdWidth / charsPerLine;

  for (let line = 0; line < lines; line++) {
    for (let col = 0; col < charsPerLine; col++) {
      const charIdx = line * charsPerLine + col;
      const patchOffset = charIdx * CHAR_SIZE * CHAR_SIZE;

      // Centre of this character's cell in standardised coordinates
      const cellCenterX = (col + 0.5) * cellW;
      const cellCenterY = line * LINE_HEIGHT_PX + LINE_HEIGHT_PX / 2;
      const patchStartX = cellCenterX - CHAR_SIZE / 2;
      const patchStartY = cellCenterY - CHAR_SIZE / 2;

      for (let py = 0; py < CHAR_SIZE; py++) {
        for (let px = 0; px < CHAR_SIZE; px++) {
          // Map 20×20 patch pixel back to original image coordinates
          const srcX = (patchStartX + px) * scaleX;
          const srcY = (patchStartY + py) * scaleY;

          const r = bilinearSample(crop.data, crop.width, crop.height, srcX, srcY, 0);
          const g = bilinearSample(crop.data, crop.width, crop.height, srcX, srcY, 1);
          const b = bilinearSample(crop.data, crop.width, crop.height, srcX, srcY, 2);
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;

          patches[patchOffset + py * CHAR_SIZE + px] = gray / 255;
        }
      }
    }
  }

  return patches;
}
