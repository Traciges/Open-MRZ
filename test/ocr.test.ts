import { describe, it, expect } from 'vitest';
import { extractCharPatches, FORMAT_SPECS } from '../src/ocr/charCrop.js';
import { postprocessLogits, buildLines, MRZ_ALPHABET } from '../src/ocr/postprocess.js';
import { MockRecognizer } from '../src/ocr/MRZRecognizer.js';
import type { MRZFormat } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// charCrop.ts — extractCharPatches
// ---------------------------------------------------------------------------

describe('extractCharPatches', () => {
  const cases: Array<[MRZFormat, number, number]> = [
    ['TD1', 3, 30],
    ['TD2', 2, 36],
    ['TD3', 2, 44],
    ['MRV-A', 2, 44],
    ['MRV-B', 2, 36],
  ];

  for (const [fmt, lines, charsPerLine] of cases) {
    const totalChars = lines * charsPerLine;

    it(`${fmt}: returns ${totalChars} patches (${lines}×${charsPerLine})`, () => {
      // Realistic crop aspect ratio ~10:1 for MRZ region
      const crop = makeImageData(440, 80);
      const patches = extractCharPatches(crop, fmt);
      // Each patch: 20×20 = 400 floats
      expect(patches.length).toBe(totalChars * 400);
    });

    it(`${fmt}: pixel values are in [0, 1]`, () => {
      const crop = makeImageData(440, 80);
      const patches = extractCharPatches(crop, fmt);
      let allInRange = true;
      for (let i = 0; i < patches.length; i++) {
        const v = patches[i] ?? 0;
        if (v < 0 || v > 1) { allInRange = false; break; }
      }
      expect(allInRange).toBe(true);
    });
  }

  it('uniform white crop → all patches near 1.0', () => {
    const crop = makeImageData(440, 80, 255);
    const patches = extractCharPatches(crop, 'TD3');
    // Expect all values ≈ 1.0 (255/255)
    for (let i = 0; i < patches.length; i++) {
      expect(patches[i] ?? 0).toBeCloseTo(1.0, 3);
    }
  });

  it('uniform black crop → all patches near 0.0', () => {
    const crop = makeImageData(440, 80, 0);
    const patches = extractCharPatches(crop, 'TD3');
    for (let i = 0; i < patches.length; i++) {
      expect(patches[i] ?? 1).toBeCloseTo(0.0, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// postprocess.ts — postprocessLogits
// ---------------------------------------------------------------------------

describe('postprocessLogits', () => {
  it('picks the class with highest logit', () => {
    // One character, 37 classes — spike at index 5 → '5'
    const logits = new Float32Array(37).fill(-10);
    logits[5] = 10;
    const { chars, confidences } = postprocessLogits(logits, 1);
    expect(chars[0]).toBe(MRZ_ALPHABET[5]);
    expect(confidences[0]).toBeGreaterThan(0.99);
  });

  it('last class index 36 → filler "<"', () => {
    const logits = new Float32Array(37).fill(-10);
    logits[36] = 10;
    const { chars } = postprocessLogits(logits, 1);
    expect(chars[0]).toBe('<');
  });

  it('uniform logits → confidence ≈ 1/37', () => {
    const logits = new Float32Array(37).fill(0);
    const { confidences } = postprocessLogits(logits, 1);
    expect(confidences[0]).toBeCloseTo(1 / 37, 3);
  });

  it('handles multiple characters', () => {
    const numChars = 5;
    const logits = new Float32Array(numChars * 37).fill(-5);
    // Each char i wins class i
    for (let i = 0; i < numChars; i++) logits[i * 37 + i] = 10;
    const { chars, confidences } = postprocessLogits(logits, numChars);
    expect(chars).toHaveLength(numChars);
    expect(confidences).toHaveLength(numChars);
    for (let i = 0; i < numChars; i++) {
      expect(chars[i]).toBe(MRZ_ALPHABET[i]);
      expect(confidences[i]).toBeGreaterThan(0.99);
    }
  });
});

// ---------------------------------------------------------------------------
// postprocess.ts — buildLines
// ---------------------------------------------------------------------------

describe('buildLines', () => {
  it('TD3: splits 88 chars into 2 lines of 44', () => {
    const chars = Array.from({ length: 88 }, (_, i) => MRZ_ALPHABET[i % 37] ?? '<');
    const lines = buildLines(chars, FORMAT_SPECS['TD3']);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength(44);
    expect(lines[1]).toHaveLength(44);
  });

  it('TD1: splits 90 chars into 3 lines of 30', () => {
    const chars = Array.from({ length: 90 }, () => 'A');
    const lines = buildLines(chars, FORMAT_SPECS['TD1']);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l).toHaveLength(30);
  });

  it('fills missing chars with "<"', () => {
    // Provide fewer chars than needed
    const chars = ['A', 'B'];
    const lines = buildLines(chars, FORMAT_SPECS['TD3']);
    // Lines 1 and 2 beyond index 2 fall back to '<'
    expect(lines[0]!.slice(2)).toBe('<'.repeat(42));
  });
});

// ---------------------------------------------------------------------------
// MockRecognizer
// ---------------------------------------------------------------------------

describe('MockRecognizer', () => {
  const formats: MRZFormat[] = ['TD1', 'TD2', 'TD3', 'MRV-A', 'MRV-B'];

  for (const fmt of formats) {
    const spec = FORMAT_SPECS[fmt];

    it(`${fmt}: returns correct number of lines (${spec.lines})`, async () => {
      const mock = new MockRecognizer();
      await mock.init();
      const crop = makeImageData(440, 80);
      const result = await mock.recognize(crop, fmt);
      expect(result.lines).toHaveLength(spec.lines);
    });

    it(`${fmt}: each line has ${spec.charsPerLine} characters`, async () => {
      const mock = new MockRecognizer();
      const crop = makeImageData(440, 80);
      const result = await mock.recognize(crop, fmt);
      for (const line of result.lines) {
        expect(line).toHaveLength(spec.charsPerLine);
      }
    });

    it(`${fmt}: charConfidences has correct shape [${spec.lines}][${spec.charsPerLine}]`, async () => {
      const mock = new MockRecognizer();
      const crop = makeImageData(440, 80);
      const result = await mock.recognize(crop, fmt);
      expect(result.charConfidences).toHaveLength(spec.lines);
      for (const row of result.charConfidences) {
        expect(row).toHaveLength(spec.charsPerLine);
      }
    });

    it(`${fmt}: meanConfidence is in [0, 1]`, async () => {
      const mock = new MockRecognizer();
      const crop = makeImageData(440, 80);
      const result = await mock.recognize(crop, fmt);
      expect(result.meanConfidence).toBeGreaterThanOrEqual(0);
      expect(result.meanConfidence).toBeLessThanOrEqual(1);
    });

    it(`${fmt}: all chars are from MRZ alphabet`, async () => {
      const mock = new MockRecognizer();
      const crop = makeImageData(440, 80);
      const result = await mock.recognize(crop, fmt);
      const alphabetSet = new Set(MRZ_ALPHABET.split(''));
      for (const line of result.lines) {
        for (const ch of line) {
          expect(alphabetSet.has(ch)).toBe(true);
        }
      }
    });
  }

  it('destroy() can be called safely', () => {
    const mock = new MockRecognizer();
    expect(() => mock.destroy()).not.toThrow();
  });
});
