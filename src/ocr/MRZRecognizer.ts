import type { InferenceSession } from 'onnxruntime-web';
import type { MRZFormat, RecognitionResult } from '../types.js';
import { extractCharPatches, FORMAT_SPECS } from './charCrop.js';
import { postprocessLogits, buildLines } from './postprocess.js';

const CHAR_SIZE = 20;

export class MRZRecognizer {
  private session: InferenceSession | null = null;

  constructor(
    private readonly modelUrl: string,
    private readonly wasmPath?: string,
  ) {}

  async init(): Promise<void> {
    const ort = await import('onnxruntime-web');

    // Set WASM file location so bundlers can serve them correctly
    if (this.wasmPath !== undefined) {
      ort.env.wasm.wasmPaths = this.wasmPath;
    }

    const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
    if (hasSharedArrayBuffer) {
      ort.env.wasm.numThreads = Math.min(
        (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined) ?? 2,
        4,
      );
    }

    this.session = await ort.InferenceSession.create(this.modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      executionMode: hasSharedArrayBuffer ? 'parallel' : 'sequential',
    });
  }

  async recognize(crop: ImageData, format: MRZFormat): Promise<RecognitionResult> {
    if (this.session === null) {
      throw new Error('MRZRecognizer not initialized — call init() first');
    }

    const ort = await import('onnxruntime-web');
    const spec = FORMAT_SPECS[format];
    const { lines, charsPerLine } = spec;
    const totalChars = lines * charsPerLine;

    const patches = extractCharPatches(crop, format);
    const inputName = this.session.inputNames[0] ?? 'input';
    const tensor = new ort.Tensor('float32', patches, [totalChars, 1, CHAR_SIZE, CHAR_SIZE]);

    const results = await this.session.run({ [inputName]: tensor });

    const outputName = this.session.outputNames[0] ?? 'output';
    const outputTensor = results[outputName];
    if (outputTensor === undefined) {
      throw new Error(`ONNX output tensor "${outputName}" not found`);
    }
    const logits = outputTensor.data as Float32Array;

    const { chars, confidences } = postprocessLogits(logits, totalChars);
    const mrzLines = buildLines(chars, spec);

    const charConfidences: number[][] = [];
    for (let l = 0; l < lines; l++) {
      charConfidences.push(
        Array.from(confidences.slice(l * charsPerLine, (l + 1) * charsPerLine)),
      );
    }

    const meanConfidence = confidences.reduce((s, c) => s + c, 0) / confidences.length;

    return { lines: mrzLines, charConfidences, meanConfidence };
  }

  destroy(): void {
    this.session = null;
  }
}

// ---------------------------------------------------------------------------
// MockRecognizer — same interface, no ONNX model required (for testing)
// ---------------------------------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<';

export class MockRecognizer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async init(): Promise<void> { /* no-op */ }

  async recognize(_crop: ImageData, format: MRZFormat): Promise<RecognitionResult> {
    const spec = FORMAT_SPECS[format];
    const { lines, charsPerLine } = spec;
    const totalChars = lines * charsPerLine;

    const chars = Array.from({ length: totalChars }, () => {
      const idx = Math.floor(Math.random() * ALPHABET.length);
      return ALPHABET[idx] ?? '<';
    });

    const perCharConf = 0.5 + Math.random() * 0.4;
    const charConfidences: number[][] = Array.from({ length: lines }, () =>
      Array.from({ length: charsPerLine }, () => perCharConf),
    );

    const mrzLines = buildLines(chars, spec);
    return { lines: mrzLines, charConfidences, meanConfidence: perCharConf };
  }

  destroy(): void { /* no-op */ }
}
