// The 2D slice map: GPU-rendered into a scissored region of the main canvas (same WebGL context,
// same 3D label texture), with a Canvas2D overlay for satmap-style labels, axes and hover marks.
import * as THREE from 'three';
import { buildMapGeometry, mapBounds, mapToGrid, type MapFace } from './slice';
import type { LabelResult, NameMetric, PlacedLabel, PlainFace } from './labeler';
import { blitFragment, blitVertex, slice2DVertex, sliceFragment } from './shaders';

export const LABEL_FONT = `"xkcd-script", "Patrick Hand", "Comic Sans MS", cursive`;
const CAP_EM = 0.72, LINE_EM = 0.98;
const VIEW_LABEL_ZOOM = 1.3; // above this zoom the visible part of the map is relabelled

export interface MapView { cx: number; cy: number; s: number } // centre (map units), CSS px per map unit

export interface AxisDraw { edge: 'bottom' | 'left'; label: string; from: number; to: number }

export class Map2D {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  readonly geometry = new THREE.BufferGeometry();
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;
  readonly overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  faces: MapFace[] = [];
  bounds = { x0: -128, x1: 128, y0: -128, y1: 128 };
  /** inner map rect in CSS px relative to the host element */
  inner = { x: 0, y: 0, w: 1, h: 1 };
  hostRect = new DOMRect();
  zoom = 1;
  pan = { x: 0, y: 0 };
  labels: PlacedLabel[] = [];
  labelMs = 0;
  hoverMap: { x: number; y: number } | null = null;
  axes: AxisDraw[] = [];
  margin = { l: 30, r: 10, t: 8, b: 26 };
  names: string[] = [];
  nameHidden: (i: number) => boolean = () => false;
  hoverName = -1;
  private worker: Worker;
  private reqId = 0;
  private fullReq = 0;
  private fullDone = 0;
  private viewReq = 0;
  private viewDone = 0;
  /** labels for the whole slice (also used by the PNG export) */
  fullLabels: PlacedLabel[] = [];
  /** labels recomputed for the zoomed-in part of the map (null when not zoomed / stale) */
  viewLabels: PlacedLabel[] | null = null;
  private plainFaces: PlainFace[] = [];
  private metrics: NameMetric[] = [];
  private viewTimer = 0;
  onLabels: () => void = () => {};
  /**
   * The map is drawn into this (MSAA) target only when its content changes and blitted into the canvas
   * on other frames: the slice shader is by far the most expensive one (72 texel fetches per pixel)
   * and orbiting / exploding the 3D view doesn't change the map.
   */
  private cache: THREE.WebGLRenderTarget | null = null;
  private cacheDirty = true;
  private blitScene = new THREE.Scene();
  private blitMat: THREE.ShaderMaterial;
  private tmpGrid = new THREE.Vector3();
  private rawClear = new THREE.Color();
  private tmpRGB = { r: 0, g: 0, b: 0 };

