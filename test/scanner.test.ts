/**
 * Integration tests for MRZScanner — the public-facing API.
 *
 * The Web Worker (bridge) and FrameExtractor are fully mocked so tests run in
 * Node without any browser APIs or real ONNX inference. Frames are delivered
 * synchronously by calling the captured `onFrame` closure directly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  WorkerFrameResult,
  MRZResult,
  DetectedRegion,
  MRZScannerOptions,
} from '../src/types.js';

// -----------------------------------------------------------------------
// Environment shims — Node has no Worker, ImageData, OffscreenCanvas, etc.
// -----------------------------------------------------------------------
(globalThis as Record<string, unknown>).Worker = class {};

if (typeof (globalThis as Record<string, unknown>)['ImageData'] === 'undefined') {
  (globalThis as Record<string, unknown>)['ImageData'] = class {
    colorSpace = 'srgb' as const;
    constructor(
      public readonly data: Uint8ClampedArray,
      public readonly width: number,
      public readonly height: number,
    ) {}
  };
}

// -----------------------------------------------------------------------
// Hoisted mock primitives — created before any vi.mock factory executes
// -----------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  let _onFrame: ((b: ImageBitmap, w: number, h: number) => void) | null = null;

  return {
    // Worker proxy surface
    workerInit: vi.fn().mockResolvedValue(undefined),
    workerProcessFrame: vi.fn(),
    workerDestroy: vi.fn(),
    createWorkerProxy: vi.fn(),

    // FrameExtractor surface
    extractorStart: vi.fn(),
    extractorStop: vi.fn(),
    extractorDestroy: vi.fn(),
    extractorMarkDone: vi.fn(),
    getOnFrame: () => _onFrame,
    setOnFrame: (cb: typeof _onFrame) => { _onFrame = cb; },
    resetOnFrame: () => { _onFrame = null; },

    // MRZPipeline surface (used by MRZScanner.scanImage)
    pipelineInit: vi.fn().mockResolvedValue(undefined),
    pipelineProcessImageData: vi.fn(),
    pipelineDestroy: vi.fn(),
  };
});

// -----------------------------------------------------------------------
// Module mocks
// -----------------------------------------------------------------------

vi.mock('../src/worker/bridge.js', () => ({
  createWorkerProxy: mocks.createWorkerProxy.mockImplementation(() => ({
    init: mocks.workerInit,
    processFrame: mocks.workerProcessFrame,
    destroy: mocks.workerDestroy,
  })),
}));

vi.mock('../src/capture/FrameExtractor.js', () => ({
  // Regular function (not arrow) so `new FrameExtractor(...)` works.
  FrameExtractor: vi.fn(function (
    this: unknown,
    _video: unknown,
    onFrame: (b: ImageBitmap, w: number, h: number) => void,
  ) {
    mocks.setOnFrame(onFrame);
    return {
      start:    mocks.extractorStart,
      stop:     mocks.extractorStop,
      destroy:  mocks.extractorDestroy,
      markDone: mocks.extractorMarkDone,
    };
  }),
}));

vi.mock('../src/pipeline/MRZPipeline.js', () => ({
  // Regular function (not arrow) so `new MRZPipeline()` works in a dynamic import context.
  MRZPipeline: vi.fn(function (this: unknown) {
    return {
      init:             mocks.pipelineInit,
      processImageData: mocks.pipelineProcessImageData,
      destroy:          mocks.pipelineDestroy,
    };
  }),
}));

// -----------------------------------------------------------------------
// Subject under test — imported AFTER vi.mock declarations
// -----------------------------------------------------------------------
import { MRZScanner } from '../src/index.js';

// -----------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------

function makeResult(docNum = 'L898902C3', confidence = 0.95): MRZResult {
  return {
    format: 'TD3',
    valid: true,
    confidence,
    processingTimeMs: 5,
    raw: [
      'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<',
      'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
    ],
    fields: {
      documentType: 'P',
      documentSubtype: null,
      issuingState: 'UTO',
      surname: 'ERIKSSON',
      givenNames: 'ANNA MARIA',
      documentNumber: docNum,
      nationality: 'UTO',
      dateOfBirth: '1974-08-12',
      sex: 'female',
      expiryDate: '2012-04-15',
      optionalData: null,
      optionalData2: null,
      compositeCheckDigit: '0',
    },
    details: [],
  };
}

function makeRegion(): DetectedRegion {
  return {
    corners: [
      { x: 100, y: 600 },
      { x: 1820, y: 600 },
      { x: 1820, y: 700 },
      { x: 100, y: 700 },
    ],
    angle: 0,
    width: 1720,
    height: 100,
  };
}

function makeWorkerFrameResult(detected = true, docNum = 'L898902C3'): WorkerFrameResult {
  return {
    result: detected ? makeResult(docNum) : null,
    region: detected ? makeRegion() : null,
    processingTimeMs: 5,
  };
}

function makeFakeBitmap(): ImageBitmap {
  return { width: 1920, height: 1080, close: vi.fn() } as unknown as ImageBitmap;
}

function makeFakeVideo(): HTMLVideoElement {
  return { readyState: 4, videoWidth: 1920, videoHeight: 1080 } as unknown as HTMLVideoElement;
}

/** Flush all pending microtasks and one macrotask turn. */
async function flushPromises(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

/** Create, init, attach, and start a scanner with sensible test defaults. */
async function makeStartedScanner(opts?: Partial<MRZScannerOptions>): Promise<MRZScanner> {
  const scanner = new MRZScanner({
    onResult: vi.fn(),
    workerUrl: 'fake://worker.js',
    modelUrl: 'fake://model.onnx',
    votingFrames: 3,
    ...opts,
  });
  await scanner.init();
  scanner.attach(makeFakeVideo());
  scanner.start();
  return scanner;
}

/** Deliver `count` frames via the captured onFrame callback. */
async function sendFrames(count: number, detected = true, docNum = 'L898902C3'): Promise<void> {
  mocks.workerProcessFrame.mockResolvedValue(makeWorkerFrameResult(detected, docNum));
  const onFrame = mocks.getOnFrame()!;
  for (let i = 0; i < count; i++) {
    onFrame(makeFakeBitmap(), 1920, 1080);
    await flushPromises();
  }
}

// -----------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resetOnFrame();
  // Re-apply default resolved values (clearAllMocks resets call history but keeps
  // implementations; re-setting ensures tests that override these start cleanly).
  mocks.workerProcessFrame.mockResolvedValue(makeWorkerFrameResult());
  mocks.pipelineProcessImageData.mockResolvedValue(makeWorkerFrameResult());
  mocks.createWorkerProxy.mockImplementation(() => ({
    init:         mocks.workerInit,
    processFrame: mocks.workerProcessFrame,
    destroy:      mocks.workerDestroy,
  }));
});

