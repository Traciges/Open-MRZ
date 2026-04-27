import type { DetectionResult, Point } from '../types.js';
import { mkImageData } from './imageDataUtil.js';
import { bottomHat, close, dilate, erode } from './morphology.js';
import { scharrX } from './edges.js';
import { otsuBinarize } from './threshold.js';
import { labelComponents } from './components.js';
import type { Blob } from './components.js';
import { computeRotationAngle, scaledCornersToOriginal, rotateAndCrop } from './geometry.js';

const TARGET_WIDTH = 640;
const MIN_AREA = 500;
const MIN_ASPECT = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toGrayscale(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    gray[i] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
  }
  return gray;
}

function gaussianBlur3x3(src: Uint8Array, w: number, h: number): Uint8Array {
  // kernel: [1,2,1; 2,4,2; 1,2,1] / 16
  const dst = new Uint8Array(src.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v =
        (src[(y - 1) * w + (x - 1)] ?? 0) +
        2 * (src[(y - 1) * w + x] ?? 0) +
        (src[(y - 1) * w + (x + 1)] ?? 0) +
        2 * (src[y * w + (x - 1)] ?? 0) +
        4 * (src[y * w + x] ?? 0) +
        2 * (src[y * w + (x + 1)] ?? 0) +
        (src[(y + 1) * w + (x - 1)] ?? 0) +
        2 * (src[(y + 1) * w + x] ?? 0) +
        (src[(y + 1) * w + (x + 1)] ?? 0);
      dst[y * w + x] = (v / 16) | 0;
    }
  }
  return dst;
}

/** Bilinear resize of a grayscale Uint8Array to newW×newH. */
function resizeGray(
  src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number
): Uint8Array {
  const dst = new Uint8Array(dstW * dstH);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = (x + 0.5) * scaleX - 0.5;
      const sy = (y + 0.5) * scaleY - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const y1 = Math.min(srcH - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const v =
        (src[y0 * srcW + x0] ?? 0) * (1 - fx) * (1 - fy) +
        (src[y0 * srcW + x1] ?? 0) * fx * (1 - fy) +
        (src[y1 * srcW + x0] ?? 0) * (1 - fx) * fy +
        (src[y1 * srcW + x1] ?? 0) * fx * fy;
      dst[y * dstW + x] = v | 0;
    }
  }
  return dst;
}

/** Rotate a full RGBA ImageData by 90° CW increments (k=1,2,3). */
function rotateRGBA90(src: ImageData, k: number): ImageData {
  let { data, width: w, height: h } = src;
  let result = src;
  for (let step = 0; step < k; step++) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4;
        // 90° CW: new(x', y') = (h-1-y, x) in new dimensions (h, w)
        const nx = h - 1 - y;
        const ny = x;
        const di = (ny * h + nx) * 4;
        out[di] = data[si] ?? 0;
        out[di + 1] = data[si + 1] ?? 0;
        out[di + 2] = data[si + 2] ?? 0;
        out[di + 3] = data[si + 3] ?? 255;
      }
    }
    const newW = h;
    const newH = w;
    result = mkImageData(out, newW, newH);
    data = out;
    w = newW;
    h = newH;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core pipeline (runs on a possibly rotated frame)
// ---------------------------------------------------------------------------

interface PipelineResult {
  blobs: Blob[];
  scaledW: number;
  scaledH: number;
  scaleX: number;
  scaleY: number;
}

