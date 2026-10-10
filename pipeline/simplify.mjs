// Simplify every component mesh of a level with meshoptimizer.
// usage: node simplify.mjs <in.bin> <in.json> <out.bin> <out.json> <targetError>
// in.json: { components: [{ vOff, vCount, iOff, iCount }] }  (vOff/iOff in elements)
// in.bin : float32 positions (3/vertex) for all vertices, then uint32 indices
//          (relative to the component's vOff). Byte offsets given in in.json.
// out.bin: uint32 simplified indices (still relative to vOff); out.json gives
//          per component { iOff, iCount, error }.
import { readFileSync, writeFileSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';

const [inBin, inJson, outBin, outJson, errArg] = process.argv.slice(2);
const targetError = Number(errArg ?? '0.4');
await MeshoptSimplifier.ready;

const meta = JSON.parse(readFileSync(inJson, 'utf8'));
const buf = readFileSync(inBin);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const pos = new Float32Array(ab, meta.positionsByteOffset, meta.vertexCount * 3);
const idx = new Uint32Array(ab, meta.indicesByteOffset, meta.indexCount);

// Vertices on edges that break closed-2-manifoldness: an edge used twice in the same
// direction (4 triangles on one edge) or an edge without its reverse.
function badVertices(ind, nv) {
  const count = new Map();
  for (let t = 0; t < ind.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = ind[t + e], b = ind[t + ((e + 1) % 3)];
      const k = a * nv + b;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const bad = new Set();
  for (const [k, n] of count) {
    const a = Math.floor(k / nv), b = k % nv;
    if (n !== 1 || !count.has(b * nv + a)) { bad.add(a); bad.add(b); }
  }
  return bad;
}

function adjacency(ind, nv) {
  const deg = new Uint32Array(nv + 1);
  for (let i = 0; i < ind.length; i++) deg[ind[i] + 1] += 2;
  for (let i = 0; i < nv; i++) deg[i + 1] += deg[i];
  const nb = new Uint32Array(deg[nv]);
  const fill = deg.slice(0, nv);
  for (let t = 0; t < ind.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = ind[t + e], b = ind[t + ((e + 1) % 3)];
      nb[fill[a]++] = b;
      nb[fill[b]++] = a;
    }
  }
  return { start: deg, nb };
}

const outParts = [];
let lockRounds = 0, lockedTotal = 0, fallbacks = 0;
const outMeta = [];
let iOff = 0, before = 0, after = 0;
for (const c of meta.components) {
  const p = pos.subarray(c.vOff * 3, (c.vOff + c.vCount) * 3);
  const ind = idx.slice(c.iOff, c.iOff + c.iCount);
  const nv = c.vCount;
  // Simplification can pinch thin wedges (e.g. where a region meets a cube face at a
  // shallow angle) into non-manifold edges. When that happens, lock the offending
  // vertices plus a few rings of their original neighbourhood and simplify again.
  const lock = new Uint8Array(nv);
  const dummy = new Float32Array(nv);
  let adj = null;
  let res = null, err = 0;
  for (let round = 0; round < 12; round++) {
    const [r, er] = MeshoptSimplifier.simplifyWithAttributes(
      ind, p, 3, dummy, 1, [0], lock, 0, targetError, ['ErrorAbsolute']);
    const bad = badVertices(r, nv);
    if (bad.size === 0) { res = r; err = er; break; }
    lockRounds++;
    adj ??= adjacency(ind, nv);
    let frontier = [...bad];
    for (let ring = 0; ring <= 2 + round; ring++) {
      const next = [];
      for (const v of frontier) {
        if (!lock[v]) { lock[v] = 1; lockedTotal++; }
        for (let j = adj.start[v]; j < adj.start[v + 1]; j++) {
          if (!lock[adj.nb[j]]) next.push(adj.nb[j]);
        }
      }
      frontier = next;
    }
  }
  if (res === null) { res = ind; err = 0; fallbacks++; }  // unsimplified (always closed)
  outParts.push(res);
  outMeta.push({ iOff, iCount: res.length, error: err });
  iOff += res.length;
  before += c.iCount / 3;
  after += res.length / 3;
}
const out = new Uint32Array(iOff);
let o = 0;
for (const part of outParts) { out.set(part, o); o += part.length; }
writeFileSync(outBin, Buffer.from(out.buffer));
writeFileSync(outJson, JSON.stringify({ targetError, components: outMeta }));
console.log(`simplified ${meta.components.length} meshes: ${before} -> ${after} triangles, ` +
            `${lockRounds} re-simplifications locking ${lockedTotal} vertices, ` +
            `${fallbacks} unsimplified fallbacks ` +
            `(max error ${Math.max(...outMeta.map((m) => m.error)).toFixed(3)} voxels)`);
