// Drag-handle placement while some names are hidden: the spot nearest the default position from which the
// handle, carried along its whole drag path, never covers a selected (visible) name.
//
// The drag path is fixed per orientation: offset planes slide the handle along the normal, so a spot is clear
// iff it lies outside the selection's shadow projected along the normal (independent of the offset). Hues
// planes turn the handle about the gray axis, so a spot at radius rho / height z is clear iff that whole
// circle misses the selection: the shadow lives in (rho, z) (independent of the hue).
//
// 1. occupancy: 64^3 cells holding any voxel of a selected name, grown by one cell (borders are drawn from
//    smoothed labels) -- per selection
// 2. shadow: project the occupied cell centres onto a 2D raster, then grow them by the handle's radius plus
//    a cell's reach with a distance transform -- per selection and orientation
// 3. the nearest raster point to the default that is outside the shadow and where the whole handle fits on
//    the plane somewhere along the drag path -- per slice change (cheap). Not the current slice polygon: that
//    shrinks as the plane nears a corner, and the handle should stay put (if need be beyond its border)
//    rather than snap back. Offset planes sweep the cube's outline seen along the normal (the convex hull of
//    the projected corners); Hues planes reach, at height z on the gray axis, out to the cube's farthest
//    point from the axis at that height.
import * as THREE from 'three';
import { edt2d } from './labeler';
import { SliceState, hueDir } from './slice';

const CELL = 4, N = 256 / CELL;
const RES = 2; // shadow raster spacing (grid units)
/** in-plane radius of the handle (its ring, including the dark backing) */
const HANDLE_R = 11;
/** a cell centre's projection stands for the whole cell, and a raster point for its neighbourhood */
const REACH = HANDLE_R + (CELL * Math.sqrt(3)) / 2 + (RES * Math.SQRT2) / 2;
const GRAY = new THREE.Vector3(1, 1, 1).normalize();

export class HandlePlacer {
  private labels: Uint8Array | null = null;
  private visKey = '';
  private occ: Uint8Array | null = null;
  private occVersion = 0;
  private maskKey = '';
  private maskVersion = -1;
  private mask: { blocked: Uint8Array; W: number; H: number; x0: number; y0: number } | null = null;

  /**
   * Handle position (grid units) nearest `def` (the default position on the plane) whose drag path misses
   * every visible name, or null when there is none.
   */
  place(labels: Uint8Array, visible: boolean[], s: SliceState, def: THREE.Vector3): THREE.Vector3 | null {
    this.updateOccupancy(labels, visible);
    const hues = s.orientation === 'hues';
    // 2D frame on the plane: o + x*ax + y*ay
    const o = s.center(), ax = hues ? hueDir(s.hue) : s.U.clone(), ay = hues ? GRAY : s.V;
    const f = s.faces()[0];
    const bounds = hues ? { x0: 0, x1: f.x1, y0: f.y0, y1: f.y1 } : f; // hues: the hue side only
    const key = hues ? 'hues' : `${ax.toArray().map((v) => v.toFixed(6))} ${ay.toArray().map((v) => v.toFixed(6))}`;
    if (key !== this.maskKey || this.maskVersion !== this.occVersion || !this.mask) {
      this.mask = this.buildMask(hues, ax, ay, bounds);
      this.maskKey = key; this.maskVersion = this.occVersion;
    }
    const m = this.mask;
    const rel = new THREE.Vector3();
    const to2 = (p: THREE.Vector3): [number, number] => { rel.copy(p).sub(o); return [rel.dot(ax), rel.dot(ay)]; };
    const fits = hues ? fitsHues : fitsOutline(ax, ay);
    const ok = (x: number, y: number) => {
      if (!fits(x, y)) return false;
      const i = Math.round((x - m.x0) / RES), j = Math.round((y - m.y0) / RES);
      return i >= 0 && j >= 0 && i < m.W && j < m.H && !m.blocked[j * m.W + i];
    };
    const [dx, dy] = to2(def);
    if (ok(dx, dy)) return def.clone();
    let best = -1, bestD = Infinity;
    for (let j = 0; j < m.H; j++) for (let i = 0; i < m.W; i++) {
      if (m.blocked[j * m.W + i]) continue;
      const x = m.x0 + i * RES, y = m.y0 + j * RES, d = (x - dx) ** 2 + (y - dy) ** 2;
      if (d < bestD && ok(x, y)) { bestD = d; best = j * m.W + i; }
    }
    if (best < 0) return null;
    const x = m.x0 + (best % m.W) * RES, y = m.y0 + Math.floor(best / m.W) * RES;
    return o.clone().addScaledVector(ax, x).addScaledVector(ay, y);
  }

