// Slice plane state + geometry shared by the 3D plane and the 2D map.
import * as THREE from 'three';

export type Orientation = 'r' | 'g' | 'b' | 'gray' | 'hues' | 'free';

const C = 128;
const S3 = Math.sqrt(3);
/** Hues map extent: the widest projection of the cube across all hues, and half the gray diagonal. */
const HUES_X = (4 * C) / Math.sqrt(6), HUES_Y = C * S3;
const HUE_NAMES = ['red', 'orange', 'yellow', 'chartreuse', 'green', 'spring green', 'cyan', 'azure', 'blue', 'violet', 'magenta', 'rose'];

/** Name of the nearest 30° hue step. */
export function hueName(deg: number): string { return HUE_NAMES[Math.round(wrapHue(deg) / 30) % 12]; }
function wrapHue(deg: number): number { return ((deg % 360) + 360) % 360; }

/**
 * Unit chroma direction (perpendicular to the gray diagonal) of HSV hue `deg`: hsv(deg, 1, 1) minus its gray
 * component. HSV hue depends only on this direction, so the half-plane gray axis + t·dir (t > 0) has exactly
 * this hue, and the opposite half has hue + 180.
 */
export function hueDir(deg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const h = wrapHue(deg) / 60, f = (k: number) => 1 - Math.max(0, Math.min(1, Math.min(k, 4 - k)));
  const r = f((5 + h) % 6), g = f((3 + h) % 6), b = f((1 + h) % 6), m = (r + g + b) / 3;
  return out.set(r - m, g - m, b - m).normalize();
}

export interface MapFace {
  /** map-space corners (x,y) in map units, CCW: (x0,y0) (x1,y0) (x1,y1) (x0,y1) */
  x0: number; y0: number; x1: number; y1: number;
  /** grid point at map (x,y): origin + x*ux + y*vy  (vectors in grid units per map unit) */
  origin: THREE.Vector3; ux: THREE.Vector3; vy: THREE.Vector3;
  /** in-cube polygon of the slice (grid units), for the in-scene plane */
  pos3: THREE.Vector3[];
}

export interface AxisNote { text: string; edge: 'bottom' | 'left' | 'top' | 'right'; from: number; to: number; label: string }

export class SliceState {
  orientation: Orientation = 'b';
  /** signed distance of the plane from the cube centre along the normal (grid units) */
  offset = 0;
  az = 45; el = 35.264;
  /** Hues mode: HSV hue shown on the map's right half (degrees, [0, 360)) */
  hue = 0;
  readonly normal = new THREE.Vector3(0, 0, 1);
  readonly U = new THREE.Vector3(-1, 0, 0);
  readonly V = new THREE.Vector3(0, 1, 0);
  /** incremented on every change so consumers can cheaply detect staleness */
  version = 0;

  constructor() { this.update(); }

  get halfRange(): number { return C * (Math.abs(this.normal.x) + Math.abs(this.normal.y) + Math.abs(this.normal.z)); }

  /** Human slider value: channel byte for r/g/b, R+G+B sum for gray, hue for Hues mode, offset for free. */
  get sliderMin(): number { return this.orientation === 'free' ? -Math.round(this.halfRange) : 0; }
  get sliderMax(): number {
    switch (this.orientation) {
      case 'gray': return 765;
      case 'hues': return 359;
      case 'free': return Math.round(this.halfRange);
      default: return 255;
    }
  }
  get sliderValue(): number {
    switch (this.orientation) {
      case 'r': case 'g': case 'b': return Math.round(this.offset + C - 0.5);
      case 'gray': return Math.round(this.offset * S3 + 3 * C - 1.5);
      case 'hues': return Math.round(this.hue) % 360;
      case 'free': return Math.round(this.offset);
    }
  }
  setSliderValue(v: number) {
    switch (this.orientation) {
      case 'r': case 'g': case 'b': this.offset = Math.min(255, Math.max(0, v)) + 0.5 - C; break;
      case 'gray': this.offset = (Math.min(765, Math.max(0, v)) + 1.5 - 3 * C) / S3; break;
      case 'hues': this.hue = wrapHue(v); this.update(); break; // wraps: the slider keeps rotating
      case 'free': this.offset = Math.max(-this.halfRange + 0.5, Math.min(this.halfRange - 0.5, v)); break;
    }
    this.version++;
  }
  /** Continuous hue (Hues-mode drag). */
  setHue(deg: number) {
    deg = wrapHue(deg);
    if (deg === this.hue) return;
    this.hue = deg;
    if (this.orientation === 'hues') this.update();
    this.version++;
  }

