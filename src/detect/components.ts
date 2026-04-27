// Connected-component labelling via union-find, row-by-row 4-connectivity sweep.

export interface BoundingBox {
  x: number; y: number; w: number; h: number;
}

export interface Blob {
  label: number;
  pixelCount: number;
  boundingBox: BoundingBox;
  // Pixel indices in the source image (used for PCA in geometry.ts)
  pixels: number[];
}

function makeUnionFind(n: number): { parent: Int32Array; rank: Uint8Array } {
  const parent = new Int32Array(n);
  const rank = new Uint8Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  return { parent, rank };
}

function find(parent: Int32Array, x: number): number {
  while (parent[x] !== x) {
    // Path compression
    const px = parent[x] ?? x;
    parent[x] = parent[px] ?? px;
    x = parent[x] ?? x;
  }
  return x;
}

function union(parent: Int32Array, rank: Uint8Array, a: number, b: number): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra === rb) return;
  if ((rank[ra] ?? 0) < (rank[rb] ?? 0)) {
    parent[ra] = rb;
  } else if ((rank[ra] ?? 0) > (rank[rb] ?? 0)) {
    parent[rb] = ra;
  } else {
    parent[rb] = ra;
    rank[ra] = (rank[ra] ?? 0) + 1;
  }
}

export function labelComponents(binary: Uint8Array, w: number, h: number): Blob[] {
  const { parent, rank } = makeUnionFind(binary.length);

  // First pass: assign provisional labels via union-find
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if ((binary[idx] ?? 0) === 0) continue;

      const left = x > 0 ? idx - 1 : -1;
      const above = y > 0 ? idx - w : -1;

      if (left >= 0 && (binary[left] ?? 0) !== 0) union(parent, rank, idx, left);
      if (above >= 0 && (binary[above] ?? 0) !== 0) union(parent, rank, idx, above);
    }
  }

  // Second pass: collect blobs by root label
  const blobMap = new Map<number, Blob>();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if ((binary[idx] ?? 0) === 0) continue;

      const root = find(parent, idx);
      let blob = blobMap.get(root);
      if (blob === undefined) {
        blob = {
          label: root,
          pixelCount: 0,
          boundingBox: { x, y, w: 0, h: 0 },
          pixels: [],
        };
        blobMap.set(root, blob);
      }

      blob.pixelCount++;
      blob.pixels.push(idx);

      const bb = blob.boundingBox;
      if (x < bb.x) bb.x = x;
      if (y < bb.y) bb.y = y;
      const maxX = bb.x + bb.w;
      const maxY = bb.y + bb.h;
      if (x > maxX) bb.w = x - bb.x;
      if (y > maxY) bb.h = y - bb.y;
    }
  }

  return Array.from(blobMap.values());
}
