#!/usr/bin/env node
// Generates contract-conformant FAKE assets (docs/CONTRACT.md) into web/public/fake-assets/
// so the web app can be developed without the real Python pipeline.
//
// Labels are "nearest anchor colour" (Voronoi cells in RGB), a couple of names get two
// anchors so that multi-component names exist. Meshes are extracted per connected
// component from a downsampled label grid as voxel-face surfaces, Taubin-smoothed
// (vertices on the cube faces stay on those faces) and given smooth vertex normals.
//
// Usage: node scripts/make-fake-assets.mjs [outDir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] ?? join(here, '..', 'public', 'fake-assets'));
const N = 256;
const N3 = N * N * N;

const LEVELS = [
  {
    id: 'basic',
    title: 'Basic (fake, 11 terms)',
    description: 'Fake data: nearest of 11 anchor colours, mesh at 64³.',
    meshRes: 64,
    anchors: [
      ['black', [15, 15, 20]], ['white', [245, 245, 245]], ['grey', [128, 128, 128]],
      ['red', [225, 25, 30]], ['orange', [250, 140, 20]], ['yellow', [240, 235, 40]],
      ['green', [40, 190, 40]], ['blue', [40, 60, 230]], ['purple', [130, 40, 180]],
      ['pink', [250, 120, 200]], ['brown', [120, 75, 30]],
    ],
  },
  {
    id: 'standard',
    title: 'Standard (fake, 16 terms)',
    description: 'Fake data: nearest of 18 anchors (some names twice), mesh at 128³.',
    meshRes: 128,
    anchors: [
      ['black', [10, 10, 15]], ['white', [248, 248, 248]], ['grey', [128, 128, 128]],
      ['red', [225, 25, 30]], ['orange', [250, 140, 20]], ['yellow', [240, 235, 40]],
      ['green', [40, 190, 40]], ['blue', [40, 60, 230]], ['purple', [130, 40, 180]],
      ['pink', [250, 120, 200]], ['brown', [120, 75, 30]], ['teal', [0, 140, 140]],
      ['cyan', [40, 235, 245]], ['dark green', [10, 80, 20]], ['navy blue', [10, 15, 100]],
      ['lime green', [150, 250, 40]],
      // second anchors for existing names -> multiple components per name
      ['pink', [255, 200, 240]], ['green', [60, 120, 90]],
    ],
  },
];
// a heavy level for performance testing (full-resolution voxel surfaces, ~2M triangles)
LEVELS.push({ ...LEVELS[1], id: 'dense', title: 'Dense (fake, perf test)', description: 'Fake data as Standard, mesh at full 256³ resolution (~2M triangles) for performance testing.', meshRes: 256 });

const MERGE_THRESHOLD = 50; // components smaller than this are merged into a neighbour

function nearestAnchorLabels(anchors, nameIndexOf) {
  const lab = new Uint8Array(N3);
  const A = anchors.map(([, c]) => c);
  const ni = anchors.map(([n]) => nameIndexOf.get(n));
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) {
    let i = N * g + N * N * b;
    for (let r = 0; r < N; r++, i++) {
      let best = 0, bd = Infinity;
      for (let a = 0; a < A.length; a++) {
        const dr = r - A[a][0], dg = (g - A[a][1]) * 1.2, db = (b - A[a][2]) * 0.8;
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = a; }
      }
      lab[i] = ni[best];
    }
  }
  return lab;
}

