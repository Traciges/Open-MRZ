import type { FormatSpec } from './charCrop.js';

export const MRZ_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<';
const NUM_CLASSES = 37; // 10 digits + 26 letters + filler '<'

function softmax(logits: Float32Array, offset: number): Float32Array {
  const probs = new Float32Array(NUM_CLASSES);
  let max = -Infinity;
  for (let i = 0; i < NUM_CLASSES; i++) {
    const v = logits[offset + i] ?? -Infinity;
    if (v > max) max = v;
  }
  let sum = 0;
  for (let i = 0; i < NUM_CLASSES; i++) {
    probs[i] = Math.exp((logits[offset + i] ?? -Infinity) - max);
    sum += probs[i] ?? 0;
  }
  for (let i = 0; i < NUM_CLASSES; i++) {
    probs[i] = (probs[i] ?? 0) / sum;
  }
  return probs;
}

export interface PostprocessResult {
  chars: string[];
  confidences: number[];
}

/**
 * Convert flat ONNX logits [N × 37] to characters and per-character softmax confidences.
 */
export function postprocessLogits(
  logits: Float32Array,
  numChars: number,
): PostprocessResult {
  const chars: string[] = [];
  const confidences: number[] = [];

  for (let i = 0; i < numChars; i++) {
    const probs = softmax(logits, i * NUM_CLASSES);
    let maxProb = 0;
    let maxIdx = 0;
    for (let j = 0; j < NUM_CLASSES; j++) {
      const p = probs[j] ?? 0;
      if (p > maxProb) { maxProb = p; maxIdx = j; }
    }
    chars.push(MRZ_ALPHABET[maxIdx] ?? '<');
    confidences.push(maxProb);
  }

  return { chars, confidences };
}

/**
 * Split a flat character array into per-line strings according to the format spec.
 */
export function buildLines(chars: string[], spec: FormatSpec): string[] {
  const { lines, charsPerLine } = spec;
  const result: string[] = [];
  for (let l = 0; l < lines; l++) {
    let line = '';
    for (let c = 0; c < charsPerLine; c++) {
      line += chars[l * charsPerLine + c] ?? '<';
    }
    result.push(line);
  }
  return result;
}