// -----------------------------------------------------------------------
// 1. init()
// -----------------------------------------------------------------------

describe('MRZScanner — init()', () => {
  it('spawns the worker with the provided workerUrl', async () => {
    const scanner = new MRZScanner({
      onResult: vi.fn(),
      workerUrl: 'fake://worker.js',
      modelUrl:  'fake://model.onnx',
    });
    await scanner.init();

    expect(mocks.createWorkerProxy).toHaveBeenCalledWith('fake://worker.js');
  });

  it('calls worker.init with modelUrl and formats', async () => {
    const scanner = new MRZScanner({
      onResult: vi.fn(),
      workerUrl: 'fake://worker.js',
      modelUrl:  'fake://model.onnx',
      formats:   ['TD3'],
    });
    await scanner.init();

    expect(mocks.workerInit).toHaveBeenCalledWith('fake://model.onnx', ['TD3'], undefined, undefined);
  });

  it('is idempotent — second init() call is a no-op', async () => {
    const scanner = new MRZScanner({
      onResult: vi.fn(),
      workerUrl: 'fake://worker.js',
      modelUrl:  'fake://model.onnx',
    });
    await scanner.init();
    await scanner.init(); // second call

    expect(mocks.createWorkerProxy).toHaveBeenCalledTimes(1);
  });

  it('throws BROWSER_NOT_SUPPORTED when Worker is not available', async () => {
    const g = globalThis as Record<string, unknown>;
    const original = g['Worker'];
    try {
      delete g['Worker'];
      const scanner = new MRZScanner({ onResult: vi.fn(), modelUrl: 'x' });
      await expect(scanner.init()).rejects.toMatchObject({ code: 'BROWSER_NOT_SUPPORTED' });
    } finally {
      g['Worker'] = original;
    }
  });
});

