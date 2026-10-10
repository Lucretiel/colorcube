// Satmap-style label placement for a 2D slice. Pure (no DOM) so it runs in a worker.
//
// 1. Rasterise the slice's label image (smooth trilinear-majority labels, ~420 px on the long side).
// 2. 4-connected components of equal labels; per-component area and second moments.
// 3. Exact Euclidean distance transform (Felzenszwalb) to the nearest region boundary.
// 4. Per component: pole of inaccessibility = argmax distance; principal axis from moments.
// 5. For one-line / two-line layouts, horizontal or along the principal axis (if elongated),
//    and a few centres (pole, and points along the axis), binary-search the largest font size
//    whose (rotated) text box fits inside the component. Best-scoring layout wins.
import { majorityLabel } from './data';

export interface PlainFace {
  x0: number; y0: number; x1: number; y1: number;
  origin: [number, number, number]; ux: [number, number, number]; vy: [number, number, number];
}
export interface NameMetric {
  /** width of the UPPERCASE name on one line, in em */
  w1: number;
  /** two-line split (if the name has a space): the lines and the max line width in em */
  lines2: [string, string] | null;
  w2: number;
  text: string;
}
export interface LabelRequest {
  id: number; faces: PlainFace[]; names: NameMetric[];
  /** 'full' = whole slice; 'view' = the zoomed-in part of the 2D map only (finer raster) */
  kind?: 'full' | 'view';
  /** multiplies the font-size limits (1/zoom for view requests, so on-screen limits stay the same) */
  emScale?: number;
}
export interface PlacedLabel {
  name: number;
  lines: string[];
  x: number; y: number;  // map units
  angle: number;         // radians, CCW in map space
  size: number;          // font size (em) in map units
  area: number;          // region area, map units^2
  radius: number;        // inscribed radius, map units
}
export interface LabelResult { id: number; kind: 'full' | 'view'; labels: PlacedLabel[]; ms: number; width: number; height: number }

const CAP_EM = 0.72;     // cap height of the label font in em
const LINE_EM = 0.98;    // line advance in em
const PAD_EM = 0.12;
const MAX_EM0 = 26;      // map units (one face is 256 units)
const MIN_EM0 = 2.2;
const FILL = 0.8;        // final size relative to the largest fitting size