  /** Continuous offset (drag). Snaps axis-aligned planes to voxel centres. Hues-mode planes stay on the diagonal. */
  setOffset(o: number) {
    if (this.orientation === 'hues') return;
    const h = this.halfRange - 0.5;
    o = Math.max(-h, Math.min(h, o));
    if (this.orientation === 'r' || this.orientation === 'g' || this.orientation === 'b') o = Math.round(o + C - 0.5) + 0.5 - C;
    if (o !== this.offset) { this.offset = o; this.version++; }
  }

  setOrientation(o: Orientation) {
    const keepByte = this.sliderValue;
    const wasAxis = this.orientation === 'r' || this.orientation === 'g' || this.orientation === 'b';
    this.orientation = o;
    this.update();
    const isAxis = o === 'r' || o === 'g' || o === 'b';
    if (isAxis && wasAxis) this.setSliderValue(keepByte);
    else if (isAxis) this.setSliderValue(128);
    else if (o === 'gray') this.setSliderValue(383);
    else if (o === 'hues') this.offset = 0;
    else this.offset = Math.max(-this.halfRange + 0.5, Math.min(this.halfRange - 0.5, this.offset));
    this.version++;
  }

  setAngles(az: number, el: number) {
    this.az = az; this.el = el;
    if (this.orientation !== 'free') this.orientation = 'free';
    this.update();
    this.offset = Math.max(-this.halfRange + 0.5, Math.min(this.halfRange - 0.5, this.offset));
    this.version++;
  }

  /**
   * +1: the map shows the plane as seen from its +normal side, -1: from the -normal side. The app keeps
   * this equal to the cut side, so the 2D map is never mirrored relative to the cut face seen in 3D.
   */
  viewSign = 1;
  setViewSign(s: number) {
    s = s < 0 ? -1 : 1;
    if (s === this.viewSign) return;
    this.viewSign = s;
    this.update();
    this.version++;
  }