// -----------------------------------------------------------------------
// 2. attach() + start() → onResult after votingFrames consistent results
// -----------------------------------------------------------------------

describe('MRZScanner — start() and onResult', () => {
  it('delivers frames to the worker via processFrame', async () => {
    const scanner = await makeStartedScanner();
    await sendFrames(1);

    expect(mocks.workerProcessFrame).toHaveBeenCalledTimes(1);
  });

  it('emits exactly one result after 3 consistent frames (votingFrames=3)', async () => {
    const onResult = vi.fn();
    await makeStartedScanner({ onResult });

    await sendFrames(3, true, 'L898902C3');

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].fields.documentNumber).toBe('L898902C3');
    expect(onResult.mock.calls[0][0].valid).toBe(true);
  });

  it('does not emit after only 2 frames', async () => {
    const onResult = vi.fn();
    await makeStartedScanner({ onResult });

    await sendFrames(2);

    expect(onResult).not.toHaveBeenCalled();
  });

  it('emits the highest-confidence result from the voting window', async () => {
    const onResult = vi.fn();
    await makeStartedScanner({ onResult });
    const onFrame = mocks.getOnFrame()!;

    mocks.workerProcessFrame.mockResolvedValueOnce(makeWorkerFrameResult(true, 'DOC001'));
    onFrame(makeFakeBitmap(), 1920, 1080);
    await flushPromises();

    // Highest confidence frame
    mocks.workerProcessFrame.mockResolvedValueOnce({
      ...makeWorkerFrameResult(true, 'DOC001'),
      result: makeResult('DOC001', 0.99),
    });
    onFrame(makeFakeBitmap(), 1920, 1080);
    await flushPromises();

    mocks.workerProcessFrame.mockResolvedValueOnce(makeWorkerFrameResult(true, 'DOC001'));
    onFrame(makeFakeBitmap(), 1920, 1080);
    await flushPromises();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].confidence).toBe(0.99);
  });

  it('does not emit when frames disagree on documentNumber', async () => {
    const onResult = vi.fn();
    await makeStartedScanner({ onResult });
    const onFrame = mocks.getOnFrame()!;

    mocks.workerProcessFrame.mockResolvedValueOnce(makeWorkerFrameResult(true, 'AAA111'));
    onFrame(makeFakeBitmap(), 1920, 1080);
    await flushPromises();

    mocks.workerProcessFrame.mockResolvedValueOnce(makeWorkerFrameResult(true, 'AAA111'));
    onFrame(makeFakeBitmap(), 1920, 1080);
    await flushPromises();

    // Third frame disagrees — no emit
    mocks.workerProcessFrame.mockResolvedValueOnce(makeWorkerFrameResult(true, 'BBB222'));
    onFrame(makeFakeBitmap(), 1920, 1080);
    await flushPromises();

    expect(onResult).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// 3. onDetected — called per frame as soon as region is located
// -----------------------------------------------------------------------

describe('MRZScanner — onDetected', () => {
  it('calls onDetected on every frame that has a detected region', async () => {
    const onDetected = vi.fn();
    const onResult = vi.fn();
    await makeStartedScanner({ onDetected, onResult });

    await sendFrames(3);

    expect(onDetected).toHaveBeenCalledTimes(3);
  });

  it('calls onDetected before consensus (before onResult fires)', async () => {
    const order: string[] = [];
    const onDetected = vi.fn(() => order.push('detected'));
    const onResult   = vi.fn(() => order.push('result'));
    await makeStartedScanner({ onDetected, onResult });

    await sendFrames(3);

    // All 3 detections happen before the single result emission
    expect(order).toEqual(['detected', 'detected', 'detected', 'result']);
  });

  it('does not call onDetected when region is null', async () => {
    const onDetected = vi.fn();
    await makeStartedScanner({ onDetected });

    await sendFrames(2, false); // detected=false → region:null

    expect(onDetected).not.toHaveBeenCalled();
  });

  it('calls onDetected with the correct region shape', async () => {
    const onDetected = vi.fn();
    await makeStartedScanner({ onDetected });

    await sendFrames(1);

    const region: DetectedRegion = onDetected.mock.calls[0][0] as DetectedRegion;
    expect(region.corners).toHaveLength(4);
    expect(typeof region.angle).toBe('number');
    expect(typeof region.width).toBe('number');
    expect(typeof region.height).toBe('number');
  });
});

// -----------------------------------------------------------------------
// 4. stop() — halts frame processing and clears the confidence buffer
// -----------------------------------------------------------------------

describe('MRZScanner — stop()', () => {
  it('calls extractor.stop()', async () => {
    const scanner = await makeStartedScanner();
    scanner.stop();

    expect(mocks.extractorStop).toHaveBeenCalled();
  });

  it('clears the confidence buffer — subsequent frames do not emit without a fresh 3-frame run', async () => {
    const onResult = vi.fn();
    const scanner  = await makeStartedScanner({ onResult });

    // Build up 2 frames in the buffer (not yet enough to emit)
    await sendFrames(2);
    expect(onResult).not.toHaveBeenCalled();

    scanner.stop(); // clears buffer

    // Two more frames after stop — buffer restarted, still not enough
    await sendFrames(2);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('allows scanning to resume after stop() — 3 fresh frames emit after buffer was cleared', async () => {
    const onResult = vi.fn();
    const scanner = await makeStartedScanner({ onResult });

    // 2 frames build partial consensus
    await sendFrames(2);
    expect(onResult).not.toHaveBeenCalled();

    // stop() clears the ConfidenceBuffer; the extractor + onFrame callback remain valid
    scanner.stop();

    // 3 fresh consistent frames rebuild consensus from scratch
    await sendFrames(3);
    expect(onResult).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------
// 5. destroy() — terminates worker and releases all resources
// -----------------------------------------------------------------------

describe('MRZScanner — destroy()', () => {
  it('calls worker.destroy()', async () => {
    const scanner = await makeStartedScanner();
    await scanner.destroy();

    expect(mocks.workerDestroy).toHaveBeenCalled();
  });

  it('calls extractor.destroy()', async () => {
    const scanner = await makeStartedScanner();
    await scanner.destroy();

    expect(mocks.extractorDestroy).toHaveBeenCalled();
  });

  it('is safe to call destroy() without ever calling start()', async () => {
    const scanner = new MRZScanner({ onResult: vi.fn(), workerUrl: 'x', modelUrl: 'x' });
    await scanner.init();
    await expect(scanner.destroy()).resolves.toBeUndefined();
    expect(mocks.workerDestroy).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// 6. Error handling — non-fatal processFrame failure
// -----------------------------------------------------------------------

describe('MRZScanner — error handling', () => {
  it('routes processFrame errors to onError with code OCR_FAILED', async () => {
    const onError  = vi.fn();
    const onResult = vi.fn();
    await makeStartedScanner({ onError, onResult });
    const onFrame = mocks.getOnFrame()!;

    mocks.workerProcessFrame.mockRejectedValueOnce(new Error('inference exploded'));
    onFrame(makeFakeBitmap(), 1920, 1080);
    await flushPromises();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ code: 'OCR_FAILED' });
  });

  it('continues scanning after a non-fatal processFrame error', async () => {
    const onError  = vi.fn();
    const onResult = vi.fn();
    await makeStartedScanner({ onError, onResult });

    // Frame 1 throws
    mocks.workerProcessFrame.mockRejectedValueOnce(new Error('boom'));
    await sendFrames(1);
    expect(onError).toHaveBeenCalledTimes(1);

    // Frames 2-4 succeed — scanner is still alive, emits after 3 agreeing frames
    await sendFrames(3);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('onProcessing is set to false even after a processFrame error', async () => {
    const onProcessing = vi.fn();
    await makeStartedScanner({ onProcessing });

    mocks.workerProcessFrame.mockRejectedValueOnce(new Error('boom'));
    await sendFrames(1);

    // onProcessing(true) then onProcessing(false) — net state is idle
    const calls = (onProcessing.mock.calls as [boolean][]).map(([v]) => v);
    expect(calls[calls.length - 1]).toBe(false);
  });
});

// -----------------------------------------------------------------------
// 7. MRZScanner.scanImage() — one-shot static method
// -----------------------------------------------------------------------

describe('MRZScanner.scanImage()', () => {
  it('returns the MRZResult when the pipeline detects an MRZ', async () => {
    const expected = makeResult('SCAN001');
    mocks.pipelineProcessImageData.mockResolvedValue(makeWorkerFrameResult(true, 'SCAN001'));

    // Use a plain object that passes `instanceof ImageData` via the shim above
    const ImageDataCtor = (globalThis as Record<string, unknown>)['ImageData'] as new (
      d: Uint8ClampedArray, w: number, h: number
    ) => ImageData;
    const imageData = new ImageDataCtor(new Uint8ClampedArray(4 * 1 * 1), 1, 1);

    const result = await MRZScanner.scanImage(imageData, { modelUrl: 'fake://model.onnx' });

    expect(result).not.toBeNull();
    expect(result!.fields.documentNumber).toBe('SCAN001');
    expect(result!.valid).toBe(true);
  });

  it('returns null when the pipeline finds no MRZ', async () => {
    mocks.pipelineProcessImageData.mockResolvedValue(makeWorkerFrameResult(false));

    const ImageDataCtor = (globalThis as Record<string, unknown>)['ImageData'] as new (
      d: Uint8ClampedArray, w: number, h: number
    ) => ImageData;
    const imageData = new ImageDataCtor(new Uint8ClampedArray(4), 1, 1);

    const result = await MRZScanner.scanImage(imageData, { modelUrl: 'fake://model.onnx' });

    expect(result).toBeNull();
  });

  it('calls pipeline.destroy() even when processImageData succeeds', async () => {
    const ImageDataCtor = (globalThis as Record<string, unknown>)['ImageData'] as new (
      d: Uint8ClampedArray, w: number, h: number
    ) => ImageData;
    const imageData = new ImageDataCtor(new Uint8ClampedArray(4), 1, 1);

    await MRZScanner.scanImage(imageData, { modelUrl: 'fake://model.onnx' });

    expect(mocks.pipelineDestroy).toHaveBeenCalled();
  });

  it('calls pipeline.destroy() even when processImageData throws', async () => {
    mocks.pipelineProcessImageData.mockRejectedValueOnce(new Error('pipeline error'));

    const ImageDataCtor = (globalThis as Record<string, unknown>)['ImageData'] as new (
      d: Uint8ClampedArray, w: number, h: number
    ) => ImageData;
    const imageData = new ImageDataCtor(new Uint8ClampedArray(4), 1, 1);

    await expect(
      MRZScanner.scanImage(imageData, { modelUrl: 'fake://model.onnx' }),
    ).rejects.toThrow('pipeline error');

    expect(mocks.pipelineDestroy).toHaveBeenCalled();
  });

  it('throws MODEL_LOAD_FAILED when modelUrl is omitted', async () => {
    const ImageDataCtor = (globalThis as Record<string, unknown>)['ImageData'] as new (
      d: Uint8ClampedArray, w: number, h: number
    ) => ImageData;
    const imageData = new ImageDataCtor(new Uint8ClampedArray(4), 1, 1);

    await expect(
      MRZScanner.scanImage(imageData, {}),
    ).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' });
  });

  it('initialises the pipeline with the provided formats', async () => {
    const ImageDataCtor = (globalThis as Record<string, unknown>)['ImageData'] as new (
      d: Uint8ClampedArray, w: number, h: number
    ) => ImageData;
    const imageData = new ImageDataCtor(new Uint8ClampedArray(4), 1, 1);

    await MRZScanner.scanImage(imageData, {
      modelUrl: 'fake://model.onnx',
      formats: ['TD3'],
    });

    expect(mocks.pipelineInit).toHaveBeenCalledWith('fake://model.onnx', ['TD3'], undefined, undefined);
  });
});