export function computeLabels(volume: Uint8Array, req: LabelRequest): LabelResult {
  const t0 = performance.now();
  const faces = req.faces;
  const MIN_EM = MIN_EM0 * (req.emScale ?? 1), MAX_EM = MAX_EM0 * (req.emScale ?? 1);
  let X0 = Infinity, X1 = -Infinity, Y0 = Infinity, Y1 = -Infinity;
  for (const f of faces) { X0 = Math.min(X0, f.x0); X1 = Math.max(X1, f.x1); Y0 = Math.min(Y0, f.y0); Y1 = Math.max(Y1, f.y1); }
  const h = Math.max(X1 - X0, Y1 - Y0) / 420;
  const W = Math.ceil((X1 - X0) / h), H = Math.ceil((Y1 - Y0) / h);
  const n = W * H;
  const img = new Uint8Array(n).fill(255);

  // 1. rasterise
  for (const f of faces) {
    const i0 = Math.max(0, Math.floor((f.x0 - X0) / h)), i1 = Math.min(W - 1, Math.ceil((f.x1 - X0) / h) - 1);
    const j0 = Math.max(0, Math.floor((Y1 - f.y1) / h)), j1 = Math.min(H - 1, Math.ceil((Y1 - f.y0) / h) - 1);
    const [ox, oy, oz] = f.origin, [ux, uy, uz] = f.ux, [vx, vy, vz] = f.vy;
    for (let j = j0; j <= j1; j++) {
      const my = Y1 - (j + 0.5) * h;
      if (my < f.y0 || my > f.y1) continue;
      for (let i = i0; i <= i1; i++) {
        const mx = X0 + (i + 0.5) * h;
        if (mx < f.x0 || mx > f.x1) continue;
        const gx = ox + ux * mx + vx * my, gy = oy + uy * mx + vy * my, gz = oz + uz * mx + vz * my;
        if (gx < 0 || gy < 0 || gz < 0 || gx > 256 || gy > 256 || gz > 256) continue;
        img[j * W + i] = majorityLabel(volume, gx, gy, gz);
      }
    }
  }

  // 2. connected components (4-connectivity)
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const cLabel: number[] = [], cArea: number[] = [];
  const cSx: number[] = [], cSy: number[] = [], cSxx: number[] = [], cSyy: number[] = [], cSxy: number[] = [];
  let nc = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1 || img[s] === 255) continue;
    const L = img[s];
    let sp = 0; stack[sp++] = s; comp[s] = nc;
    let area = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % W, y = (p - x) / W;
      area++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x > 0 && comp[p - 1] === -1 && img[p - 1] === L) { comp[p - 1] = nc; stack[sp++] = p - 1; }
      if (x < W - 1 && comp[p + 1] === -1 && img[p + 1] === L) { comp[p + 1] = nc; stack[sp++] = p + 1; }
      if (y > 0 && comp[p - W] === -1 && img[p - W] === L) { comp[p - W] = nc; stack[sp++] = p - W; }
      if (y < H - 1 && comp[p + W] === -1 && img[p + W] === L) { comp[p + W] = nc; stack[sp++] = p + W; }
    }
    cLabel.push(L); cArea.push(area); cSx.push(sx); cSy.push(sy); cSxx.push(sxx); cSyy.push(syy); cSxy.push(sxy);
    nc++;
  }

  // 3. distance transform to region boundaries
  const INF = 1e20;
  const D = new Float64Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, c = comp[p];
    const boundary = c < 0 || x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
      comp[p - 1] !== c || comp[p + 1] !== c || comp[p - W] !== c || comp[p + W] !== c;
    D[p] = boundary ? 0 : INF;
  }
  edt2d(D, W, H);

  // 4. poles
  const poleIdx = new Int32Array(nc).fill(-1), poleD = new Float64Array(nc);
  for (let p = 0; p < n; p++) {
    const c = comp[p];
    if (c >= 0 && D[p] > poleD[c]) { poleD[c] = D[p]; poleIdx[c] = p; }
  }

  const inComp = (c: number, mx: number, my: number) => {
    const i = Math.floor((mx - X0) / h), j = Math.floor((Y1 - my) / h);
    if (i < 0 || j < 0 || i >= W || j >= H) return false;
    return comp[j * W + i] === c;
  };
  const fits = (c: number, cx: number, cy: number, ca: number, sa: number, hw: number, hh: number) => {
    const NX = 9, NY = 4;
    for (let a = 0; a <= NX; a++) {
      const u = -hw + (2 * hw * a) / NX;
      for (let b = 0; b <= NY; b++) {
        if (a > 0 && a < NX && b > 0 && b < NY && ((a + b) & 1)) continue; // sparser interior
        const v = -hh + (2 * hh * b) / NY;
        if (!inComp(c, cx + u * ca - v * sa, cy + u * sa + v * ca)) return false;
      }
    }
    return true;
  };

  const out: PlacedLabel[] = [];
  const minAreaPx = 24;
  for (let c = 0; c < nc; c++) {
    if (cArea[c] < minAreaPx || poleIdx[c] < 0) continue;
    const metric = req.names[cLabel[c]];
    if (!metric) continue;
    const rPx = Math.sqrt(poleD[c]) + 0.5;
    const r = rPx * h;
    if (r < MIN_EM * CAP_EM * 0.5) continue;
    const pp = poleIdx[c];
    const px = X0 + ((pp % W) + 0.5) * h, py = Y1 - (Math.floor(pp / W) + 0.5) * h;
    // principal axis (pixel coords have y down -> flip to map space)
    const A = cArea[c];
    const mx = cSx[c] / A, my = cSy[c] / A;
    const vxx = cSxx[c] / A - mx * mx, vyy = cSyy[c] / A - my * my, vxy = -(cSxy[c] / A - mx * my);
    const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
    let theta = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
    if (theta > Math.PI / 2) theta -= Math.PI; if (theta <= -Math.PI / 2) theta += Math.PI;
    const elong = Math.sqrt(l1 / l2);
    const angles = [0];
    // rotate along diagonal bands (like xkcd's TEAL / MAROON), but keep near-vertical regions horizontal
    if (elong > 1.6 && Math.abs(theta) > 0.12 && Math.abs(theta) < 1.2) angles.push(theta);
    const cmx = X0 + (mx + 0.5) * h, cmy = Y1 - (my + 0.5) * h;
    const centres: [number, number][] = [[px, py]];
    if (inComp(c, cmx, cmy)) centres.push([cmx, cmy]);
    const ax = Math.cos(theta), ay = Math.sin(theta);
    for (const t of [-1.4, -0.7, 0.7, 1.4]) {
      const qx = px + ax * t * r, qy = py + ay * t * r;
      if (inComp(c, qx, qy)) centres.push([qx, qy]);
    }
    const layouts: { lines: string[]; wEm: number }[] = [{ lines: [metric.text], wEm: metric.w1 }];
    if (metric.lines2) layouts.push({ lines: metric.lines2, wEm: metric.w2 });

    let best: PlacedLabel | null = null, bestScore = 0;
    for (const lay of layouts) {
      const hEm = CAP_EM + (lay.lines.length - 1) * LINE_EM;
      for (const ang of angles) {
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const pref = (ang === 0 ? 1 : 0.8) * (lay.lines.length === 1 ? 1 : 0.88);
        for (const [cx, cy] of centres) {
          let lo = 0, hi = Math.min(MAX_EM, (2.2 * r) / hEm);
          if (hi * pref <= bestScore) continue;
          if (!fits(c, cx, cy, ca, sa, (lo + MIN_EM) * (lay.wEm / 2 + PAD_EM), (MIN_EM) * (hEm / 2 + PAD_EM))) continue;
          lo = MIN_EM;
          for (let it = 0; it < 11; it++) {
            const mid = (lo + hi) / 2;
            if (fits(c, cx, cy, ca, sa, mid * (lay.wEm / 2 + PAD_EM), mid * (hEm / 2 + PAD_EM))) lo = mid; else hi = mid;
          }
          const score = lo * pref;
          if (score > bestScore) {
            bestScore = score;
            // leave breathing room around the text, like the hand-placed satmap labels
            best = { name: cLabel[c], lines: lay.lines, x: cx, y: cy, angle: ang, size: lo * FILL, area: A * h * h, radius: r };
          }
        }
      }
    }
    if (best) out.push(best);
  }
  out.sort((a, b) => b.area - a.area);
  return { id: req.id, kind: req.kind ?? 'full', labels: out, ms: performance.now() - t0, width: W, height: H };
}

/** In-place 2D squared Euclidean distance transform (Felzenszwalb & Huttenlocher). */
function edt2d(D: Float64Array, W: number, H: number) {
  const m = Math.max(W, H);
  const f = new Float64Array(m), d = new Float64Array(m), z = new Float64Array(m + 1);
  const v = new Int32Array(m);
  const pass = (len: number, get: (i: number) => number, set: (i: number, x: number) => void) => {
    for (let i = 0; i < len; i++) f[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    for (let i = 0; i < len; i++) set(i, d[i]);
  };
  for (let x = 0; x < W; x++) pass(H, (i) => D[i * W + x], (i, val) => { D[i * W + x] = val; });
  for (let y = 0; y < H; y++) { const o = y * W; pass(W, (i) => D[o + i], (i, val) => { D[o + i] = val; }); }
}
