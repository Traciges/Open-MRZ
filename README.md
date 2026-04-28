# Open-MRZ

Browser-first MRZ detection, OCR, and parsing from a live `MediaStream`. All processing runs on-device via a Web Worker and a small ONNX CNN (~300 KB). No server, no API key, no licensing fee - MIT license.

---

## Quick Start

```html
<video id="cam" autoplay playsinline muted></video>
```

```javascript
import { MRZScanner } from 'open-mrz';

const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
  .catch(() => navigator.mediaDevices.getUserMedia({ video: true }));

const video = document.getElementById('cam');
video.srcObject = stream;
await video.play();

const scanner = new MRZScanner({
  ortWasmPath: '/assets/ort-wasm/',   // see §WASM Configuration below
  onResult: (result) => {
    console.log(result.fields.surname, result.fields.documentNumber);
    console.log('valid:', result.valid, 'confidence:', result.confidence);
  },
});

await scanner.init();
scanner.attach(video);
scanner.start();
```

---

## Installation

```bash
npm install open-mrz
# or
pnpm add open-mrz
```

Install peer dependencies (exact ranges intentional):

```bash
npm install onnxruntime-web@^1.24.3 comlink@^4.4.2 mrz@^5.0.2
```

All three are required at runtime. They are not bundled into `open-mrz` - see below.

---

## WASM Configuration

> **This is the most common source of integration issues. Read carefully.**

`onnxruntime-web` ships `.wasm` binary files alongside its JavaScript. These files must be served statically and cannot be inlined into your JS bundle. For this reason, `onnxruntime-web` is a peer dependency rather than a bundled dependency.

### Option A - Copy wasm files to your public directory (recommended)

Copy the `.wasm` files from `node_modules/onnxruntime-web/dist/` to a directory your server serves statically, then pass the path via `ortWasmPath`:

```javascript
const scanner = new MRZScanner({
  ortWasmPath: '/assets/ort-wasm/',  // trailing slash required
  onResult: (r) => { /* ... */ },
});
```

With Vite, you can automate the copy in `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';

export default defineConfig({
  plugins: [{
    name: 'copy-ort-wasm',
    buildStart() {
      const src = resolve('node_modules/onnxruntime-web/dist');
      const dest = resolve('public/assets/ort-wasm');
      fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(src).filter(n => n.endsWith('.wasm'))) {
        fs.copyFileSync(`${src}/${f}`, `${dest}/${f}`);
      }
    }
  }]
});
```

### Option B - CDN (prototyping only, not for production)

```javascript
const scanner = new MRZScanner({
  ortWasmPath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/',
  onResult: (r) => { /* ... */ },
});
```

> **Do not use Option B in production.** It creates a hard dependency on a third-party CDN and will fail in offline scenarios or strict CSP environments.

### MIME type

Your server must serve `.wasm` files with MIME type `application/wasm`. Most web servers do this automatically. If you see a console error about incorrect MIME type:

- **Nginx**: add `application/wasm wasm;` to your `mime.types` file
- **Express**: add `express.static('public', { setHeaders: (res, p) => { if (p.endsWith('.wasm')) res.set('Content-Type', 'application/wasm'); } })`

---

## Required HTTP Headers

WASM multi-threading requires `SharedArrayBuffer`, which in turn requires two HTTP response headers on every page that loads `open-mrz`:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If these headers are absent, `open-mrz` automatically falls back to single-threaded WASM. OCR is slower (roughly 2–3×) but the library will not crash.

