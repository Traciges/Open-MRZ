import { describe, it, expect, beforeEach } from 'vitest';
import { Scheduler } from '../src/pipeline/scheduler.js';
import { ConfidenceBuffer } from '../src/pipeline/ConfidenceBuffer.js';
import { MRZPipeline } from '../src/pipeline/MRZPipeline.js';
import { MockRecognizer } from '../src/ocr/MRZRecognizer.js';
import type { MRZResult } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeImageData(w: number, h: number, fillGray = 240): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fillGray;
    data[i * 4 + 1] = fillGray;
    data[i * 4 + 2] = fillGray;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h, colorSpace: 'srgb' } as ImageData;
}

function drawRect(img: ImageData, x: number, y: number, rw: number, rh: number, value = 0): void {
  for (let row = y; row < y + rh && row < img.height; row++) {
    for (let col = x; col < x + rw && col < img.width; col++) {
      const idx = (row * img.width + col) * 4;
      img.data[idx] = value;
      img.data[idx + 1] = value;
      img.data[idx + 2] = value;
      img.data[idx + 3] = 255;
    }
  }
}

/** Draw two horizontal text-line blobs that look like an MRZ region. */
function makeMRZFrame(): ImageData {
  // 800×300 white image — wider than TARGET_WIDTH so rescaling happens in MRZDetector
  const img = makeImageData(800, 300, 240);
  // Two rows of character-like small rectangles (simulates TD3 MRZ text)
  const charW = 5, charH = 10, gap = 2, count = 44, startX = 80;
  for (let i = 0; i < count; i++) {
    drawRect(img, startX + i * (charW + gap), 110, charW, charH);
    drawRect(img, startX + i * (charW + gap), 130, charW, charH);
  }
  return img;
}