  private update() {
    const n = this.normal, U = this.U, V = this.V;
    switch (this.orientation) {
      // V = map "up"; for G slices "up" is -B (away from the default camera when looking down).
      case 'r': n.set(1, 0, 0); V.set(0, 1, 0); break;
      case 'g': n.set(0, 1, 0); V.set(0, 0, -1); break;
      case 'b': n.set(0, 0, 1); V.set(0, 1, 0); break;
      case 'gray': n.set(1, 1, 1).normalize(); V.set(-1, 2, -1).normalize(); break;
      // the plane holds the gray diagonal (map up, white at the top) and the hue direction (map right)
      case 'hues': V.set(1, 1, 1).normalize(); n.crossVectors(hueDir(this.hue, U), V).normalize(); break;
      case 'free': {
        const a = THREE.MathUtils.degToRad(this.az), e = THREE.MathUtils.degToRad(this.el);
        n.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)).normalize();
        V.set(0, 1, 0);
        if (Math.abs(n.y) > 0.985) V.set(0, 0, -1);
        V.addScaledVector(n, -V.dot(n)).normalize();
        break;
      }
    }
    // right-handed screen basis for a viewer on the viewSign side: right = up x (towards viewer)
    U.crossVectors(V, n).multiplyScalar(this.viewSign).normalize();
  }

  /** Point on plane closest to the cube centre (grid units). */
  center(out = new THREE.Vector3()): THREE.Vector3 { return out.set(C, C, C).addScaledVector(this.normal, this.offset); }

  /** Clip plane uniform: xyz = normal, w = offset (relative to cube centre). */
  clipVec4(out: THREE.Vector4): THREE.Vector4 { return out.set(this.normal.x, this.normal.y, this.normal.z, this.offset); }

  /** The current slice in map space (a single face). */
  faces(): MapFace[] {
    // fixed extent: projection of the cube onto the plane basis (independent of offset)
    // (Hues mode: fixed across hues, so rotating neither rescales the map nor resets its zoom)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const tmp = new THREE.Vector3();
    if (this.orientation === 'hues') { x0 = -HUES_X; x1 = HUES_X; y0 = -HUES_Y; y1 = HUES_Y; }
    else for (let k = 0; k < 8; k++) {
      tmp.set(k & 1 ? 128 : -128, k & 2 ? 128 : -128, k & 4 ? 128 : -128);
      const x = tmp.dot(this.U), y = tmp.dot(this.V);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const origin = this.center();
    return [{ x0, y0, x1, y1, origin, ux: this.U.clone(), vy: this.V.clone(), pos3: this.polygon3D() }];
  }

  /** Convex polygon (grid units) of the plane inside the cube; empty if none. */
  polygon3D(): THREE.Vector3[] {
    const n = this.normal, d = this.offset + n.x * C + n.y * C + n.z * C; // dot(p, n) = d
    const pts: THREE.Vector3[] = [];
    const corner = (k: number) => new THREE.Vector3(k & 1 ? 256 : 0, k & 2 ? 256 : 0, k & 4 ? 256 : 0);
    const edges: [number, number][] = [];
    for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) edges.push([a, a | bit]);
    for (const [a, b] of edges) {
      const pa = corner(a), pb = corner(b);
      const da = pa.dot(n) - d, db = pb.dot(n) - d;
      if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
        const t = da / (da - db);
        const p = pa.clone().lerp(pb, t);
        // a plane through a cube corner crosses each of its edges there (always the case in Hues mode)
        if (!pts.some((q) => q.distanceToSquared(p) < 1e-8)) pts.push(p);
      }
    }
    if (pts.length < 3) return [];
    const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const ang = (p: THREE.Vector3) => { const q = p.clone().sub(c); return Math.atan2(q.dot(this.V), q.dot(this.U)); };
    pts.sort((p, q) => ang(p) - ang(q));
    return pts;
  }

  axisNotes(): AxisNote[] {
    const ch = (v: THREE.Vector3) => {
      const parts: string[] = [];
      const nm = ['R', 'G', 'B'];
      [v.x, v.y, v.z].forEach((c, i) => { if (Math.abs(c) > 1e-3) parts.push(`${c > 0 ? '+' : '−'}${nm[i]}`); });
      return parts.join(' ');
    };
    const axis = (v: THREE.Vector3, edge: 'bottom' | 'left'): AxisNote => {
      const comps = [v.x, v.y, v.z], i = comps.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-6);
      if (i < 0 || !['r', 'g', 'b'].includes(this.orientation)) return { text: ch(v), edge, from: NaN, to: NaN, label: `${ch(v)} →` };
      const word = ['red', 'green', 'blue'][i], pos = comps[i] > 0;
      return { text: 'RGB'[i], edge, from: pos ? 0 : 255, to: pos ? 255 : 0, label: pos ? `${word} →` : `← ${word}` };
    };
    if (this.orientation === 'hues') {
      const right = this.U.dot(hueDir(this.hue)) > 0 ? this.hue : this.hue + 180;
      return [
        { text: '', edge: 'bottom', from: NaN, to: NaN, label: `← ${hueName(right + 180)} · ${hueName(right)} →` },
        { text: '', edge: 'left', from: 0, to: 255, label: 'black → white' },
      ];
    }
    return [axis(this.U, 'bottom'), axis(this.V, 'left')];
  }

  describe(): string {
    switch (this.orientation) {
      case 'r': return `R = ${this.sliderValue}`;
      case 'g': return `G = ${this.sliderValue}`;
      case 'b': return `B = ${this.sliderValue}`;
      case 'gray': return `R+G+B = ${this.sliderValue}`;
      case 'hues': return `Hue = ${this.sliderValue}° · ${hueName(this.hue)} | ${hueName(this.hue + 180)}`;
      case 'free': {
        const n = this.normal;
        return `n = (${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)}), d = ${this.offset.toFixed(1)}`;
      }
    }
  }
}

