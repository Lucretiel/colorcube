// Asset loading per docs/CONTRACT.md.

export interface LevelInfo { id: string; title: string; description?: string }
export interface LevelsFile { default: string; levels: LevelInfo[] }

export interface NameInfo {
  name: string;
  voxels: number;
  fraction: number;
  answers: number;
  meanColor: [number, number, number];
  centroid: [number, number, number];
}

export interface ComponentInfo {
  nameIndex: number;
  voxels: number;
  centroid: [number, number, number];
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  firstVertex: number;
  vertexCount: number;
  firstIndex: number;
  indexCount: number;
  /** pipeline extension: interior point farthest from the component boundary (grid units) */
  anchor?: [number, number, number];
  anchorDepth?: number;
}

export interface Meta {
  level: string;
  resolution: number;
  source: { answers: number; users: number; sigma: number; notes?: string; [k: string]: unknown };
  names: NameInfo[];
  components: ComponentInfo[];
  mesh: {
    file: string;
    vertexCount: number;
    indexCount: number;
    positionsByteOffset: number;
    normalsByteOffset: number;
    indicesByteOffset: number;
  };
}

export interface LevelData {
  info: LevelInfo;
  meta: Meta;
  positions: Uint16Array; // xyz per vertex, grid = q*256/65535
  normals: Int8Array; // xyzw per vertex
  indices: Uint32Array; // relative to component.firstVertex
  labels: Uint8Array; // 256^3, i = r + 256 g + 65536 b
}

export type Progress = (fraction: number, what: string) => void;

export const VOL = 256;

export function assetBase(): string {
  const p = new URLSearchParams(location.search).get('assets');
  const base = (p && /^[\w./-]+$/.test(p) ? p : 'assets').replace(/\/+$/, '');
  return base;
}

async function fetchOk(url: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

export async function loadLevels(base: string): Promise<LevelsFile> {
  const res = await fetchOk(`${base}/levels.json`);
  const j = (await res.json()) as LevelsFile;
  if (!j.levels?.length) throw new Error('levels.json has no levels');
  return j;
}

async function fetchWithProgress(url: string, onBytes: (got: number, total: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetchOk(url, signal);
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onBytes(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

const isGzip = (buf: ArrayBuffer) => { const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength)); return b[0] === 0x1f && b[1] === 0x8b; };

/**
 * Load one level. labels.lbl (fixed name) is fetched in parallel with meta.json; the mesh file is named
 * by meta.mesh.file. On any failure the other downloads are aborted. `signal` lets the caller abort too.
 */
export async function loadLevel(base: string, info: LevelInfo, progress: Progress, signal?: AbortSignal): Promise<LevelData> {
  const dir = `${base}/${info.id}`;
  const ac = new AbortController();
  const abort = () => ac.abort();
  signal?.addEventListener('abort', abort);
  progress(0.02, 'metadata');
  let meshGot = 0, meshTotal = 0, lblGot = 0, lblTotal = 0;
  const report = (what: string) => {
    const tot = (meshTotal || 2e6) + (lblTotal || 3e5);
    progress(Math.min(0.9, 0.05 + (0.85 * (meshGot + lblGot)) / tot), what);
  };
  try {
    const lblP = fetchWithProgress(`${dir}/labels.lbl`, (g, t) => { lblGot = g; lblTotal = t || g * 2; report('label volume'); }, ac.signal);
    lblP.catch(() => undefined); // awaited below; don't report it as unhandled if meta.json fails first
    const meta = (await (await fetchOk(`${dir}/meta.json`, ac.signal)).json()) as Meta;
    const meshP = fetchWithProgress(`${dir}/${meta.mesh.file}`, (g, t) => { meshGot = g; meshTotal = t || g * 2; report('meshes'); }, ac.signal);
    const [meshRaw, lblGz] = await Promise.all([meshP, lblP]);
    progress(0.92, 'decompressing');
    // contract: meshes.bin may be gzip-compressed (detected by its magic bytes)
    const meshBuf = isGzip(meshRaw) ? await gunzip(meshRaw) : meshRaw;
    const lblBuf = await gunzip(lblGz);
    if (lblBuf.byteLength !== VOL * VOL * VOL) throw new Error(`labels.lbl: expected ${VOL ** 3} bytes, got ${lblBuf.byteLength}`);
    const need = meta.mesh.indicesByteOffset + 4 * meta.mesh.indexCount;
    if (meshBuf.byteLength < need) throw new Error(`${meta.mesh.file}: expected ${need} bytes, got ${meshBuf.byteLength}`);
    return build(info, meta, meshBuf, lblBuf, progress);
  } catch (err) {
    ac.abort();
    throw err;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

function build(info: LevelInfo, meta: Meta, meshBuf: ArrayBuffer, lblBuf: ArrayBuffer, progress: Progress): LevelData {
  const m = meta.mesh;
  const positions = new Uint16Array(meshBuf, m.positionsByteOffset, m.vertexCount * 3);
  const normals = new Int8Array(meshBuf, m.normalsByteOffset, m.vertexCount * 4);
  const indices = new Uint32Array(meshBuf, m.indicesByteOffset, m.indexCount);
  progress(0.96, 'building scene');
  return { info, meta, positions, normals, indices, labels: new Uint8Array(lblBuf) };
}

/** Smooth majority label at a grid-space point (same rule as the GPU slice shader, without in-plane blur). */
export function majorityLabel(labels: Uint8Array, x: number, y: number, z: number): number {
  const qx = x - 0.5, qy = y - 0.5, qz = z - 0.5;
  const bx = Math.floor(qx), by = Math.floor(qy), bz = Math.floor(qz);
  const fx = qx - bx, fy = qy - by, fz = qz - bz;
  let l0 = -1, w0 = 0, l1 = -1, w1 = 0, l2 = -1, w2 = 0, l3 = -1, w3 = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = k >> 2;
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    if (w <= 0) continue;
    const cx = Math.min(255, Math.max(0, bx + dx)), cy = Math.min(255, Math.max(0, by + dy)), cz = Math.min(255, Math.max(0, bz + dz));
    const L = labels[cx + 256 * cy + 65536 * cz];
    if (L === l0) w0 += w; else if (L === l1) w1 += w; else if (L === l2) w2 += w; else if (L === l3) w3 += w;
    else if (l0 < 0) { l0 = L; w0 = w; } else if (l1 < 0) { l1 = L; w1 = w; } else if (l2 < 0) { l2 = L; w2 = w; } else if (l3 < 0) { l3 = L; w3 = w; }
  }
  let best = l0, bw = w0;
  if (w1 > bw) { best = l1; bw = w1; }
  if (w2 > bw) { best = l2; bw = w2; }
  if (w3 > bw) { best = l3; }
  return best < 0 ? labels[Math.min(255, Math.max(0, Math.floor(x))) + 256 * Math.min(255, Math.max(0, Math.floor(y))) + 65536 * Math.min(255, Math.max(0, Math.floor(z)))] : best;
}

export function toHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Grid coordinate (0..256) -> 8-bit channel value displayed for that point. */
export const gridToByte = (v: number) => Math.min(255, Math.max(0, Math.floor(v)));
