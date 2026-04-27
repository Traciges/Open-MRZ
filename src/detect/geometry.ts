import type { Point } from '../types.js';
import type { Blob } from './components.js';
import { mkImageData } from './imageDataUtil.js';

export interface RotatedRect {
  cx: number; cy: number;
  width: number; height: number;
  angleDeg: number;
}

// PCA on a blob's pixel set to derive orientation angle.
export function computeRotationAngle(blob: Blob, imageW: number): number {
  const n = blob.pixels.length;
  if (n < 2) return 0;

  let sumX = 0, sumY = 0;
  for (const idx of blob.pixels) {
    sumX += idx % imageW;
    sumY += Math.floor(idx / imageW);
  }
  const cx = sumX / n;
  const cy = sumY / n;

  let xx = 0, xy = 0, yy = 0;
  for (const idx of blob.pixels) {
    const dx = (idx % imageW) - cx;
    const dy = Math.floor(idx / imageW) - cy;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }

  // Angle of first principal component
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  return angle * (180 / Math.PI);
}

export function computeBoundingBox(
  blob: Blob,
  imageW: number
): { corners: [Point, Point, Point, Point]; cx: number; cy: number } {
  const bb = blob.boundingBox;
  const x1 = bb.x, y1 = bb.y;
  const x2 = bb.x + bb.w, y2 = bb.y + bb.h;
  return {
    corners: [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
      { x: x1, y: y2 },
    ],
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
  };
}

// Rotate a point around a center by -angleDeg (deskew).
function rotatePoint(p: Point, cx: number, cy: number, angleDeg: number): Point {
  const rad = -angleDeg * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - cx;
  const dy = p.y - cy;
  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}

/**
 * Given the union bounding box of all MRZ blobs (in the scaled-down frame),
 * scale back up to the original frame and return corners + crop ImageData.
 */
export function scaledCornersToOriginal(
  corners: [Point, Point, Point, Point],
  scaleX: number,
  scaleY: number
): [Point, Point, Point, Point] {
  return corners.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })) as [
    Point, Point, Point, Point
  ];
}

/**
 * Crop and deskew a region from a full-resolution RGBA ImageData.
 * `corners` are in the original image's pixel coordinates.
 * `angleDeg` is the CCW rotation of the document.
 */
export function rotateAndCrop(
  src: ImageData,
  corners: [Point, Point, Point, Point],
  angleDeg: number
): ImageData {
  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;

  // Deskew corners
  const rotated = corners.map((p) => rotatePoint(p, cx, cy, angleDeg)) as [
    Point, Point, Point, Point
  ];

  const xs = rotated.map((p) => p.x);
  const ys = rotated.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(src.width, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(src.height, Math.ceil(Math.max(...ys)));
  const cropW = Math.max(1, x1 - x0);
  const cropH = Math.max(1, y1 - y0);

  if (angleDeg === 0) {
    // Fast path: direct slice
    const out = new Uint8ClampedArray(cropW * cropH * 4);
    for (let row = 0; row < cropH; row++) {
      for (let col = 0; col < cropW; col++) {
        const si = ((y0 + row) * src.width + (x0 + col)) * 4;
        const di = (row * cropW + col) * 4;
        out[di] = src.data[si] ?? 0;
        out[di + 1] = src.data[si + 1] ?? 0;
        out[di + 2] = src.data[si + 2] ?? 0;
        out[di + 3] = src.data[si + 3] ?? 255;
      }
    }
    return mkImageData(out, cropW, cropH);
  }

  // Rotate src pixels into crop canvas
  const rad = angleDeg * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const out = new Uint8ClampedArray(cropW * cropH * 4);

  for (let row = 0; row < cropH; row++) {
    for (let col = 0; col < cropW; col++) {
      // Map destination pixel back to source (inverse rotation)
      const px = x0 + col - cx;
      const py = y0 + row - cy;
      const sx = Math.round(cx + px * cos - py * sin);
      const sy = Math.round(cy + px * sin + py * cos);
      if (sx < 0 || sx >= src.width || sy < 0 || sy >= src.height) continue;
      const si = (sy * src.width + sx) * 4;
      const di = (row * cropW + col) * 4;
      out[di] = src.data[si] ?? 0;
      out[di + 1] = src.data[si + 1] ?? 0;
      out[di + 2] = src.data[si + 2] ?? 0;
      out[di + 3] = src.data[si + 3] ?? 255;
    }
  }
  return mkImageData(out, cropW, cropH);
}