/** 6-connected components. Returns {comp:Int32Array, count, sizes:Int32Array}. */
function connectedComponents(lab) {
  const comp = new Int32Array(N3).fill(-1);
  const queue = new Int32Array(N3);
  const sizes = [];
  let count = 0;
  for (let s = 0; s < N3; s++) {
    if (comp[s] !== -1) continue;
    const L = lab[s];
    let head = 0, tail = 0;
    queue[tail++] = s; comp[s] = count;
    while (head < tail) {
      const i = queue[head++];
      const r = i & 255, g = (i >> 8) & 255, b = i >> 16;
      if (r > 0 && comp[i - 1] === -1 && lab[i - 1] === L) { comp[i - 1] = count; queue[tail++] = i - 1; }
      if (r < 255 && comp[i + 1] === -1 && lab[i + 1] === L) { comp[i + 1] = count; queue[tail++] = i + 1; }
      if (g > 0 && comp[i - 256] === -1 && lab[i - 256] === L) { comp[i - 256] = count; queue[tail++] = i - 256; }
      if (g < 255 && comp[i + 256] === -1 && lab[i + 256] === L) { comp[i + 256] = count; queue[tail++] = i + 256; }
      if (b > 0 && comp[i - 65536] === -1 && lab[i - 65536] === L) { comp[i - 65536] = count; queue[tail++] = i - 65536; }
      if (b < 255 && comp[i + 65536] === -1 && lab[i + 65536] === L) { comp[i + 65536] = count; queue[tail++] = i + 65536; }
    }
    sizes.push(tail);
    count++;
  }
  return { comp, count, sizes: Int32Array.from(sizes) };
}

function mergeTiny(lab) {
  for (let pass = 0; pass < 4; pass++) {
    const { comp, sizes } = connectedComponents(lab);
    let changed = 0;
    for (let i = 0; i < N3; i++) {
      if (sizes[comp[i]] >= MERGE_THRESHOLD) continue;
      const r = i & 255, g = (i >> 8) & 255, b = i >> 16;
      const nb = [];
      if (r > 0) nb.push(i - 1); if (r < 255) nb.push(i + 1);
      if (g > 0) nb.push(i - 256); if (g < 255) nb.push(i + 256);
      if (b > 0) nb.push(i - 65536); if (b < 255) nb.push(i + 65536);
      for (const j of nb) if (sizes[comp[j]] >= MERGE_THRESHOLD) { lab[i] = lab[j]; changed++; break; }
    }
    if (!changed) return;
  }
}