  constructor(readonly host: HTMLElement, uniforms: Record<string, THREE.IUniform>) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: slice2DVertex,
      fragmentShader: sliceFragment,
      uniforms: { ...uniforms, uView: { value: new THREE.Vector4() }, uOpacity: { value: 1 }, uPick: { value: 0 }, uPickId: { value: 0 } },
      depthTest: false, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.blitMat = new THREE.ShaderMaterial({
      vertexShader: blitVertex, fragmentShader: blitFragment, uniforms: { uTex: { value: null } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat);
    quad.frustumCulled = false;
    this.blitScene.add(quad);
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'map-overlay';
    host.appendChild(this.overlay);
    this.ctx = this.overlay.getContext('2d')!;
    this.worker = new Worker(new URL('./labelWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<LabelResult>) => {
      const r = e.data;
      if (r.kind === 'view') {
        if (r.id <= this.viewDone || r.id < this.fullReq) return; // stale (a newer slice was requested)
        this.viewDone = r.id;
        this.viewLabels = r.labels;
      } else {
        if (r.id <= this.fullDone) return;
        this.fullDone = r.id;
        this.fullLabels = r.labels;
        this.labelMs = r.ms;
      }
      this.labels = this.zoom > VIEW_LABEL_ZOOM && this.viewLabels ? this.viewLabels : this.fullLabels;
      this.drawOverlay();
      this.onLabels();
    };
  }

  setVolume(labels: Uint8Array) {
    const copy = labels.slice(); // the app keeps its own copy for CPU lookups; transfer this one
    this.worker.postMessage({ type: 'volume', labels: copy }, [copy.buffer]);
    // labels placed on the previous volume (including requests the worker has yet to answer, which it
    // would compute on the new volume with the old names' metrics) must not be shown against new names
    clearTimeout(this.viewTimer);
    this.labels = this.fullLabels = [];
    this.viewLabels = null;
    this.fullReq = this.fullDone = this.viewReq = this.viewDone = this.reqId;
    this.invalidate();
    this.drawOverlay();
  }

  /** Mark the cached GL map stale (slice, view, uniforms, highlight or theme changed). */
  invalidate() { this.cacheDirty = true; }

  get pendingLabels() { return this.fullReq > this.fullDone || this.viewReq > this.viewDone; }

  setFaces(faces: MapFace[], metrics: NameMetric[], keepView: boolean) {
    const prevBounds = this.bounds;
    this.faces = faces;
    this.bounds = mapBounds(faces);
    if (!keepView || prevBounds.x1 - prevBounds.x0 !== this.bounds.x1 - this.bounds.x0 || prevBounds.y1 - prevBounds.y0 !== this.bounds.y1 - this.bounds.y0) {
      this.zoom = 1; this.pan.x = 0; this.pan.y = 0;
    }
    buildMapGeometry(faces, this.geometry);
    this.plainFaces = faces.map((f) => ({
      x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1,
      origin: [f.origin.x, f.origin.y, f.origin.z], ux: [f.ux.x, f.ux.y, f.ux.z], vy: [f.vy.x, f.vy.y, f.vy.z],
    }));
    this.metrics = metrics;
    this.fullReq = ++this.reqId;
    this.worker.postMessage({ type: 'label', req: { id: this.fullReq, kind: 'full', faces: this.plainFaces, names: metrics } });
    this.viewLabels = null; this.viewDone = this.viewReq;
    this.requestViewLabels(0);
  }

  /**
   * After zooming/panning settles, relabel just the visible part of the map at a finer raster, so
   * regions too small to label at full extent get labels when zoomed in.
   */
  requestViewLabels(delay = 140) {
    clearTimeout(this.viewTimer);
    if (this.zoom <= VIEW_LABEL_ZOOM) {
      if (this.viewLabels || this.viewReq > this.viewDone) {
        this.viewLabels = null; this.viewDone = this.viewReq;
        this.labels = this.fullLabels; this.drawOverlay(); this.onLabels();
      }
      return;
    }
    this.viewTimer = window.setTimeout(() => {
      const v = this.view(), I = this.inner;
      const [ax, ay] = this.toMap(v, I.x, I.y + I.h), [bx, by] = this.toMap(v, I.x + I.w, I.y);
      const faces: PlainFace[] = [];
      for (const f of this.plainFaces) {
        const x0 = Math.max(f.x0, ax), x1 = Math.min(f.x1, bx), y0 = Math.max(f.y0, ay), y1 = Math.min(f.y1, by);
        if (x1 - x0 > 1e-3 && y1 - y0 > 1e-3) faces.push({ ...f, x0, x1, y0, y1 });
      }
      if (!faces.length) return;
      this.viewReq = ++this.reqId;
      this.worker.postMessage({ type: 'label', req: { id: this.viewReq, kind: 'view', faces, names: this.metrics, emScale: 1 / this.zoom } });
    }, delay);
  }

  /** Recompute layout from the host element size. */
  layout() {
    this.hostRect = this.host.getBoundingClientRect();
    const r = this.hostRect, m = this.margin;
    this.inner = { x: m.l, y: m.t, w: Math.max(1, r.width - m.l - m.r), h: Math.max(1, r.height - m.t - m.b) };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (this.overlay.width !== W || this.overlay.height !== H) { this.overlay.width = W; this.overlay.height = H; }
  }

  view(): MapView {
    const b = this.bounds, I = this.inner;
    const fit = Math.min(I.w / (b.x1 - b.x0), I.h / (b.y1 - b.y0));
    return { cx: (b.x0 + b.x1) / 2 + this.pan.x, cy: (b.y0 + b.y1) / 2 + this.pan.y, s: fit * this.zoom };
  }

  toScreen(v: MapView, x: number, y: number): [number, number] {
    const I = this.inner;
    return [I.x + I.w / 2 + (x - v.cx) * v.s, I.y + I.h / 2 - (y - v.cy) * v.s];
  }
  toMap(v: MapView, sx: number, sy: number): [number, number] {
    const I = this.inner;
    return [v.cx + (sx - I.x - I.w / 2) / v.s, v.cy - (sy - I.y - I.h / 2) / v.s];
  }

  /**
   * Draw into the main canvas (we set and restore viewport/scissor). The map itself is re-rendered into
   * the cache target only when invalidated; otherwise the cached pixels are copied.
   */
  render(renderer: THREE.WebGLRenderer, canvasRect: DOMRect, clearColor: THREE.Color) {
    const r = this.hostRect, I = this.inner, v = this.view();
    const x = r.left - canvasRect.left + I.x, yTop = r.top - canvasRect.top + I.y;
    const y = canvasRect.height - yTop - I.h;
    const dpr = renderer.getPixelRatio();
    const W = Math.max(1, Math.round(I.w * dpr)), H = Math.max(1, Math.round(I.h * dpr));
    if (!this.cache) {
      this.cache = new THREE.WebGLRenderTarget(W, H, { samples: 4, type: THREE.UnsignedByteType, depthBuffer: false });
      this.cache.texture.minFilter = this.cache.texture.magFilter = THREE.NearestFilter;
      this.cache.texture.generateMipmaps = false;
      this.cacheDirty = true;
    } else if (this.cache.width !== W || this.cache.height !== H) {
      this.cache.setSize(W, H);
      this.cacheDirty = true;
    }
    const prevAlpha = renderer.getClearAlpha(), prevColor = renderer.getClearColor(new THREE.Color());
    if (this.cacheDirty) {
      this.cacheDirty = false;
      this.material.uniforms.uView.value.set(v.cx, v.cy, (2 * v.s) / I.w, (2 * v.s) / I.h);
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(this.cache);
      // our shaders write sRGB values as-is; three converts a clear colour to the target's (linear)
      // space, so hand it the sRGB numbers as if they were linear to get the same bytes as the canvas
      clearColor.getRGB(this.tmpRGB, THREE.SRGBColorSpace);
      this.rawClear.setRGB(this.tmpRGB.r, this.tmpRGB.g, this.tmpRGB.b, THREE.LinearSRGBColorSpace);
      renderer.setClearColor(this.rawClear, 1);
      renderer.clear();
      renderer.render(this.scene, this.camera);
      renderer.setRenderTarget(prevTarget);
    }
    this.blitMat.uniforms.uTex.value = this.cache.texture;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, I.w, I.h);
    renderer.setViewport(x, y, I.w, I.h);
    renderer.render(this.blitScene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, canvasRect.width, canvasRect.height);
    renderer.setClearColor(prevColor, prevAlpha);
  }

  /** sRGB color (0..1) shown at a map point, or null outside the slice. */
  private colorAt = (x: number, y: number): [number, number, number] | null => {
    const g = mapToGrid(this.faces, x, y, this.tmpGrid);
    return g ? [Math.min(1, g.x / 256), Math.min(1, g.y / 256), Math.min(1, g.z / 256)] : null;
  };

  /** Overlay: labels, axes, hover marker. */
  drawOverlay() {
    const ctx = this.ctx, dpr = this.overlay.width / Math.max(1, this.hostRect.width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = this.view(), I = this.inner;
    // the GL map shows through the inner rect; paint the margins (axes area) opaque
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--map-bg').trim() || '#15171c';
    ctx.fillRect(0, 0, this.hostRect.width, this.hostRect.height);
    ctx.clearRect(I.x, I.y, I.w, I.h);
    ctx.save();
    ctx.beginPath(); ctx.rect(I.x, I.y, I.w, I.h); ctx.clip();
    drawLabels(ctx, this.labels, this.names, (x, y) => this.toScreen(v, x, y), v.s, 7.5, this.nameHidden, this.hoverName, 64, this.colorAt);
    if (this.hoverMap) {
      const [sx, sy] = this.toScreen(v, this.hoverMap.x, this.hoverMap.y);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
    this.drawAxes(ctx, v);
  }

  private drawAxes(ctx: CanvasRenderingContext2D, v: MapView) {
    if (!this.axes.length) return;
    const b = this.bounds, I = this.inner;
    const [ax0, ay1] = this.toScreen(v, b.x0, b.y0);
    const [ax1, ay0] = this.toScreen(v, b.x1, b.y1);
    const css = getComputedStyle(this.host);
    ctx.fillStyle = css.getPropertyValue('--muted').trim() || '#9aa0aa';
    ctx.strokeStyle = ctx.fillStyle;
    ctx.font = `11px system-ui, sans-serif`;
    ctx.lineWidth = 1;
    for (const a of this.axes) {
      if (a.edge === 'bottom') {
        const y = Math.min(I.y + I.h + 6, ay1 + 6);
        const xa = Math.max(I.x, ax0), xb = Math.min(I.x + I.w, ax1);
        ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
        ctx.textBaseline = 'top';
        ctx.textAlign = 'center'; ctx.fillText(a.label, (xa + xb) / 2, y + 3);
        if (!Number.isNaN(a.from)) {
          // when zoomed past an end of the axis, show the value at the visible edge instead
          const at = (sx: number) => axisValue(a, (sx - ax0) / Math.max(1e-9, ax1 - ax0));
          ctx.textAlign = 'left'; ctx.fillText(String(ax0 >= I.x - 1 ? a.from : at(xa)), xa, y + 3);
          ctx.textAlign = 'right'; ctx.fillText(String(ax1 <= I.x + I.w + 1 ? a.to : at(xb)), xb, y + 3);
        }
      } else {
        const x = Math.max(I.x - 6, ax0 - 6);
        const ya = Math.max(I.y, ay0), yb = Math.min(I.y + I.h, ay1);
        ctx.beginPath(); ctx.moveTo(x, ya); ctx.lineTo(x, yb); ctx.stroke();
        ctx.save(); ctx.translate(x - 4, (ya + yb) / 2); ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(a.label, 0, 0);
        ctx.restore();
        if (!Number.isNaN(a.from)) {
          // screen y grows downwards: the axis runs from ay1 (bottom, a.from) to ay0 (top, a.to)
          const at = (sy: number) => axisValue(a, (ay1 - sy) / Math.max(1e-9, ay1 - ay0));
          ctx.save(); ctx.textBaseline = 'bottom';
          ctx.translate(x - 4, yb); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'left';
          ctx.fillText(String(ay1 <= I.y + I.h + 1 ? a.from : at(yb)), 0, 0);
          ctx.restore(); ctx.save(); ctx.textBaseline = 'bottom';
          ctx.translate(x - 4, ya); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'right';
          ctx.fillText(String(ay0 >= I.y - 1 ? a.to : at(ya)), 0, 0);
          ctx.restore();
        }
      }
    }
  }

  /** High-resolution PNG of the current slice (full extent, not the zoomed view). */
  async exportPNG(renderer: THREE.WebGLRenderer, longSide: number, title: string): Promise<Blob> {
    const b = this.bounds;
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const pad = Math.round(longSide * 0.03);
    const s = (longSide - 2 * pad) / Math.max(bw, bh);
    const W = Math.round(bw * s), H = Math.round(bh * s);
    const target = new THREE.WebGLRenderTarget(W, H, { samples: 4, type: THREE.UnsignedByteType });
    const u = this.material.uniforms;
    const prevBorder = u.uBorderPx.value as number;
    u.uView.value.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (2 * s) / W, (2 * s) / H);
    u.uBorderPx.value = Math.max(2, s * 0.9);
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    const px = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(target, 0, 0, W, H, px);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(0x000000, prevClear);
    u.uBorderPx.value = prevBorder;
    target.dispose();

    const canvas = document.createElement('canvas');
    const footer = Math.round(longSide * 0.035);
    canvas.width = W + 2 * pad; canvas.height = H + 2 * pad + footer;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = new ImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.drawImage(tmp, pad, pad);
    ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(2, s * 0.6);
    const toS = (x: number, y: number): [number, number] => [pad + (x - b.x0) * s, pad + (b.y1 - y) * s];
    // thin black frame around the map (xkcd style)
    const outline = this.outline();
    if (outline.length) {
      ctx.beginPath();
      outline.forEach(([x, y], i) => { const [sx, sy] = toS(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
      ctx.closePath(); ctx.stroke();
    }
    drawLabels(ctx, this.fullLabels, this.names, toS, s, 0, () => false, -1, Infinity, this.colorAt);
    ctx.fillStyle = '#333';
    ctx.font = `${Math.round(footer * 0.55)}px system-ui, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(title, pad, H + 2 * pad + footer / 2 - pad / 2);
    ctx.textAlign = 'right';
    ctx.fillText('data: xkcd color survey (2010)', W + pad, H + 2 * pad + footer / 2 - pad / 2);
    return new Promise((res, rej) => canvas.toBlob((bl) => (bl ? res(bl) : rej(new Error('toBlob failed'))), 'image/png'));
  }

  /** Outline polygon (map units) of the map content, for framing. */
  outline(): [number, number][] {
    const f = this.faces[0];
    if (!f) return [];
    return f.pos3.map((p) => {
      const rel = p.clone().sub(f.origin);
      return [rel.dot(f.ux), rel.dot(f.vy)] as [number, number];
    });
  }

  dispose() {
    this.geometry.dispose(); this.material.dispose(); this.worker.terminate(); this.overlay.remove();
    this.cache?.dispose(); this.blitMat.dispose();
  }
}

/** Channel value at fraction t (0..1) along an axis running from a.from to a.to. */
function axisValue(a: AxisDraw, t: number): number {
  const v = a.from + Math.min(1, Math.max(0, t)) * (a.to - a.from);
  return Math.round(Math.min(255, Math.max(0, v)));
}

/** WCAG relative luminance of an sRGB color (components 0..1). */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const LIGHT_BG = 0.6; // above this background luminance labels switch to dark ink

export function drawLabels(ctx: CanvasRenderingContext2D, labels: PlacedLabel[], names: string[],
  toScreen: (x: number, y: number) => [number, number], s: number, minCapPx: number,
  hidden: (i: number) => boolean, hoverName: number, maxPx = Infinity,
  colorAt: (x: number, y: number) => [number, number, number] | null = () => null) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  for (const l of labels) {
    const F = Math.min(maxPx, l.size * s);
    if (F * CAP_EM < minCapPx || !names[l.name]) continue;
    const [sx, sy] = toScreen(l.x, l.y);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-l.angle);
    ctx.font = `${F.toFixed(1)}px ${LABEL_FONT}`;
    ctx.globalAlpha = hidden(l.name) ? 0.35 : 1;
    const n = l.lines.length;
    // xkcd look: white letters with a faint dark halo; on light regions (near the white corner, pale
    // yellows...) that vanishes, so switch to dark letters with a light halo there
    const bg = colorAt(l.x, l.y), lum = bg ? luminance(bg) : 0;
    const light = lum > LIGHT_BG;
    const hover = l.name === hoverName;
    ctx.lineWidth = Math.max(1.6, F * 0.11) * (hover ? 2.2 : 1);
    ctx.strokeStyle = hover ? 'rgba(255,196,0,0.95)'
      : light ? 'rgba(255,255,255,0.55)'
      : `rgba(0,0,0,${(0.28 + 0.3 * Math.min(1, Math.max(0, (lum - 0.3) / 0.3))).toFixed(3)})`;
    for (let i = 0; i < n; i++) {
      const y = (i - (n - 1) / 2) * LINE_EM * F + (CAP_EM * F) / 2;
      ctx.strokeText(l.lines[i], 0, y);
    }
    ctx.fillStyle = light ? '#222222' : '#ffffff';
    for (let i = 0; i < n; i++) {
      const y = (i - (n - 1) / 2) * LINE_EM * F + (CAP_EM * F) / 2;
      ctx.fillText(l.lines[i], 0, y);
    }
    ctx.restore();
  }
}

/** Font metrics for the worker: widths in em of each name (uppercase), one line and two lines. */
export function measureNames(names: string[]): NameMetric[] {
  const c = document.createElement('canvas').getContext('2d')!;
  c.font = `100px ${LABEL_FONT}`;
  return names.map((nm) => {
    const text = nm.toUpperCase();
    const w1 = c.measureText(text).width / 100;
    let lines2: [string, string] | null = null, w2 = Infinity;
    const words = text.split(/\s+/);
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
      const w = Math.max(c.measureText(a).width, c.measureText(b).width) / 100;
      if (w < w2) { w2 = w; lines2 = [a, b]; }
    }
    return { text, w1, lines2, w2: lines2 ? w2 : 0 };
  });
}