  private updateOccupancy(labels: Uint8Array, visible: boolean[]) {
    const visKey = visible.map((v) => (v ? 1 : 0)).join('');
    if (labels === this.labels && visKey === this.visKey && this.occ) return;
    this.labels = labels; this.visKey = visKey;
    const sel = new Uint8Array(256);
    for (let i = 0; i < 256; i++) sel[i] = visible[i] === true ? 1 : 0;
    const occ = new Uint8Array(N * N * N);
    for (let z = 0; z < 256; z++) {
      const cz = (z >> 2) * N * N;
      for (let y = 0; y < 256; y++) {
        const row = z * 65536 + y * 256, cyz = cz + (y >> 2) * N;
        for (let x = 0; x < 256; x++) if (sel[labels[row + x]]) occ[cyz + (x >> 2)] = 1;
      }
    }
    const grown = new Uint8Array(occ.length);
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!occ[x + N * y + N * N * z]) continue;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X >= 0 && Y >= 0 && Z >= 0 && X < N && Y < N && Z < N) grown[X + N * Y + N * N * Z] = 1;
      }
    }
    this.occ = grown;
    this.occVersion++;
  }

  private buildMask(hues: boolean, ax: THREE.Vector3, ay: THREE.Vector3, b: { x0: number; x1: number; y0: number; y1: number }) {
    // padded by REACH: cells projecting just outside the slice's extent still block spots inside it
    const x0 = b.x0 - REACH, y0 = b.y0 - REACH;
    const W = Math.ceil((b.x1 + REACH - x0) / RES) + 1, H = Math.ceil((b.y1 + REACH - y0) / RES) + 1;
    const D = new Float64Array(W * H).fill(1e20);
    const occ = this.occ!, p = new THREE.Vector3();
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!occ[x + N * y + N * N * z]) continue;
      p.set((x + 0.5) * CELL - 128, (y + 0.5) * CELL - 128, (z + 0.5) * CELL - 128);
      let u: number, v: number;
      if (hues) { v = p.dot(GRAY); u = Math.sqrt(Math.max(0, p.lengthSq() - v * v)); } // radius, height
      else { u = p.dot(ax); v = p.dot(ay); }
      const i = Math.round((u - x0) / RES), j = Math.round((v - y0) / RES);
      if (i >= 0 && j >= 0 && i < W && j < H) D[j * W + i] = 0;
    }
    edt2d(D, W, H);
    const blocked = new Uint8Array(W * H), r2 = (REACH / RES) ** 2;
    for (let k = 0; k < W * H; k++) blocked[k] = D[k] < r2 ? 1 : 0;
    return { blocked, W, H, x0, y0 };
  }
}

/**
 * Offset planes: does the handle, at (x, y) in the plane basis (ax, ay) about the cube centre, fit inside the
 * cube's outline seen along the normal (the convex hull of the projected corners)?
 */
function fitsOutline(ax: THREE.Vector3, ay: THREE.Vector3): (x: number, y: number) => boolean {
  const c = new THREE.Vector3(), pts: [number, number][] = [];
  for (let k = 0; k < 8; k++) {
    c.set(k & 1 ? 128 : -128, k & 2 ? 128 : -128, k & 4 ? 128 : -128);
    pts.push([c.dot(ax), c.dot(ay)]);
  }
  // convex hull (monotone chain), counter-clockwise
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: [number, number][]) => {
    const h: [number, number][] = [];
    for (const p of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 1e-9) h.pop(); h.push(p); }
    h.pop();
    return h;
  };
  const hull = [...half(pts), ...half([...pts].reverse())];
  const edges = hull.map(([x1, y1], i) => {
    const [x2, y2] = hull[(i + 1) % hull.length], len = Math.hypot(x2 - x1, y2 - y1) || 1;
    return { nx: -(y2 - y1) / len, ny: (x2 - x1) / len, x1, y1 }; // inward for a CCW hull
  });
  return (x, y) => edges.every((e) => (x - e.x1) * e.nx + (y - e.y1) * e.ny >= HANDLE_R);
}

/** Hues planes: the cube's farthest point from the gray axis at height z (about the centre), 0 outside. */
function rhoMaxExact(z: number): number {
  // the section perpendicular to the axis at height z is convex, so its farthest point is a vertex: where the
  // section plane crosses a cube edge
  let best = 0;
  const g = 1 / Math.sqrt(3), d = z / g; // corner c is on the section iff (cx + cy + cz) = d
  for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) {
    if (a & bit) continue;
    const ca = [a & 1 ? 128 : -128, a & 2 ? 128 : -128, a & 4 ? 128 : -128];
    const cb = [...ca]; cb[bit >> 1] = 128;
    const sa = ca[0] + ca[1] + ca[2], sb = cb[0] + cb[1] + cb[2];
    if ((sa - d) * (sb - d) > 0) continue;
    const t = sa === sb ? 0 : (d - sa) / (sb - sa);
    const p = ca.map((v, i) => v + (cb[i] - v) * t), along = (p[0] + p[1] + p[2]) * g;
    best = Math.max(best, Math.sqrt(Math.max(0, p[0] ** 2 + p[1] ** 2 + p[2] ** 2 - along * along)));
  }
  return best;
}

// rhoMax sampled every 0.5 units along the axis (half-diagonal 128·√3 ≈ 221.7), rounded down between samples
const RHO_STEP = 0.5, RHO_Z0 = -224;
const RHO_TABLE = Float64Array.from({ length: Math.ceil(-2 * RHO_Z0 / RHO_STEP) + 2 }, (_, i) => {
  const z = RHO_Z0 + i * RHO_STEP;
  return Math.min(rhoMaxExact(z), rhoMaxExact(z + RHO_STEP));
});
function rhoMax(z: number): number {
  const i = Math.floor((z - RHO_Z0) / RHO_STEP);
  return i >= 0 && i < RHO_TABLE.length ? RHO_TABLE[i] : 0;
}

/** Hues planes: does the handle at radius x, height y fit on the plane at some hue? (off the axis, too) */
function fitsHues(x: number, y: number): boolean {
  if (x < HANDLE_R) return false; // stay on the hue side, off the axis
  for (let k = -2; k <= 2; k++) if (x + HANDLE_R > rhoMax(y + (k * HANDLE_R) / 2)) return false;
  return true;
}