/** Extracts a smoothed closed surface for every component from a downsampled grid. */
function buildMeshes(compGrid, M, nComps, compBox) {
  const s = N / M;
  const M1 = M + 1;
  const vmap = new Int32Array(M1 * M1 * M1).fill(-1);
  const out = [];
  const cellAt = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= M || y >= M || z >= M) ? -2 : compGrid[x + M * y + M * M * z];
  // face definitions: direction, 4 corner offsets (as lattice offsets from the cell origin)
  const FACES = [
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ];
  for (let c = 0; c < nComps; c++) {
    const [lo, hi] = compBox[c];
    const x0 = Math.max(0, Math.floor(lo[0] / s) - 1), x1 = Math.min(M - 1, Math.ceil(hi[0] / s) + 1);
    const y0 = Math.max(0, Math.floor(lo[1] / s) - 1), y1 = Math.min(M - 1, Math.ceil(hi[1] / s) + 1);
    const z0 = Math.max(0, Math.floor(lo[2] / s) - 1), z1 = Math.min(M - 1, Math.ceil(hi[2] / s) + 1);
    const pos = []; const quads = []; const touched = [];
    const vid = (x, y, z) => {
      const k = x + M1 * y + M1 * M1 * z;
      if (vmap[k] === -1) { vmap[k] = pos.length / 3; pos.push(x, y, z); touched.push(k); }
      return vmap[k];
    };
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (compGrid[x + M * y + M * M * z] !== c) continue;
      for (const [d, corners] of FACES) {
        if (cellAt(x + d[0], y + d[1], z + d[2]) === c) continue;
        const q = corners.map(([a, b, e]) => vid(x + a, y + b, z + e));
        // ensure CCW-from-outside: (p1-p0)x(p2-p0) . d > 0
        const p = q.map((v) => [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]]);
        const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
        const w = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
        const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        if (cr[0] * d[0] + cr[1] * d[1] + cr[2] * d[2] < 0) q.reverse();
        quads.push(q);
      }
    }
    for (const k of touched) vmap[k] = -1;
    const nv = pos.length / 3;
    const P = Float64Array.from(pos, (v) => v * s);
    if (nv === 0) { out.push({ P, N: new Float32Array(0), I: new Uint32Array(0) }); continue; }
    // adjacency for smoothing
    const nbrs = Array.from({ length: nv }, () => new Set());
    for (const q of quads) for (let e = 0; e < 4; e++) { const a = q[e], b = q[(e + 1) & 3]; nbrs[a].add(b); nbrs[b].add(a); }
    const nb = nbrs.map((st) => Int32Array.from(st));
    const fixed = new Uint8Array(nv * 3);
    for (let v = 0; v < nv; v++) for (let a = 0; a < 3; a++) { const x = P[3 * v + a]; if (x === 0 || x === N) fixed[3 * v + a] = 1; }
    const tmp = new Float64Array(P.length);
    const step = (lambda) => {
      for (let v = 0; v < nv; v++) {
        const list = nb[v]; let sx = 0, sy = 0, sz = 0;
        for (let j = 0; j < list.length; j++) { const o = 3 * list[j]; sx += P[o]; sy += P[o + 1]; sz += P[o + 2]; }
        const n = list.length || 1; const o = 3 * v;
        tmp[o] = fixed[o] ? P[o] : P[o] + lambda * (sx / n - P[o]);
        tmp[o + 1] = fixed[o + 1] ? P[o + 1] : P[o + 1] + lambda * (sy / n - P[o + 1]);
        tmp[o + 2] = fixed[o + 2] ? P[o + 2] : P[o + 2] + lambda * (sz / n - P[o + 2]);
      }
      P.set(tmp);
    };
    for (let it = 0; it < 12; it++) { step(0.5); step(-0.53); }
    // triangles + area-weighted normals
    const I = new Uint32Array(quads.length * 6);
    const Nn = new Float64Array(nv * 3);
    let k = 0;
    for (const q of quads) {
      // split along the shorter diagonal
      const d02 = dist2(P, q[0], q[2]), d13 = dist2(P, q[1], q[3]);
      const tris = d02 <= d13 ? [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] : [[q[0], q[1], q[3]], [q[1], q[2], q[3]]];
      for (const [a, b, c2] of tris) {
        I[k++] = a; I[k++] = b; I[k++] = c2;
        const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
        const wx = P[3 * c2] - P[3 * a], wy = P[3 * c2 + 1] - P[3 * a + 1], wz = P[3 * c2 + 2] - P[3 * a + 2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        for (const v of [a, b, c2]) { Nn[3 * v] += nx; Nn[3 * v + 1] += ny; Nn[3 * v + 2] += nz; }
      }
    }
    const Nf = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const l = Math.hypot(Nn[3 * v], Nn[3 * v + 1], Nn[3 * v + 2]) || 1;
      Nf[3 * v] = Nn[3 * v] / l; Nf[3 * v + 1] = Nn[3 * v + 1] / l; Nf[3 * v + 2] = Nn[3 * v + 2] / l;
    }
    out.push({ P, N: Nf, I });
  }
  return out;
}
const dist2 = (P, a, b) => (P[3 * a] - P[3 * b]) ** 2 + (P[3 * a + 1] - P[3 * b + 1]) ** 2 + (P[3 * a + 2] - P[3 * b + 2]) ** 2;
const align4 = (n) => (n + 3) & ~3;

