import * as Comlink from 'comlink';
import type { WorkerAPI } from './mrz.worker.js';

export type { WorkerAPI };

export function createWorkerProxy(workerUrl: string): Comlink.Remote<WorkerAPI> {
  const worker = new Worker(workerUrl, { type: 'module' });
  return Comlink.wrap<WorkerAPI>(worker);
}
