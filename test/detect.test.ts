import { describe, it, expect } from 'vitest';
import { erode, dilate, close, bottomHat } from '../src/detect/morphology.js';
import { scharrX } from '../src/detect/edges.js';
import { otsuThreshold, otsuBinarize } from '../src/detect/threshold.js';
import { labelComponents } from '../src/detect/components.js';
import { MRZDetector } from '../src/detect/MRZDetector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGray(w: number, h: number, fill: number): Uint8Array {
  return new Uint8Array(w * h).fill(fill);
}

function makeImageData(w: number, h: number, fillGray = 200): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fillGray;
    data[i * 4 + 1] = fillGray;
    data[i * 4 + 2] = fillGray;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h, colorSpace: 'srgb' } as ImageData;
}

function drawRect(
  img: ImageData, x: number, y: number, bw: number, bh: number, value = 0
): void {
  for (let row = y; row < y + bh && row < img.height; row++) {
    for (let col = x; col < x + bw && col < img.width; col++) {
      const idx = (row * img.width + col) * 4;
      img.data[idx] = value;
      img.data[idx + 1] = value;
      img.data[idx + 2] = value;
      img.data[idx + 3] = 255;
    }
  }
}

/**
 * Draw a row of character-like black rectangles (simulates an MRZ text line).
 * charW/charH: single character size; gap: spacing between characters.
 */
function drawCharRow(
  img: ImageData, startX: number, startY: number,
  count: number, charW: number, charH: number, gap: number
): void {
  for (let i = 0; i < count; i++) {
    drawRect(img, startX + i * (charW + gap), startY, charW, charH);
  }
}

// ---------------------------------------------------------------------------
// morphology.ts
// ---------------------------------------------------------------------------

describe('erode', () => {
  it('preserves uniform image', () => {
    const img = makeGray(10, 1, 128);
    const out = erode(img, 10, 1, 3);
    expect(out[5]).toBe(128);
  });

  it('shrinks a single bright spike', () => {
    // Single white pixel surrounded by black — after erode(kernelW=3) should disappear
    const img = makeGray(10, 1, 0);
    img[5] = 255;
    const out = erode(img, 10, 1, 3);
    // The spike's neighbours are 0, so min in the 3-window around idx 5 = 0
    expect(out[5]).toBe(0);
  });

  it('preserves wide bright region', () => {
    const img = makeGray(20, 1, 0);
    for (let i = 5; i < 15; i++) img[i] = 200;
    const out = erode(img, 20, 1, 3);
    // Interior pixels (not within half-kernel of the edge) should survive
    expect(out[10]).toBe(200);
  });
});

describe('dilate', () => {
  it('expands a single dark spike into white neighbourhood', () => {
    const img = makeGray(10, 1, 0);
    img[5] = 255;
    const out = dilate(img, 10, 1, 3);
    // Pixels at 4, 5, 6 should now be 255
    expect(out[4]).toBe(255);
    expect(out[5]).toBe(255);
    expect(out[6]).toBe(255);
    // Pixel at 3 should remain 0
    expect(out[3]).toBe(0);
  });
});

describe('close', () => {
  it('fills a small gap between two bright regions', () => {
    const img = makeGray(20, 1, 0);
    // Two bright regions with a 1-pixel gap at index 10
    for (let i = 5; i < 10; i++) img[i] = 255;
    for (let i = 11; i < 16; i++) img[i] = 255;
    const out = close(img, 20, 1, 5);
    // The gap at 10 should be filled by close
    expect(out[10]).toBe(255);
  });
});