function buildLevel(level) {
  const t0 = Date.now();
  const names = [...new Set(level.anchors.map(([n]) => n))];
  const nameIndexOf = new Map(names.map((n, i) => [n, i]));
  const lab = nearestAnchorLabels(level.anchors, nameIndexOf);
  mergeTiny(lab);
  const { comp, count, sizes } = connectedComponents(lab);

  // per-name and per-component statistics
  const nv = new Float64Array(names.length), nsum = Array.from({ length: names.length }, () => [0, 0, 0]);
  const csum = Array.from({ length: count }, () => [0, 0, 0]);
  const cmin = Array.from({ length: count }, () => [N, N, N]), cmax = Array.from({ length: count }, () => [0, 0, 0]);
  const clab = new Int32Array(count);
  for (let i = 0; i < N3; i++) {
    const r = i & 255, g = (i >> 8) & 255, b = i >> 16;
    const L = lab[i], c = comp[i];
    nv[L]++; nsum[L][0] += r + 0.5; nsum[L][1] += g + 0.5; nsum[L][2] += b + 0.5;
    clab[c] = L;
    const cs = csum[c]; cs[0] += r + 0.5; cs[1] += g + 0.5; cs[2] += b + 0.5;
    const mn = cmin[c], mx = cmax[c];
    if (r < mn[0]) mn[0] = r; if (g < mn[1]) mn[1] = g; if (b < mn[2]) mn[2] = b;
    if (r + 1 > mx[0]) mx[0] = r + 1; if (g + 1 > mx[1]) mx[1] = g + 1; if (b + 1 > mx[2]) mx[2] = b + 1;
  }
  // order components by size desc
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => sizes[b] - sizes[a]);
  const newId = new Int32Array(count); order.forEach((old, k) => { newId[old] = k; });

  // downsampled component grid (sample at cell centre voxel)
  const M = level.meshRes, s = N / M;
  const compGrid = new Int32Array(M * M * M);
  for (let z = 0; z < M; z++) for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const h = s >> 1;
    const i = (x * s + h) + N * (y * s + h) + N * N * (z * s + h);
    compGrid[x + M * y + M * M * z] = newId[comp[i]];
  }
  const meshes = buildMeshes(compGrid, M, count, order.map((old) => [cmin[old], cmax[old]]));

  let vTotal = 0, iTotal = 0;
  const components = order.map((old, k) => {
    const m = meshes[k];
    const vc = m.P.length / 3, ic = m.I.length;
    const c = {
      nameIndex: clab[old], voxels: sizes[old],
      centroid: csum[old].map((v) => +(v / sizes[old]).toFixed(3)),
      bboxMin: cmin[old], bboxMax: cmax[old],
      firstVertex: vTotal, vertexCount: vc, firstIndex: iTotal, indexCount: ic,
    };
    vTotal += vc; iTotal += ic;
    return c;
  });

  const posBytes = align4(vTotal * 6), nrmBytes = vTotal * 4, idxBytes = iTotal * 4;
  const buf = new ArrayBuffer(posBytes + nrmBytes + idxBytes);
  const pos = new Uint16Array(buf, 0, vTotal * 3);
  const nrm = new Int8Array(buf, posBytes, vTotal * 4);
  const idx = new Uint32Array(buf, posBytes + nrmBytes, iTotal);
  components.forEach((c, k) => {
    const m = meshes[k];
    for (let v = 0; v < c.vertexCount; v++) {
      for (let a = 0; a < 3; a++) {
        pos[3 * (c.firstVertex + v) + a] = Math.round(Math.min(N, Math.max(0, m.P[3 * v + a])) / N * 65535);
        nrm[4 * (c.firstVertex + v) + a] = Math.round(m.N[3 * v + a] * 127);
      }
      nrm[4 * (c.firstVertex + v) + 3] = 0;
    }
    idx.set(m.I, c.firstIndex);
  });

  const meta = {
    level: level.id,
    resolution: N,
    source: { answers: 0, users: 0, sigma: 0, notes: 'FAKE assets from web/scripts/make-fake-assets.mjs (nearest anchor colour).' },
    names: names.map((name, i) => ({
      name, voxels: nv[i], fraction: +(nv[i] / N3).toFixed(6), answers: Math.round(nv[i] / 5),
      meanColor: nsum[i].map((v) => Math.round(Math.min(255, v / Math.max(1, nv[i])))),
      centroid: nsum[i].map((v) => +(v / Math.max(1, nv[i])).toFixed(3)),
    })),
    components,
    mesh: {
      file: 'meshes.bin', vertexCount: vTotal, indexCount: iTotal,
      positionsByteOffset: 0, normalsByteOffset: posBytes, indicesByteOffset: posBytes + nrmBytes,
    },
  };
  const dir = join(OUT, level.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  writeFileSync(join(dir, 'meshes.bin'), new Uint8Array(buf));
  writeFileSync(join(dir, 'labels.lbl'), gzipSync(lab, { level: 6 }));
  console.log(`${level.id}: ${names.length} names, ${count} components, ${vTotal} verts, ${iTotal / 3} tris, ${Date.now() - t0} ms`);
}

mkdirSync(OUT, { recursive: true });
for (const level of LEVELS) buildLevel(level);
writeFileSync(join(OUT, 'levels.json'), JSON.stringify({
  default: 'standard',
  levels: LEVELS.map(({ id, title, description }) => ({ id, title, description })),
}, null, 2));
console.log('wrote', OUT);
