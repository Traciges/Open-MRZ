import { defineConfig, build as viteBuild } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

/**
 * After the main library build, rebuild the worker as a single-entry bundle so
 * Rollup has no reason to code-split comlink into a separate chunk.  Workers
 * don't inherit import maps, so comlink must be inlined rather than left as a
 * bare specifier or a hash-named sibling chunk.
 */
function inlineWorkerPlugin() {
  let built = false;
  return {
    name: 'inline-worker-comlink',
    apply: 'build' as const,
    async closeBundle() {
      if (built) return;
      built = true;
      await viteBuild({
        configFile: false,
        logLevel: 'warn',
        build: {
          lib: {
            entry: resolve(__dirname, 'src/worker/mrz.worker.ts'),
            formats: ['es', 'cjs'],
            fileName: 'mrz.worker',
          },
          outDir: resolve(__dirname, 'dist'),
          emptyOutDir: false,
          // Only onnxruntime-web stays external (dynamic import at inference time,
          // too large to bundle). comlink and mrz are static imports → inline both
          // so the worker has zero bare specifiers at load time.
          rollupOptions: {
            external: ['onnxruntime-web'],
          },
        },
      });
    },
  };
}

export default defineConfig({
  plugins: [
    dts({ insertTypesEntry: true }),
    inlineWorkerPlugin(),
  ],
  build: {
    lib: {
      // Worker is built separately by inlineWorkerPlugin — only main entry here
      entry: {
        'open-mrz': resolve(__dirname, 'src/index.ts'),
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
