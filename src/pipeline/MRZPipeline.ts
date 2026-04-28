import type { MRZFormat, WorkerFrameResult, DetectedRegion } from '../types.js';
import { MRZDetector } from '../detect/MRZDetector.js';
import { MRZRecognizer } from '../ocr/MRZRecognizer.js';
import { MRZParser } from '../parse/MRZParser.js';

interface Recognizer {
  init(): Promise<void>;
  recognize(crop: ImageData, format: MRZFormat): Promise<{ lines: string[]; charConfidences: number[][]; meanConfidence: number }>;
  destroy(): void;
}

/** Infer MRZ format from the crop aspect ratio (width/height). */
function inferFormat(crop: ImageData, allowedFormats: MRZFormat[]): MRZFormat {
  const aspect = crop.width / Math.max(crop.height, 1);
  let candidate: MRZFormat;
  if (aspect > 20) {
    candidate = 'TD3';
  } else if (aspect > 14) {
    candidate = 'TD2';
  } else {
    candidate = 'TD1';
  }
  return allowedFormats.includes(candidate) ? candidate : (allowedFormats[0] ?? 'TD3');
}

function imageBitmapToImageData(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * Orchestrates the full per-frame pipeline: detect → ocr → parse.
 *
 * Designed to run inside a Web Worker. Accepts an optional `recognizer`
 * override so tests can inject a `MockRecognizer` without loading an ONNX model.
 */
export class MRZPipeline {
  private readonly detector = new MRZDetector();
  private recognizer: Recognizer | null = null;
  private readonly injectedRecognizer: Recognizer | null;
  private readonly parser = new MRZParser();
  private formats: MRZFormat[] = ['TD1', 'TD2', 'TD3', 'MRV-A', 'MRV-B'];

  constructor(opts?: { recognizer?: Recognizer }) {
    this.injectedRecognizer = opts?.recognizer ?? null;
  }

  async init(modelUrl: string, formats: MRZFormat[], wasmPath?: string, ortUrl?: string): Promise<void> {
    this.formats = formats;
    this.recognizer = this.injectedRecognizer ?? new MRZRecognizer(modelUrl, wasmPath, ortUrl);
    await this.recognizer.init();
  }

  async processFrame(bitmap: ImageBitmap): Promise<WorkerFrameResult> {
    const imageData = imageBitmapToImageData(bitmap);
    bitmap.close();
    return this.processImageData(imageData);
  }

  async processImageData(imageData: ImageData): Promise<WorkerFrameResult> {
    const t0 = performance.now();

    if (this.recognizer === null) {
      return { result: null, region: null, processingTimeMs: performance.now() - t0 };
    }

    const detection = this.detector.detect(imageData);
    if (detection === null) {
      return { result: null, region: null, processingTimeMs: performance.now() - t0 };
    }

    const region: DetectedRegion = {
      corners: detection.corners,
      angle: detection.angle,
      width: detection.crop.width,
      height: detection.crop.height,
    };

    const format = inferFormat(detection.crop, this.formats);

    let result = null;
    try {
      const recognition = await this.recognizer.recognize(detection.crop, format);
      const parsed = this.parser.parse(recognition.lines, recognition.charConfidences);
      result = { ...parsed, processingTimeMs: performance.now() - t0 };
    } catch {
      // OCR or parse failure — return region but no result
    }

    return { result, region, processingTimeMs: performance.now() - t0 };
  }

  destroy(): void {
    this.recognizer?.destroy();
    this.recognizer = null;
  }
}
