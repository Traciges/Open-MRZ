import type { MRZResult } from '../types.js';

/**
 * N-frame majority-vote buffer.
 *
 * Accumulates parsed MRZ results and emits only when `votingFrames`
 * consecutive results agree on the document number AND each result
 * meets the confidence threshold. Prevents emitting noisy partial reads.
 */
export class ConfidenceBuffer {
  private buffer: MRZResult[] = [];

  constructor(
    private readonly options: {
      votingFrames: number;
      confidenceThreshold: number;
    },
  ) {}

  /**
   * Submit a new result. Returns the best (highest-confidence) buffered
   * result when consensus is reached, or `null` if more frames are needed.
   *
   * Consensus rule: all `votingFrames` entries must share the same
   * `fields.documentNumber`. On disagreement the oldest entry is evicted.
   * A result below `confidenceThreshold` immediately clears the buffer.
   */
  push(result: MRZResult): MRZResult | null {
    if (result.confidence < this.options.confidenceThreshold) {
      this.buffer = [];
      return null;
    }

    this.buffer.push(result);

    if (this.buffer.length < this.options.votingFrames) {
      return null;
    }

    const docNum = this.buffer[0]!.fields.documentNumber;
    const allAgree = this.buffer.every(r => r.fields.documentNumber === docNum);

    if (allAgree) {
      const best = this.buffer.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
      this.buffer = [];
      return best;
    }

    // Disagreement — evict oldest and keep accumulating
    this.buffer.shift();
    return null;
  }

  clear(): void {
    this.buffer = [];
  }
}
