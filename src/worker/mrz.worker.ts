import * as Comlink from 'comlink';
import { MRZPipeline } from '../pipeline/MRZPipeline.js';
import type { MRZFormat, WorkerFrameResult } from '../types.js';

const pipeline = new MRZPipeline();

const api = {
  async init(modelUrl: string, formats: MRZFormat[], wasmPath?: string): Promise<void> {
    await pipeline.init(modelUrl, formats, wasmPath);
  },

  async processFrame(bitmap: ImageBitmap): Promise<WorkerFrameResult> {
    try {
      return await pipeline.processFrame(bitmap);
    } catch (err) {
      bitmap.close();
      return { result: null, region: null, processingTimeMs: 0 };
    }
  },

  destroy(): void {
    pipeline.destroy();
  },
};

export type WorkerAPI = typeof api;

Comlink.expose(api);
