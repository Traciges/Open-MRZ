import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    dts({ insertTypesEntry: true })
  ],
  build: {
    lib: {
      entry: {
        'open-mrz': resolve(__dirname, 'src/index.ts'),
        'mrz.worker': resolve(__dirname, 'src/worker/mrz.worker.ts'),
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['onnxruntime-web', 'comlink', 'mrz'],
      output: {
        globals: {}
      }
    },
    // Do NOT inline the ONNX model — it's loaded via URL at runtime
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  }
});
