export type {
  MRZFormat,
  Point,
  DetectionResult,
  DetectedRegion,
  RecognitionResult,
  MRZFields,
  MRZResult,
  WorkerFrameResult,
  MRZScannerOptions,
  MRZErrorCode,
} from './types.js';
export { MRZError } from './types.js';

import * as Comlink from 'comlink';
import { FrameExtractor } from './capture/FrameExtractor.js';
import { ConfidenceBuffer } from './pipeline/ConfidenceBuffer.js';
import { createWorkerProxy } from './worker/bridge.js';
import type { WorkerAPI } from './worker/bridge.js';
import type {
  MRZFormat,
  MRZResult,
  DetectedRegion,
  WorkerFrameResult,
  MRZScannerOptions,
} from './types.js';
import { MRZError } from './types.js';

type WorkerProxy = Comlink.Remote<WorkerAPI>;

const DEFAULT_FRAME_RATE = 8;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;
const DEFAULT_VOTING_FRAMES = 3;
const DEFAULT_FORMATS: MRZFormat[] = ['TD1', 'TD2', 'TD3', 'MRV-A', 'MRV-B'];

/**
 * Top-level scanner class. The only class consumers need to touch.
 *
 * Lifecycle:
 *   1. `new MRZScanner(options)`
 *   2. `await scanner.init()`
 *   3. `scanner.attach(videoEl)` or `scanner.setStream(stream, dims)`
 *   4. `scanner.start()`
 *   5. Receive results via `options.onResult`
 *   6. `scanner.stop()` / `scanner.destroy()`
 */
export class MRZScanner {
  private readonly onResult: (result: MRZResult) => void;
  private readonly onError: (error: Error) => void;
  private readonly onDetected: (region: DetectedRegion) => void;
  private readonly onProcessing: (isProcessing: boolean) => void;
  private readonly frameRate: number;
  private readonly confidenceThreshold: number;
  private readonly votingFrames: number;
  private readonly formats: MRZFormat[];
  private readonly modelUrl: string | undefined;
  private readonly workerUrl: string | undefined;
  private readonly ortWasmPath: string | undefined;
  private readonly ortUrl: string | undefined;

  private worker: WorkerProxy | null = null;
  private extractor: FrameExtractor | null = null;
  private confidenceBuffer: ConfidenceBuffer;
  private video: HTMLVideoElement | null = null;

  constructor(options: MRZScannerOptions) {
    this.onResult = options.onResult;
    this.onError = options.onError ?? (() => { /* noop */ });
    this.onDetected = options.onDetected ?? (() => { /* noop */ });
    this.onProcessing = options.onProcessing ?? (() => { /* noop */ });
    this.frameRate = options.frameRate ?? DEFAULT_FRAME_RATE;
    this.confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.votingFrames = options.votingFrames ?? DEFAULT_VOTING_FRAMES;
    this.formats = options.formats ?? DEFAULT_FORMATS;
    this.modelUrl = options.modelUrl;
    this.workerUrl = options.workerUrl;
    this.ortWasmPath = options.ortWasmPath;
    this.ortUrl = options.ortUrl;

    this.confidenceBuffer = new ConfidenceBuffer({
      votingFrames: this.votingFrames,
      confidenceThreshold: this.confidenceThreshold,
    });

  }

  /**
   * Load the ONNX model and spawn the Web Worker. Must be called once before
   * `attach()` / `start()`.
   */
  async init(): Promise<void> {
    if (this.worker !== null) return;

    if (typeof Worker === 'undefined') {
      throw new MRZError('Web Workers are not supported in this environment', 'BROWSER_NOT_SUPPORTED');
    }

    const workerUrl = this.workerUrl ?? new URL('./worker/mrz.worker.js', import.meta.url).href;

    try {
      this.worker = createWorkerProxy(workerUrl);
    } catch (err) {
      throw new MRZError('Failed to spawn Web Worker', 'WORKER_INIT_FAILED', err);
    }

    const modelUrl = this.modelUrl ?? new URL('../model/mrz-ocr.onnx', import.meta.url).href;

    try {
      await this.worker.init(modelUrl, this.formats, this.ortWasmPath, this.ortUrl);
    } catch (err) {
      throw new MRZError('Failed to load ONNX model in Worker', 'MODEL_LOAD_FAILED', err);
    }
  }

  /**
   * Attach the scanner to a `<video>` element. The element must have an active
   * `srcObject` (MediaStream) and be playing when `start()` is called.
   */
  attach(video: HTMLVideoElement): void {
    this.video = video;
  }

