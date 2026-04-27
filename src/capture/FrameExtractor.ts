/**
 * Extracts frames from a `<video>` element at a configurable rate and
 * delivers each frame as a zero-copy `ImageBitmap` to the provided callback.
 *
 * All heavy work (canvas draw + bitmap creation) happens synchronously on the
 * main thread inside the rAF callback, but the resulting bitmap is handed off
 * to a Web Worker via `postMessage` with a transfer list so no pixel data is
 * ever copied between threads.
 *
 * ## iOS / Safari compatibility
 * - `OffscreenCanvas` + `transferToImageBitmap()` is used when available
 *   (Safari 17+, Chrome 69+, Firefox 105+).
 * - On older iOS Safari the code falls back to a regular `<canvas>` plus
 *   `createImageBitmap()`, which performs a copy but is functionally correct.
 *
 * @example
 * ```ts
 * // --- production ---
 * const extractor = new FrameExtractor(videoEl, (bitmap, w, h) => {
 *   worker.postMessage({ bitmap, w, h }, [bitmap]);
 * }, 8);
 * extractor.start();
 * // later:
 * extractor.destroy();
 *
 * // --- test harness (no real video needed) ---
 * // Replace the internal _drawFrame method to inject synthetic ImageData:
 * //
 * // const extractor = new FrameExtractor(fakeVideo, onFrame, 8);
 * // (extractor as any)._drawFrame = () => {
 * //   const bmp = createImageBitmap(syntheticCanvas);
 * //   onFrame(await bmp, syntheticCanvas.width, syntheticCanvas.height);
 * // };
 * ```
 */
export class FrameExtractor {
  private rafId: number | null = null;
  private lastFrameAt = -Infinity;
  private processing = false;

  /** Off-screen surface reused across frames to avoid repeated allocation. */
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  /**
   * @param video     The `<video>` element whose frames should be extracted.
   *                  Must have an active `srcObject` (MediaStream) and be
   *                  playing before `start()` is called.
   * @param onFrame   Callback invoked with each captured frame. The caller
   *                  takes ownership of the `ImageBitmap` and must either
   *                  transfer or close it.
   * @param targetFps Maximum frames per second to deliver. Frames that arrive
   *                  while `isProcessing` is true are silently skipped.
   *                  Default: 8.
   */
  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onFrame: (bitmap: ImageBitmap, width: number, height: number) => void,
    private readonly targetFps: number = 8,
  ) {}

  /** Begin the rAF loop. Safe to call multiple times (idempotent). */
  start(): void {
    if (this.rafId !== null) return;
    this.scheduleNext();
  }

  /**
   * Pause frame extraction. The rAF loop is cancelled; the canvas surface is
   * kept so `start()` can resume without re-allocation.
   */
  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Stop extraction and release all resources. The instance must not be used
   * after `destroy()`.
   */
  destroy(): void {
    this.stop();
    this.canvas = null;
    this.ctx = null;
  }

  /**
   * Mark the consumer as idle. Call this after the Worker has finished
   * processing the last delivered frame so the next eligible frame is not
   * skipped due to the `isProcessing` guard.
   */
  markDone(): void {
    this.processing = false;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private scheduleNext(): void {
    this.rafId = requestAnimationFrame((now) => {
      this.rafId = null;
      this.tick(now);
      // Re-schedule regardless of whether this tick did work
      this.scheduleNext();
    });
  }

  private tick(now: number): void {
    const minIntervalMs = 1000 / this.targetFps;
    if (this.processing || now - this.lastFrameAt < minIntervalMs) return;

    // Ensure the video has pixel data to draw
    if (this.video.readyState < 2 /* HAVE_CURRENT_DATA */) return;

    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (w === 0 || h === 0) return;

    this.lastFrameAt = now;
    this.processing = true;

    this._captureFrame(w, h);
  }

  /** Separated so tests can override without touching rAF logic. */
  private _captureFrame(w: number, h: number): void {
    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        this.captureOffscreen(w, h);
      } else {
        void this.captureFallback(w, h);
      }
    } catch {
      // Any capture failure should not kill the rAF loop
      this.processing = false;
    }
  }

  /** Zero-copy path: OffscreenCanvas + transferToImageBitmap (Safari 17+). */
  private captureOffscreen(w: number, h: number): void {
    if (
      this.canvas === null ||
      !(this.canvas instanceof OffscreenCanvas) ||
      this.canvas.width !== w ||
      this.canvas.height !== h
    ) {
      this.canvas = new OffscreenCanvas(w, h);
      this.ctx = this.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    }

    const ctx = this.ctx as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(this.video, 0, 0, w, h);
    const bitmap = (this.canvas as OffscreenCanvas).transferToImageBitmap();
    // canvas is now neutered — reset so we recreate on next tick
    this.canvas = null;
    this.ctx = null;

    this.onFrame(bitmap, w, h);
    // Caller owns the bitmap; processing flag is cleared by markDone()
  }

  /** Copy path: regular canvas + createImageBitmap (older iOS Safari). */
  private async captureFallback(w: number, h: number): Promise<void> {
    if (
      this.canvas === null ||
      this.canvas instanceof OffscreenCanvas ||
      this.canvas.width !== w ||
      this.canvas.height !== h
    ) {
      const el = document.createElement('canvas');
      el.width = w;
      el.height = h;
      this.canvas = el;
      this.ctx = el.getContext('2d');
    }

    const ctx = this.ctx as CanvasRenderingContext2D;
    ctx.drawImage(this.video, 0, 0, w, h);

    try {
      const bitmap = await createImageBitmap(this.canvas as HTMLCanvasElement);
      this.onFrame(bitmap, w, h);
    } finally {
      this.processing = false;
    }
  }
}