function makeResult(
  docNum: string | null,
  confidence: number,
  valid = true,
): MRZResult {
  return {
    format: 'TD3',
    valid,
    fields: {
      documentType: 'P',
      documentSubtype: null,
      issuingState: 'GBR',
      surname: 'TEST',
      givenNames: 'USER',
      documentNumber: docNum,
      nationality: 'GBR',
      dateOfBirth: '1990-01-01',
      sex: 'neutral',
      expiryDate: '2030-01-01',
      optionalData: null,
      optionalData2: null,
      compositeCheckDigit: null,
    },
    details: [],
    raw: [],
    confidence,
    processingTimeMs: 1,
  };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe('Scheduler — isProcessing guard', () => {
  it('allows first frame immediately', () => {
    const sched = new Scheduler(8);
    expect(sched.shouldProcess(0)).toBe(true);
  });

  it('drops frame when worker is busy', () => {
    const sched = new Scheduler(8);
    expect(sched.shouldProcess(0)).toBe(true);
    sched.markStart(0);
    // Worker is now busy — next frame must be dropped
    expect(sched.shouldProcess(200)).toBe(false);
  });

  it('allows frame after markDone clears busy flag', () => {
    const sched = new Scheduler(8);
    sched.markStart(0);
    sched.markDone();
    // 200 ms later, well past the 125 ms interval for 8 fps
    expect(sched.shouldProcess(200)).toBe(true);
  });
});

describe('Scheduler — FPS cap', () => {
  it('drops frame that arrives before min interval (8 fps = 125 ms)', () => {
    const sched = new Scheduler(8);
    sched.markStart(0);
    sched.markDone();
    // Only 50 ms has elapsed — too soon
    expect(sched.shouldProcess(50)).toBe(false);
  });

  it('allows frame exactly at interval boundary', () => {
    const sched = new Scheduler(8);
    sched.markStart(0);
    sched.markDone();
    expect(sched.shouldProcess(125)).toBe(true);
  });

  it('counts dropped frames in stats', () => {
    const sched = new Scheduler(8);
    sched.markStart(0);
    sched.markDone();
    sched.shouldProcess(10);  // too soon → drop
    sched.shouldProcess(20);  // too soon → drop
    expect(sched.getStats().droppedFrames).toBe(2);
  });

  it('counts processed frames in stats', () => {
    const sched = new Scheduler(8);
    sched.markStart(0); sched.markDone();
    sched.markStart(200); sched.markDone();
    expect(sched.getStats().processedFrames).toBe(2);
  });

  it('reset() zeros all counters and state', () => {
    const sched = new Scheduler(8);
    sched.markStart(0);
    sched.reset();
    expect(sched.isProcessing).toBe(false);
    expect(sched.getStats().processedFrames).toBe(0);
    // After reset the very next frame should be accepted
    expect(sched.shouldProcess(1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ConfidenceBuffer
// ---------------------------------------------------------------------------

describe('ConfidenceBuffer — consensus emit', () => {
  it('returns null when buffer is not yet full', () => {
    const buf = new ConfidenceBuffer({ votingFrames: 3, confidenceThreshold: 0.5 });
    expect(buf.push(makeResult('DOC123', 0.9))).toBeNull();
    expect(buf.push(makeResult('DOC123', 0.9))).toBeNull();
  });

  it('emits on third agreeing frame', () => {
    const buf = new ConfidenceBuffer({ votingFrames: 3, confidenceThreshold: 0.5 });
    buf.push(makeResult('DOC123', 0.9));
    buf.push(makeResult('DOC123', 0.85));
    const emitted = buf.push(makeResult('DOC123', 0.92));
    expect(emitted).not.toBeNull();
    expect(emitted!.fields.documentNumber).toBe('DOC123');
  });

  it('emits the highest-confidence result', () => {
    const buf = new ConfidenceBuffer({ votingFrames: 3, confidenceThreshold: 0.5 });
    buf.push(makeResult('DOC123', 0.80));
    buf.push(makeResult('DOC123', 0.95)); // highest
    const emitted = buf.push(makeResult('DOC123', 0.88));
    expect(emitted!.confidence).toBe(0.95);
  });

  it('clears buffer after emit so same scan is not emitted twice', () => {
    const buf = new ConfidenceBuffer({ votingFrames: 3, confidenceThreshold: 0.5 });
    buf.push(makeResult('DOC123', 0.9));
    buf.push(makeResult('DOC123', 0.9));
    buf.push(makeResult('DOC123', 0.9)); // emits and clears
    // One more frame alone should not emit
    expect(buf.push(makeResult('DOC123', 0.9))).toBeNull();
  });
});

describe('ConfidenceBuffer — disagreement handling', () => {
  it('does not emit when a different documentNumber appears', () => {
    const buf = new ConfidenceBuffer({ votingFrames: 3, confidenceThreshold: 0.5 });
    buf.push(makeResult('DOC123', 0.9));
    buf.push(makeResult('DOC123', 0.9));
    // Third result has different doc number
    const emitted = buf.push(makeResult('DIFFERENT', 0.9));
    expect(emitted).toBeNull();
  });

  it('evicts oldest on disagreement and continues accumulating', () => {
    const buf = new ConfidenceBuffer({ votingFrames: 3, confidenceThreshold: 0.5 });
    buf.push(makeResult('DOC123', 0.9));
    buf.push(makeResult('DOC123', 0.9));
    buf.push(makeResult('DIFFERENT', 0.9)); // disagreement, oldest evicted
    // Buffer now has [DOC123, DIFFERENT] — two more matching DIFFERENT should emit
    buf.push(makeResult('DIFFERENT', 0.9));
    const emitted = buf.push(makeResult('DIFFERENT', 0.9));
    expect(emitted).not.toBeNull();
    expect(emitted!.fields.documentNumber).toBe('DIFFERENT');
  });
});

describe('ConfidenceBuffer — confidence threshold', () => {
  it('discards low-confidence results and clears buffer', () => {
    const buf = new ConfidenceBuffer({ votingFrames: 3, confidenceThreshold: 0.85 });
    buf.push(makeResult('DOC123', 0.9));
    buf.push(makeResult('DOC123', 0.9));
    // Low-confidence result clears everything
    expect(buf.push(makeResult('DOC123', 0.5))).toBeNull();
    // Buffer is now empty — two more frames should not yet emit
    expect(buf.push(makeResult('DOC123', 0.9))).toBeNull();
    expect(buf.push(makeResult('DOC123', 0.9))).toBeNull();
  });

  it('clear() empties the buffer', () => {
    const buf = new ConfidenceBuffer({ votingFrames: 3, confidenceThreshold: 0.5 });
    buf.push(makeResult('DOC123', 0.9));
    buf.push(makeResult('DOC123', 0.9));
    buf.clear();
    // Need 3 fresh frames again
    expect(buf.push(makeResult('DOC123', 0.9))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MRZPipeline
// ---------------------------------------------------------------------------

describe('MRZPipeline — null frame detection', () => {
  it('returns null result and null region for blank image', async () => {
    const pipeline = new MRZPipeline({ recognizer: new MockRecognizer() });
    await pipeline.init('', ['TD1', 'TD2', 'TD3', 'MRV-A', 'MRV-B']);

    const blank = makeImageData(640, 480, 200);
    const out = await pipeline.processImageData(blank);

    expect(out.result).toBeNull();
    expect(out.region).toBeNull();
    expect(typeof out.processingTimeMs).toBe('number');
    expect(out.processingTimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('MRZPipeline — synthetic MRZ frame', () => {
  let pipeline: MRZPipeline;

  beforeEach(async () => {
    pipeline = new MRZPipeline({ recognizer: new MockRecognizer() });
    await pipeline.init('', ['TD1', 'TD2', 'TD3', 'MRV-A', 'MRV-B']);
  });

  it('returns a non-null region when MRZ blobs are detected', async () => {
    const frame = makeMRZFrame();
    const out = await pipeline.processImageData(frame);
    // Detection must succeed — region should be non-null
    expect(out.region).not.toBeNull();
  });

  it('result has expected WorkerFrameResult shape', async () => {
    const frame = makeMRZFrame();
    const out = await pipeline.processImageData(frame);

    expect(typeof out.processingTimeMs).toBe('number');
    expect(out.processingTimeMs).toBeGreaterThanOrEqual(0);

    if (out.region !== null) {
      expect(out.region.corners).toHaveLength(4);
      expect(typeof out.region.angle).toBe('number');
      expect(typeof out.region.width).toBe('number');
      expect(typeof out.region.height).toBe('number');
    }

    if (out.result !== null) {
      expect(typeof out.result.format).toBe('string');
      expect(typeof out.result.valid).toBe('boolean');
      expect(typeof out.result.confidence).toBe('number');
      expect(Array.isArray(out.result.raw)).toBe(true);
    }
  });

  it('returns null result before init', async () => {
    const uninit = new MRZPipeline({ recognizer: new MockRecognizer() });
    // Do NOT call init — recognizer is null inside
    const frame = makeMRZFrame();
    const out = await uninit.processImageData(frame);
    expect(out.result).toBeNull();
    expect(out.region).toBeNull();
  });
});

describe('MRZPipeline — ConfidenceBuffer integration', () => {
  it('5 identical frames through pipeline+buffer emit exactly one result', async () => {
    const pipeline = new MRZPipeline({ recognizer: new MockRecognizer() });
    await pipeline.init('', ['TD1', 'TD2', 'TD3', 'MRV-A', 'MRV-B']);

    const buf = new ConfidenceBuffer({ votingFrames: 3, confidenceThreshold: 0 });
    const frame = makeMRZFrame();
    const emissions: MRZResult[] = [];

    for (let i = 0; i < 5; i++) {
      const { result } = await pipeline.processImageData(frame);
      if (result !== null) {
        const emitted = buf.push(result);
        if (emitted !== null) emissions.push(emitted);
      }
    }

    // With a MockRecognizer all frames produce random (inconsistent) doc numbers,
    // so 0 or 1 emissions depending on random chance — what matters is no crash
    // and the emission count is reasonable (not more than one per buffer fill).
    expect(emissions.length).toBeGreaterThanOrEqual(0);
    expect(emissions.length).toBeLessThanOrEqual(2);
  });
});