  /**
   * Attach using a raw `MediaStream`. Creates and manages a hidden `<video>`
   * element internally. Provide `dimensions` if the stream resolution is known
   * in advance (avoids a layout query on every frame).
   */
  setStream(stream: MediaStream, dimensions?: { width: number; height: number }): void {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    if (dimensions !== undefined) {
      video.width = dimensions.width;
      video.height = dimensions.height;
    }
    void video.play();
    this.video = video;
  }

  /** Begin frame extraction and processing. */
  start(): void {
    if (this.worker === null) {
      this.onError(new MRZError('Call init() before start()', 'WORKER_INIT_FAILED'));
      return;
    }
    if (this.video === null) {
      this.onError(new MRZError('Call attach() or setStream() before start()', 'WORKER_INIT_FAILED'));
      return;
    }
    if (this.extractor !== null) return; // already running

    const worker = this.worker;

    this.extractor = new FrameExtractor(
      this.video,
      (bitmap, _w, _h) => {
        this.onProcessing(true);
        void worker.processFrame(
          // Transfer the bitmap to the Worker with zero copy
          Comlink.transfer(bitmap, [bitmap]) as unknown as ImageBitmap,
        ).then((frameResult: WorkerFrameResult) => {
          this.extractor?.markDone();
          this.onProcessing(false);
          this.handleFrameResult(frameResult);
        }).catch((err: unknown) => {
          this.extractor?.markDone();
          this.onProcessing(false);
          this.onError(new MRZError('Worker processFrame failed', 'OCR_FAILED', err));
        });
      },
      this.frameRate,
    );

    this.extractor.start();
  }

  /** Pause processing. The Worker and model remain loaded; call `start()` to resume. */
  stop(): void {
    this.extractor?.stop();
    this.confidenceBuffer.clear();
  }

  /** Release the video reference. Call before `destroy()` or when switching streams. */
  detach(): void {
    this.extractor?.destroy();
    this.extractor = null;
    this.video = null;
  }

  /** Terminate the Worker, unload the model, and free all resources. */
  async destroy(): Promise<void> {
    this.detach();
    if (this.worker !== null) {
      try {
        this.worker.destroy();
      } catch {
        // ignore
      }
      // Comlink proxies don't have a built-in close; the Worker GCs naturally.
      this.worker = null;
    }
  }

  // ---------------------------------------------------------------------------
  // One-shot static method
  // ---------------------------------------------------------------------------

  /**
   * Scan a single image for an MRZ. Does not require a running scanner instance.
   *
   * @param source An `HTMLImageElement`, `Blob`, `File`, `ImageData`, or a URL string.
   * @param options Partial scanner options (only `modelUrl`, `ortWasmPath`, and `formats` are used).
   * @returns The best MRZ result found, or `null` if no MRZ was detected.
   */
  static async scanImage(
    source: HTMLImageElement | Blob | File | ImageData | string,
    options?: Partial<MRZScannerOptions>,
  ): Promise<MRZResult | null> {
    const { MRZPipeline } = await import('./pipeline/MRZPipeline.js');

    const pipeline = new MRZPipeline();
    const modelUrl = options?.modelUrl ?? '';

    if (modelUrl === '') {
      throw new MRZError('modelUrl is required for MRZScanner.scanImage()', 'MODEL_LOAD_FAILED');
    }

    await pipeline.init(modelUrl, options?.formats ?? DEFAULT_FORMATS, options?.ortWasmPath, options?.ortUrl);

    try {
      const imageData = await sourceToImageData(source);
      const frameResult = await pipeline.processImageData(imageData);
      return frameResult.result;
    } finally {
      pipeline.destroy();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private handleFrameResult(frameResult: WorkerFrameResult): void {
    if (frameResult.region !== null) {
      this.onDetected(frameResult.region as DetectedRegion);
    }

    if (frameResult.result === null) return;

    const emittable = this.confidenceBuffer.push(frameResult.result);
    if (emittable !== null) {
      this.onResult(emittable);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

async function sourceToImageData(source: HTMLImageElement | Blob | File | ImageData | string): Promise<ImageData> {
  if (source instanceof ImageData) return source;

  let bitmap: ImageBitmap;

  if (typeof source === 'string') {
    const resp = await fetch(source);
    const blob = await resp.blob();
    bitmap = await createImageBitmap(blob);
  } else if (source instanceof Blob || source instanceof File) {
    bitmap = await createImageBitmap(source);
  } else {
    // HTMLImageElement
    bitmap = await createImageBitmap(source);
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('OffscreenCanvas context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