describe('bottomHat', () => {
  it('returns zero for uniform image', () => {
    const img = makeGray(20, 1, 128);
    const out = bottomHat(img, 20, 1, 5);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('highlights a dark valley in bright surroundings', () => {
    // Bright background with a narrow dark dip
    const img = makeGray(30, 1, 200);
    img[15] = 50; // dark valley
    const out = bottomHat(img, 30, 1, 7);
    // Close will lift the valley to ~200; bottomHat = 200 - 50 = 150
    expect(out[15]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// edges.ts
// ---------------------------------------------------------------------------

describe('scharrX', () => {
  it('returns zero for uniform image', () => {
    const img = makeGray(10, 10, 128);
    const out = scharrX(img, 10, 10);
    // Interior pixels should be 0 (no x-gradient)
    expect(out[5 * 10 + 5]).toBe(0);
  });

  it('detects a vertical edge', () => {
    const img = makeGray(10, 10, 0);
    // Right half is bright
    for (let y = 0; y < 10; y++)
      for (let x = 5; x < 10; x++)
        img[y * 10 + x] = 255;
    const out = scharrX(img, 10, 10);
    // The edge column (x=4→5) should have a high response
    expect(out[5 * 10 + 4]).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// threshold.ts
// ---------------------------------------------------------------------------

describe('otsuThreshold', () => {
  it('finds threshold between two clusters', () => {
    const img = new Uint8Array(200);
    img.fill(50, 0, 100);   // dark cluster
    img.fill(200, 100, 200); // bright cluster
    const t = otsuThreshold(img);
    // Otsu picks the dark-cluster boundary value (50) or above, never reaching bright cluster
    expect(t).toBeGreaterThanOrEqual(50);
    expect(t).toBeLessThan(200);
  });
});

describe('otsuBinarize', () => {
  it('dark pixels become 0, bright pixels become 255', () => {
    const img = new Uint8Array(10);
    img.fill(10, 0, 5);
    img.fill(245, 5, 10);
    const { binary } = otsuBinarize(img);
    expect(binary[0]).toBe(0);
    expect(binary[9]).toBe(255);
  });
});

// ---------------------------------------------------------------------------
// components.ts
// ---------------------------------------------------------------------------

describe('labelComponents', () => {
  it('labels two separate horizontal runs', () => {
    const w = 20, h = 5;
    const binary = new Uint8Array(w * h);
    // First run: row 1, cols 2-8
    for (let x = 2; x <= 8; x++) binary[1 * w + x] = 255;
    // Second run: row 3, cols 12-18
    for (let x = 12; x <= 18; x++) binary[3 * w + x] = 255;

    const blobs = labelComponents(binary, w, h);
    expect(blobs.length).toBe(2);
  });

  it('treats connected pixels as one blob', () => {
    const w = 10, h = 3;
    const binary = new Uint8Array(w * h);
    // L-shape: row 0 cols 0-5, row 1 col 5
    for (let x = 0; x <= 5; x++) binary[0 * w + x] = 255;
    binary[1 * w + 5] = 255;
    const blobs = labelComponents(binary, w, h);
    expect(blobs.length).toBe(1);
  });

  it('reports correct pixel count', () => {
    const w = 10, h = 1;
    const binary = new Uint8Array(w * h);
    for (let x = 0; x < 10; x++) binary[x] = 255;
    const blobs = labelComponents(binary, w, h);
    expect(blobs.length).toBe(1);
    expect(blobs[0]!.pixelCount).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// MRZDetector — synthetic image with two horizontal text-like bars
// ---------------------------------------------------------------------------

describe('MRZDetector', () => {
  it('returns null for a blank image', () => {
    const img = makeImageData(640, 480, 200);
    const detector = new MRZDetector();
    const result = detector.detect(img);
    expect(result).toBeNull();
  });

  it('detects two rows of character-like blobs simulating MRZ lines', () => {
    // 800×300 white image — wider than TARGET_WIDTH so rescaling happens
    const w = 800, h = 300;
    const img = makeImageData(w, h, 240);

    // Draw two rows of 44 character-like rectangles (each 5×10 px, 2px gap)
    // TD3-like: 44 chars per line, y=110 and y=130
    drawCharRow(img, 80, 110, 44, 5, 10, 2);
    drawCharRow(img, 80, 130, 44, 5, 10, 2);

    const detector = new MRZDetector();
    const result = detector.detect(img);

    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.crop.width).toBeGreaterThan(0);
      expect(result.crop.height).toBeGreaterThan(0);
      for (const corner of result.corners) {
        expect(corner.x).toBeGreaterThanOrEqual(0);
        expect(corner.y).toBeGreaterThanOrEqual(0);
        expect(corner.x).toBeLessThanOrEqual(w);
        expect(corner.y).toBeLessThanOrEqual(h);
      }
      expect(result.confidence).toBeGreaterThan(0);
    }
  });
});
