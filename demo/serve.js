import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 3000;

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.cjs':   'application/javascript; charset=utf-8',
  '.ts':    'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json; charset=utf-8',
  '.wasm':  'application/wasm',
  '.onnx':  'application/octet-stream',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
};

// COOP + COEP are required for SharedArrayBuffer (used by onnxruntime-web)
const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy':   'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let filePath = path.join(ROOT, url.pathname);

  // Serve index.html for bare directory requests
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // will 404 below
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`404 Not Found: ${url.pathname}`);
      return;
    }

    res.writeHead(200, {
      'Content-Type':   mime,
      'Content-Length': data.byteLength,
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Open-MRZ demo  →  http://localhost:${PORT}/demo/`);
  console.log('Ctrl+C to stop.');
});
