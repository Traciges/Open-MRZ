export interface SchedulerStats {
  processedFrames: number;
  droppedFrames: number;
}

/**
 * Frame-rate limiter and in-flight guard for the processing pipeline.
 *
 * Call `shouldProcess(now)` on each incoming frame. If it returns true,
 * call `markStart(now)` before processing and `markDone()` when finished.
 * Frames are dropped when the worker is still busy OR when the target
 * inter-frame interval has not elapsed.
 */
export class Scheduler {
  private lastProcessedAt = -Infinity;
  private processing = false;
  private _stats: SchedulerStats = { processedFrames: 0, droppedFrames: 0 };

  constructor(private readonly targetFps: number = 8) {}

  /**
   * Returns true if a frame arriving at `now` should be processed.
   * Increments `droppedFrames` and returns false when the frame should be
   * skipped (worker busy or FPS cap exceeded).
   */
  shouldProcess(now: number = performance.now()): boolean {
    const minIntervalMs = 1000 / this.targetFps;
    if (this.processing || now - this.lastProcessedAt < minIntervalMs) {
      this._stats.droppedFrames++;
      return false;
    }
    return true;
  }

  /** Record that processing of a frame has started. */
  markStart(now: number = performance.now()): void {
    this.lastProcessedAt = now;
    this.processing = true;
    this._stats.processedFrames++;
  }

  /** Record that the current frame has finished processing. */
  markDone(): void {
    this.processing = false;
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  getStats(): Readonly<SchedulerStats> {
    return { ...this._stats };
  }

  reset(): void {
    this.lastProcessedAt = -Infinity;
    this.processing = false;
    this._stats = { processedFrames: 0, droppedFrames: 0 };
  }
}