### Vite dev server

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
```

### Express / Node

```javascript
app.use((req, res, next) => {
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
```

### Nginx

```nginx
add_header Cross-Origin-Opener-Policy "same-origin";
add_header Cross-Origin-Embedder-Policy "require-corp";
```

### Netlify (`public/_headers`)

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

---

## Camera Setup for iPhone

iOS Safari silently ignores unknown constraints rather than throwing. Use `ideal` instead of `exact` for `facingMode` to avoid errors on devices with only a front camera.

Always require HTTPS - `getUserMedia` is blocked on non-secure origins on all modern browsers.

```javascript
async function openCamera() {
  // Preferred: rear camera, high resolution
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },  // ideal, not exact
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  }).catch(() =>
    // Fallback: accept any video track
    navigator.mediaDevices.getUserMedia({ video: true })
  );
  return stream;
}
```

The `<video>` element must have `playsinline` on iOS, otherwise Safari plays the video fullscreen and the page cannot access frames:

```html
<video autoplay playsinline muted></video>
```

---

## API Reference

### `MRZScanner` constructor options

| Option | Type | Default | Description |
|---|---|---|---|
| `onResult` | `(result: MRZResult) => void` | **required** | Called when a high-confidence, validated result is ready. |
| `onError` | `(error: Error) => void` | `undefined` | Called for both fatal and non-fatal errors. |
| `onDetected` | `(region: DetectedRegion) => void` | `undefined` | Called when the MRZ region is located visually, before OCR. Use to draw a bounding-box overlay. |
| `onProcessing` | `(isProcessing: boolean) => void` | `undefined` | Called with `true` at the start of each frame and `false` when done. |
| `frameRate` | `number` | `8` | Maximum frames per second to process. Frames arriving while the Worker is busy are dropped. |
| `confidenceThreshold` | `number` | `0.85` | Minimum mean character confidence (0–1) required to enter the voting buffer. |
| `votingFrames` | `number` | `3` | Number of consecutive frames that must agree on the document number before a result is emitted. |
| `modelUrl` | `string` | bundled | Override the URL to the `mrz-cnn.onnx` model file. |
| `workerUrl` | `string` | bundled | Override the URL to the compiled Worker script. Required with some bundler setups. |
| `ortWasmPath` | `string` | `undefined` | Base URL for `onnxruntime-web` WASM files. **Must be set in production.** |
| `formats` | `MRZFormat[]` | all formats | Restrict which ICAO formats are accepted. Results in other formats are discarded. |

### `MRZScanner` methods

| Method | Signature | Description |
|---|---|---|
| `init` | `() => Promise<void>` | Load the ONNX model and spawn the Web Worker. Call once before anything else. |
| `attach` | `(video: HTMLVideoElement) => void` | Attach to an existing `<video>` element with an active `srcObject`. |
| `setStream` | `(stream: MediaStream, dims?: { width, height }) => void` | Attach using a raw `MediaStream`. Creates a hidden `<video>` internally. |
| `start` | `() => void` | Begin frame extraction and processing. |
| `stop` | `() => void` | Pause processing. Worker and model remain loaded; call `start()` to resume. |
| `detach` | `() => void` | Release the video reference. Call before `destroy()` or when switching streams. |
| `destroy` | `() => Promise<void>` | Terminate the Worker, unload the model, and free all resources. |
| `MRZScanner.scanImage` | `(source, options?) => Promise<MRZResult \| null>` | One-shot scan from an image file, blob, URL, or `ImageData`. Does not require a running instance. `modelUrl` is required in options. |

### `MRZResult`

| Field | Type | Description |
|---|---|---|
| `format` | `MRZFormat` | Detected document format. |
| `valid` | `boolean` | `true` if all ICAO 9303 check digits pass. |
| `fields` | `MRZFields` | Structured field values (see below). |
| `details` | `Array<{ field, value, valid, ranges }>` | Per-field validation details from the `mrz` package. |
| `raw` | `string[]` | Raw MRZ lines as recognized by OCR. |
| `confidence` | `number` | Mean per-character softmax confidence (0–1). |
| `processingTimeMs` | `number` | Wall-clock time for this frame, end-to-end. |

### `MRZFields`

| Field | Type | Notes |
|---|---|---|
| `documentType` | `string \| null` | Single-letter type indicator, e.g. `"P"` for passport. |
| `documentSubtype` | `string \| null` | Second character of line 1. |
| `issuingState` | `string \| null` | 3-letter ICAO country code. |
| `surname` | `string \| null` | Primary identifier; `<` replaced with space. |
| `givenNames` | `string \| null` | Secondary identifiers; `<` replaced with space. |
| `documentNumber` | `string \| null` | Up to 9 alphanumeric characters. |
| `nationality` | `string \| null` | 3-letter ICAO nationality code. |
| `dateOfBirth` | `string \| null` | `YYYY-MM-DD` |
| `sex` | `'male' \| 'female' \| 'neutral' \| null` | |
| `expiryDate` | `string \| null` | `YYYY-MM-DD` |
| `optionalData` | `string \| null` | Optional data field (format-dependent). |
| `optionalData2` | `string \| null` | Second optional field; TD1 only. |
| `compositeCheckDigit` | `string \| null` | Present in TD3 and MRV-A. |

### `MRZFormat`

| Value | Document type | Lines × chars |
|---|---|---|
| `TD1` | ID card (credit-card size) | 3 × 30 |
| `TD2` | Smaller travel document | 2 × 36 |
| `TD3` | Passport booklet | 2 × 44 |
| `MRV-A` | Visa (same size as TD3) | 2 × 44 |
| `MRV-B` | Visa (same size as TD2) | 2 × 36 |

### `MRZError`

All errors passed to `onError` are instances of `MRZError`. Use `error.code` for programmatic handling:

| Code | Meaning | Fatal? |
|---|---|---|
| `MODEL_LOAD_FAILED` | ONNX model could not be fetched or parsed. | Yes |
| `WORKER_INIT_FAILED` | Web Worker could not be spawned. | Yes |
| `CAMERA_ACCESS_DENIED` | `getUserMedia` was rejected. | Yes |
| `DETECTION_FAILED` | Unexpected exception in the morphological detection stage. | No |
| `OCR_FAILED` | Unexpected exception during ONNX inference. | No |
| `INVALID_FORMAT` | MRZ region found but matches no known ICAO format. | No |
| `BROWSER_NOT_SUPPORTED` | A required API is missing (e.g. no WebAssembly). | Yes |

---

## Framework Examples

### React

```tsx
import { useEffect, useRef } from 'react';
import { MRZScanner, type MRZResult } from 'open-mrz';

