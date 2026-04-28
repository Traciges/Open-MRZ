/**
 * Supported ICAO 9303 MRZ document formats.
 *
 * - `TD1`   — ID card, 3 lines × 30 chars
 * - `TD2`   — Smaller travel document, 2 lines × 36 chars
 * - `TD3`   — Passport booklet, 2 lines × 44 chars
 * - `MRV-A` — Visa type A (same dimensions as TD3)
 * - `MRV-B` — Visa type B (same dimensions as TD2)
 */
export type MRZFormat = 'TD1' | 'TD2' | 'TD3' | 'MRV-A' | 'MRV-B';

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/** A 2-D point in pixel coordinates. */
export interface Point {
  /** Horizontal offset in pixels from the left edge of the reference frame. */
  x: number;
  /** Vertical offset in pixels from the top edge of the reference frame. */
  y: number;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Output of `MRZDetector.detect()`.
 * Contains the deskewed MRZ crop plus spatial metadata derived from the
 * original (full-resolution) camera frame.
 */
export interface DetectionResult {
  /** Cropped, deskewed ImageData containing only the MRZ region. */
  crop: ImageData;
  /**
   * Corners of the MRZ region in original frame pixel coordinates.
   * Order: [topLeft, topRight, bottomRight, bottomLeft].
   */
  corners: [Point, Point, Point, Point];
  /** Counter-clockwise rotation angle of the document in degrees. */
  angle: number;
  /**
   * How cleanly the MRZ region was isolated (0–1).
   * Derived from blob aspect ratio and inter-line consistency.
   */
  confidence: number;
}

/**
 * The MRZ region as located in the original video frame.
 * Forwarded to the `onDetected` callback so the host UI can draw overlays.
 */
export interface DetectedRegion {
  /**
   * Corners of the MRZ region in video pixel coordinates.
   * Order: [topLeft, topRight, bottomRight, bottomLeft].
   */
  corners: [Point, Point, Point, Point];
  /** Counter-clockwise rotation angle of the document in degrees. */
  angle: number;
  /** Width of the MRZ crop in pixels (in the original frame). */
  width: number;
  /** Height of the MRZ crop in pixels (in the original frame). */
  height: number;
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

/**
 * Output of `MRZRecognizer.recognize()`.
 * Contains the raw character string lines and per-character confidence scores.
 */
export interface RecognitionResult {
  /**
   * Recognized MRZ lines, one string per line.
   * Example for TD3: two 44-character strings.
   */
  lines: string[];
  /**
   * Softmax probability of the winning class for each character, indexed as
   * `charConfidences[lineIndex][charIndex]`. Values are in the range [0, 1].
   */
  charConfidences: number[][];
  /** Arithmetic mean of all per-character confidence values across all lines. */
  meanConfidence: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Structured fields extracted from a parsed MRZ.
 * All fields are `null` when the corresponding MRZ field could not be read or
 * the format does not define that field.
 */
export interface MRZFields {
  /** Single-letter document type indicator (e.g. `"P"` for passport). */
  documentType: string | null;
  /** Document subtype / issuing authority code (second char of line 1). */
  documentSubtype: string | null;
  /** 3-letter ICAO country code of the issuing state. */
  issuingState: string | null;
  /** Primary identifier (surname), filler `<` replaced with space. */
  surname: string | null;
  /** Secondary identifiers (given names), filler `<` replaced with space. */
  givenNames: string | null;
  /** Document number, up to 9 alphanumeric characters. */
  documentNumber: string | null;
  /** 3-letter ICAO nationality code of the holder. */
  nationality: string | null;
  /** Date of birth in `YYYY-MM-DD` format. */
  dateOfBirth: string | null;
  /** Biological or administrative sex of the holder. */
  sex: 'male' | 'female' | 'neutral' | null;
  /** Document expiry date in `YYYY-MM-DD` format. */
  expiryDate: string | null;
  /** Optional data field (line 2 of TD3/TD2, line 3 pos 1–26 of TD1). */
  optionalData: string | null;
  /** Second optional data field, present in TD1 documents only. */
  optionalData2: string | null;
  /**
   * Composite check digit covering multiple fields.
   * Present in TD3 and MRV-A; `null` for other formats.
   */
  compositeCheckDigit: string | null;
}

/**
 * Fully parsed and validated MRZ result, emitted via `onResult`.
 */
export interface MRZResult {
  /** Detected MRZ format. */
  format: MRZFormat;
  /**
   * `true` if all ICAO 9303 check digits are valid and the document number
   * passes format validation.
   */
  valid: boolean;
  /** Structured field values extracted from the MRZ. */
  fields: MRZFields;
  /**
   * Per-field validation details as returned by the `mrz` npm package.
   * Includes raw range positions for each field in the MRZ string.
   */
  details: Array<{
    /** Name of the MRZ field. */
    field: string;
    /** Parsed value of the field (may be `null` for filler-only fields). */
    value: string | null;
    /** Whether the field's check digit is valid (if applicable). */
    valid: boolean;
    /** Byte ranges within the raw MRZ lines that make up this field. */
    ranges: Array<{ line: number; start: number; end: number }>;
  }>;
  /** Raw MRZ lines exactly as recognized by the OCR stage. */
  raw: string[];
  /**
   * Average character-level softmax confidence across all MRZ characters
   * (0–1). Reflects recognition quality, not parse validity.
   */
  confidence: number;
  /** Wall-clock time in milliseconds spent processing this frame end-to-end. */
  processingTimeMs: number;
}

// ---------------------------------------------------------------------------
// Worker bridge
// ---------------------------------------------------------------------------

/**
 * Value returned by `MRZPipeline.processFrame()` and forwarded from the
 * Web Worker to the main thread after each frame is processed.
 */
export interface WorkerFrameResult {
  /**
   * Parsed MRZ result if the OCR and parse stages succeeded, otherwise `null`.
   * A non-null value does not guarantee `result.valid === true`; confidence
   * filtering happens on the main thread via `ConfidenceBuffer`.
   */
  result: MRZResult | null;
  /**
   * Detected MRZ region in frame coordinates if the detection stage located
   * the MRZ, otherwise `null`. Always set before OCR runs; can be non-null
   * even when `result` is `null` (e.g. detection succeeded, OCR failed).
   */
  region: DetectedRegion | null;
  /** Wall-clock time in milliseconds the Worker spent on this frame. */
  processingTimeMs: number;
}

// ---------------------------------------------------------------------------
// Scanner options
// ---------------------------------------------------------------------------

/**
 * Constructor options for `MRZScanner`.
 * `onResult` is the only required field; everything else has a sensible
 * default defined in `MRZScanner`.
 */
export interface MRZScannerOptions {
  /** Called every time a high-confidence, validated MRZ result is ready. */
  onResult: (result: MRZResult) => void;
  /** Called on both fatal and non-fatal errors. Non-fatal errors do not stop scanning. */
  onError?: (error: Error) => void;
  /**
   * Called as soon as the MRZ region is visually located in the frame,
   * before OCR completes. Use this to draw a bounding-box overlay.
   */
  onDetected?: (region: DetectedRegion) => void;
  /**
   * Called with `true` when a frame starts processing and `false` when it
   * finishes. Use this to drive a loading indicator.
   */
  onProcessing?: (isProcessing: boolean) => void;
  /**
   * Maximum number of frames to process per second. Frames that arrive while
   * the Worker is busy are silently dropped.
   * @default 8
   */
  frameRate?: number;
  /**
   * Minimum mean character confidence required before a result enters the
   * voting buffer. Results below this threshold are discarded.
   * @default 0.85
   */
  confidenceThreshold?: number;
  /**
   * Number of consecutive frames that must agree on the document number
   * before a result is emitted. Prevents emission of noisy partial reads.
   * @default 3
   */
  votingFrames?: number;
  /**
   * URL to the `mrz-ocr.onnx` model file.
   * When omitted the scanner uses the URL of the bundled model asset.
   */
  modelUrl?: string;
  /**
   * URL to the compiled Worker script (`mrz.worker.js`).
   * Required when using bundlers that cannot automatically resolve Worker
   * URLs (e.g. Webpack 4, certain Vite configurations).
   */
  workerUrl?: string;
  /**
   * Base URL from which `onnxruntime-web` loads its `.wasm` files.
   * When omitted, the library points to the version-matched `onnxruntime-web`
   * package in `node_modules` — this only works if the user serves
   * `node_modules` statically, which most bundlers do not. Provide an explicit
   * path (e.g. `"/assets/"`) or a CDN prefix in production.
   */
  ortWasmPath?: string;
  /**
   * Full URL to a browser-loadable ESM build of `onnxruntime-web`.
   * Required when running the bundled Worker without a bundler (e.g. demo /
   * CDN usage), because Web Workers do not inherit the host document's
   * importmap and the bare `'onnxruntime-web'` specifier in the Worker bundle
   * cannot be resolved otherwise.
   *
   * Example: `"https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/+esm"`
   */
  ortUrl?: string;
  /**
   * Restrict which MRZ document formats are accepted.
   * Results whose format is not in this list are silently discarded.
   * @default ['TD1', 'TD2', 'TD3', 'MRV-A', 'MRV-B']
   */
  formats?: MRZFormat[];
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/**
 * Machine-readable error codes used by `MRZError`.
 *
 * - `MODEL_LOAD_FAILED`     — ONNX model file could not be fetched or parsed.
 * - `WORKER_INIT_FAILED`    — Web Worker could not be spawned.
 * - `CAMERA_ACCESS_DENIED`  — `getUserMedia` was rejected by the browser.
 * - `DETECTION_FAILED`      — Unexpected exception in the morphological detection stage.
 * - `OCR_FAILED`            — Unexpected exception during ONNX inference.
 * - `INVALID_FORMAT`        — MRZ region found but does not match any known ICAO format.
 * - `BROWSER_NOT_SUPPORTED` — A required browser API is missing (e.g. no WebAssembly).
 */
export type MRZErrorCode =
  | 'MODEL_LOAD_FAILED'
  | 'WORKER_INIT_FAILED'
  | 'CAMERA_ACCESS_DENIED'
  | 'DETECTION_FAILED'
  | 'OCR_FAILED'
  | 'INVALID_FORMAT'
  | 'BROWSER_NOT_SUPPORTED';

/**
 * Typed error class used throughout the library.
 * All errors surfaced via `onError` are instances of this class so consumers
 * can switch on `error.code` without string-matching the message.
 */
export class MRZError extends Error {
  /** Machine-readable error code — use this for programmatic error handling. */
  public readonly code: MRZErrorCode;
  /** The underlying cause (exception, response, or other value) if available. */
  public readonly cause: unknown;

  constructor(message: string, code: MRZErrorCode, cause?: unknown) {
    super(message);
    this.name = 'MRZError';
    this.code = code;
    this.cause = cause;
  }
}
