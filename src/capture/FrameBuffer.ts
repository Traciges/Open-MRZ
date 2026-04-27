/**
 * Two-slot ring buffer for `ImageBitmap` frames.
 *
 * Holds at most one pending frame at a time. When a new frame is pushed while
 * a previous one is still sitting in the slot, the stale bitmap is closed
 * immediately to release GPU/memory resources (zero leaked bitmaps).
 *
 * @example
 * ```ts
 * const buf = new FrameBuffer();
 * buf.push(newBitmap);        // older bitmap, if any, is closed here
 * const bmp = buf.take();     // null if nothing pending
 * if (bmp) { worker.postMessage({ bmp }, [bmp]); }
 * ```
 */
export class FrameBuffer {
  private pending: ImageBitmap | null = null;

  /**
   * Store a new frame. If a frame from the previous tick was never consumed,
   * it is closed before being replaced.
   */
  push(bitmap: ImageBitmap): void {
    if (this.pending !== null) {
      this.pending.close();
    }
    this.pending = bitmap;
  }

  /**
   * Retrieve and clear the pending frame. Returns `null` when the buffer is
   * empty (i.e. no frame arrived since the last `take()`).
   */
  take(): ImageBitmap | null {
    const bmp = this.pending;
    this.pending = null;
    return bmp;
  }

  /**
   * Close any pending frame and reset to empty. Call during teardown to
   * guarantee no bitmap is left dangling.
   */
  destroy(): void {
    if (this.pending !== null) {
      this.pending.close();
      this.pending = null;
    }
  }
}