function runPipeline(frame: ImageData): PipelineResult | null {
  const origW = frame.width;
  const origH = frame.height;

  // Step 1: resize to 640px wide
  const scaleX = origW / TARGET_WIDTH;
  const scaleY = origH / Math.round((origH * TARGET_WIDTH) / origW);
  const scaledW = TARGET_WIDTH;
  const scaledH = Math.round((origH * TARGET_WIDTH) / origW);

  const grayFull = toGrayscale(frame.data, origW, origH);
  const gray = resizeGray(grayFull, origW, origH, scaledW, scaledH);

  // Step 3: Gaussian blur
  const blurred = gaussianBlur3x3(gray, scaledW, scaledH);

  // Step 4: bottom-hat with horizontal 1×15 SE
  const bh = bottomHat(blurred, scaledW, scaledH, 15);

  // Step 5: Scharr x-edge
  const edges = scharrX(bh, scaledW, scaledH);

  // Step 6: Otsu threshold
  const { binary } = otsuBinarize(edges);

  // Step 7: morphological close (1×30), erode, dilate
  const closed = close(binary, scaledW, scaledH, 30);
  const eroded = erode(closed, scaledW, scaledH, 3);
  const processed = dilate(eroded, scaledW, scaledH, 3);

  // Step 8: connected components
  const allBlobs = labelComponents(processed, scaledW, scaledH);

  // Step 9: filter blobs
  const blobs = allBlobs.filter((b) => {
    const { w, h } = b.boundingBox;
    const aspect = w / Math.max(h, 1);
    return aspect > MIN_ASPECT && b.pixelCount > MIN_AREA;
  });

  if (blobs.length < 1) return null;

  return { blobs, scaledW, scaledH, scaleX, scaleY };
}

// ---------------------------------------------------------------------------
// Detector class
// ---------------------------------------------------------------------------

export class MRZDetector {
  detect(frame: ImageData): DetectionResult | null {
    for (let rot = 0; rot < 4; rot++) {
      const rotated = rot === 0 ? frame : rotateRGBA90(frame, rot);
      const result = this.tryDetect(rotated, rot);
      if (result !== null) return result;
    }
    return null;
  }

  private tryDetect(frame: ImageData, rotation: number): DetectionResult | null {
    const pipeline = runPipeline(frame);
    if (pipeline === null) return null;

    const { blobs, scaleX, scaleY } = pipeline;

    // Sort blobs by y-center for grouping into lines
    const sorted = blobs.slice().sort(
      (a, b) =>
        (a.boundingBox.y + a.boundingBox.h / 2) -
        (b.boundingBox.y + b.boundingBox.h / 2)
    );

    // Pick up to 3 best blobs (for TD1 we need 3 lines, TD3/TD2 need 2)
    const best = sorted.slice(0, 3);

    // Union bounding box of selected blobs (in scaled coords)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of best) {
      const { x, y, w, h } = b.boundingBox;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }

    // Add padding
    const padX = (maxX - minX) * 0.05;
    const padY = (maxY - minY) * 0.1;
    minX = Math.max(0, minX - padX);
    minY = Math.max(0, minY - padY);
    maxX = Math.min(pipeline.scaledW, maxX + padX);
    maxY = Math.min(pipeline.scaledH, maxY + padY);

    const scaledCorners: [Point, Point, Point, Point] = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];

    // Step 10: compute rotation angle from largest blob
    const largestBlob = best.reduce((a, b) => (a.pixelCount > b.pixelCount ? a : b));
    let angleDeg = computeRotationAngle(largestBlob, pipeline.scaledW);

    // Clamp small angles to zero to avoid unnecessary rotation
    if (Math.abs(angleDeg) < 0.5) angleDeg = 0;

    // Account for the frame rotation we applied
    angleDeg += rotation * 90;

    // Step 11: scale corners back to original frame and crop
    const origCorners = scaledCornersToOriginal(scaledCorners, scaleX, scaleY);
    const crop = rotateAndCrop(frame, origCorners, angleDeg % 360);

    // Confidence: based on aspect ratio of union box relative to typical MRZ
    const unionAspect = (maxX - minX) / Math.max(maxY - minY, 1);
    const confidence = Math.min(1, unionAspect / 10); // ideal MRZ ~10:1 aspect

    return { crop, corners: origCorners, angle: angleDeg, confidence };
  }
}