export function useScanner(videoRef: React.RefObject<HTMLVideoElement>, onResult: (r: MRZResult) => void) {
  useEffect(() => {
    const scanner = new MRZScanner({
      ortWasmPath: '/assets/ort-wasm/',
      onResult,
      onError: console.error,
    });

    let active = true;
    scanner.init().then(() => {
      if (!active || !videoRef.current) return;
      scanner.attach(videoRef.current);
      scanner.start();
    });

    return () => {
      active = false;
      scanner.stop();
      scanner.detach();
      void scanner.destroy();
    };
  }, []);
}
```

### Vue

```typescript
import { onMounted, onUnmounted, type Ref } from 'vue';
import { MRZScanner, type MRZResult } from 'open-mrz';

export function useScanner(videoRef: Ref<HTMLVideoElement | null>, onResult: (r: MRZResult) => void) {
  let scanner: MRZScanner;

  onMounted(async () => {
    scanner = new MRZScanner({ ortWasmPath: '/assets/ort-wasm/', onResult });
    await scanner.init();
    if (videoRef.value) {
      scanner.attach(videoRef.value);
      scanner.start();
    }
  });

  onUnmounted(() => {
    scanner.stop();
    scanner.detach();
    void scanner.destroy();
  });
}
```

### Angular

```typescript
import { Injectable, OnDestroy } from '@angular/core';
import { MRZScanner, type MRZResult } from 'open-mrz';

@Injectable({ providedIn: 'root' })
export class MrzScannerService implements OnDestroy {
  private scanner: MRZScanner | null = null;

  async start(video: HTMLVideoElement, onResult: (r: MRZResult) => void): Promise<void> {
    this.scanner = new MRZScanner({ ortWasmPath: '/assets/ort-wasm/', onResult });
    await this.scanner.init();
    this.scanner.attach(video);
    this.scanner.start();
  }

  ngOnDestroy(): void {
    this.scanner?.stop();
    this.scanner?.detach();
    void this.scanner?.destroy();
  }
}
```

---

## Troubleshooting

| Problem | Cause | Solution |
|---|---|---|
| `TypeError: WebAssembly.instantiate` / WASM not loading | Wrong `ortWasmPath` or files not copied | Verify files exist at the path and that the server returns `Content-Type: application/wasm`. |
| WASM files return 404 | `onnxruntime-web` `.wasm` files not served statically | Copy files from `node_modules/onnxruntime-web/dist/*.wasm` to your public directory. |
| `onResult` is never called | `votingFrames` consensus not reached, or `confidence` always below `confidenceThreshold` | Lower `confidenceThreshold` to `0.7` temporarily to diagnose. Check lighting - MRZ needs even illumination without glare. |
| `onResult` is never called (2) | MRZ region not detected in frame | Ensure the document is held flat, fills at least 30% of the frame width, and is not motion-blurred. |
| iOS Safari: inference is single-threaded and slow | `SharedArrayBuffer` unavailable - missing COOP/COEP headers | Add `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. |
| Camera permission denied / black video | Page is served over HTTP, not HTTPS | `getUserMedia` requires a secure origin (HTTPS or `localhost`). |
| Worker fails to spawn | CSP blocks `blob:` or `worker-src` | Add `worker-src 'self' blob:` to your `Content-Security-Policy` header. |
| `result.valid === false` but MRZ looks correct | Issuing state or nationality code not in ICAO list | The `mrz` package validates country codes. Check `result.details` for which field failed. Raw lines are in `result.raw`. |
| `MODEL_LOAD_FAILED` error | Model URL unreachable or wrong | Check the `modelUrl` option or the default asset URL in the network tab. |

---

## Privacy

All image processing, OCR, and MRZ parsing runs entirely on-device inside a Web Worker. No video frames, no character data, and no parsed results are transmitted to any server.