export function mapToGrid(faces: MapFace[], x: number, y: number, out: THREE.Vector3): THREE.Vector3 | null {
  for (const f of faces) {
    if (x >= f.x0 - 1e-6 && x <= f.x1 + 1e-6 && y >= f.y0 - 1e-6 && y <= f.y1 + 1e-6) {
      out.copy(f.origin).addScaledVector(f.ux, x).addScaledVector(f.vy, y);
      if (out.x < 0 || out.y < 0 || out.z < 0 || out.x > 256 || out.y > 256 || out.z > 256) return null;
      return out;
    }
  }
  return null;
}

export function mapBounds(faces: MapFace[]) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const f of faces) { x0 = Math.min(x0, f.x0); x1 = Math.max(x1, f.x1); y0 = Math.min(y0, f.y0); y1 = Math.max(y1, f.y1); }
  return { x0, x1, y0, y1 };
}

/**
 * Geometry for the 2D map; position = map xy, aGrid = sampled RGB point. The slice is the in-cube
 * polygon itself, so its outline is a real geometry edge that MSAA smooths (the shader's out-of-cube
 * discard would give a stair-stepped edge).
 */
export function buildMapGeometry(faces: MapFace[], geom: THREE.BufferGeometry) {
  const pos: number[] = [], grid: number[] = [], au: number[] = [], av: number[] = [], idx: number[] = [];
  faces.forEach((f) => {
    const poly = f.pos3;
    if (poly.length < 3) return;
    const b = pos.length / 3;
    const rel = new THREE.Vector3();
    for (const p of poly) {
      rel.copy(p).sub(f.origin);
      pos.push(rel.dot(f.ux) / f.ux.lengthSq(), rel.dot(f.vy) / f.vy.lengthSq(), 0); grid.push(p.x, p.y, p.z);
      au.push(f.ux.x, f.ux.y, f.ux.z); av.push(f.vy.x, f.vy.y, f.vy.z);
    }
    for (let k = 1; k + 1 < poly.length; k++) idx.push(b, b + k, b + k + 1);
  });
  setAttrs(geom, pos, grid, au, av, idx);
}

/** Geometry for the in-scene plane. */
export function buildPlaneGeometry(faces: MapFace[], geom: THREE.BufferGeometry) {
  const pos: number[] = [], grid: number[] = [], au: number[] = [], av: number[] = [], idx: number[] = [];
  faces.forEach((f) => {
    const poly = f.pos3;
    if (poly.length < 3) return;
    const b = pos.length / 3;
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k];
      pos.push(p.x, p.y, p.z); grid.push(p.x, p.y, p.z);
      au.push(f.ux.x, f.ux.y, f.ux.z); av.push(f.vy.x, f.vy.y, f.vy.z);
    }
    for (let k = 1; k + 1 < poly.length; k++) idx.push(b, b + k, b + k + 1);
  });
  setAttrs(geom, pos, grid, au, av, idx);
}

function setAttrs(geom: THREE.BufferGeometry, pos: number[], grid: number[], au: number[], av: number[], idx: number[]) {
  // free the GL buffers of the attributes being replaced now (three would otherwise keep them until the
  // replaced JS objects are garbage-collected); the geometry is re-uploaded on its next render
  geom.dispose();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('aGrid', new THREE.Float32BufferAttribute(grid, 3));
  geom.setAttribute('aU', new THREE.Float32BufferAttribute(au, 3));
  geom.setAttribute('aV', new THREE.Float32BufferAttribute(av, 3));
  geom.setIndex(idx);
  geom.computeBoundingSphere();
}
