// Core: renderer, scene, state, interaction. UI wiring lives in ui.ts.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BlobSet, makeSharedBlobUniforms } from './blobs';
import { gridToByte, loadLevel, majorityLabel, toHex, type LevelData, type LevelInfo, type LevelsFile } from './data';
import { Labels3D, type LabelSpot } from './labels3d';
import { HandlePlacer } from './handleSpot';
import { Map2D, measureNames } from './map2d';
import type { NameMetric } from './labeler';
import { buildPlaneGeometry, hueDir, mapToGrid, SliceState, type Orientation } from './slice';
import { backingFragment, backingPickFragment, backingVertex, flatPickFragment, flatPickVertex, slice3DVertex, sliceFragment } from './shaders';

export interface HoverInfo {
  kind: 'blob' | 'plane' | 'face' | 'map';
  comp: number;        // -1 if not a blob
  name: number;
  grid: THREE.Vector3; // grid point under the cursor
  clientX: number; clientY: number;
}

type Listener = () => void;

const DOLLY = 0.75;
// pick ids: comp + 1 for blobs; the backing box (cube faces showing through hairline gaps while assembled)
// writes PICK_FACE plus the face-snapped grid point, resolved to a name like the plane
const PICK_NONE = 0, PICK_PLANE = -1, PICK_HANDLE = -2, PICK_FACE = -3;
const HOVER_REPICK_MS = 100; // re-pick under a still cursor at most this often while the view moves
const CAMERA_HOME = new THREE.Vector3(1.2, 0.82, 1.38).normalize().multiplyScalar(960);
// Hues-mode drags: the gray axis and a right-handed basis around it (angle grows with hue)
const GRAY = new THREE.Vector3(1, 1, 1).normalize();
const E1 = hueDir(0), E2 = new THREE.Vector3().crossVectors(GRAY, E1);

export class App {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 1, 6000);
  readonly controls: OrbitControls;
  readonly slice = new SliceState();
  readonly shared = makeSharedBlobUniforms();
  readonly sliceUniforms: Record<string, THREE.IUniform>;
  readonly map: Map2D;
  readonly labels3d: Labels3D;

  levels: LevelsFile | null = null;
  level: LevelData | null = null;
  blobs: BlobSet | null = null;
  nameVisible: boolean[] = [];
  metrics: NameMetric[] = [];

  explode = 0;
  explodeTarget = 0;
  lastExplode = 0.55;
  clipOn = true;
  clipSide = 1;
  showSlice3D = true;
  labelsOn = true;
  mapVisible = true;

  hover: HoverInfo | null = null;
  hoverName = -1;     // name highlighted from legend / map
  private hoverComp = -1;

  private labelTexture: THREE.Data3DTexture | null = null;
  private nameMask: THREE.DataTexture;
  private planeGeom = new THREE.BufferGeometry();
  private planeMat: THREE.ShaderMaterial;
  private planePickMat: THREE.ShaderMaterial;
  private plane: THREE.Mesh;
  private outline: THREE.LineLoop;
  private outlineGhost: THREE.LineLoop;
  private handle: THREE.Group;
  private handleMat: THREE.MeshBasicMaterial;
  private handlePickMat: THREE.ShaderMaterial;
  private marker: THREE.Mesh;
  private decor = new THREE.Group();
  private backing: THREE.Mesh;
  private backingMat: THREE.ShaderMaterial;
  private backingPickMat: THREE.ShaderMaterial;
  private pickTarget: THREE.WebGLRenderTarget;
  private pickBuf = new Float32Array(4);
  // low-resolution id render used to place 3D labels on visible parts of blobs
  private spotTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
  private spotBuf = new Float32Array(0);
  private spotIds = new Int32Array(0);
  private spotDist = new Float32Array(0);
  private spotAt = -1e9;
  private spotPending = true;
  private spotBusy = false;
  labelSpots: (LabelSpot | null)[] | null = null;
  spotMs = 0;
  private canvasRect = new DOMRect();

  private dirty = true;
  private overlayDirty = true;
  private labels3dDirty = true;
  private lastTime = performance.now();
  private sliceVersionSeen = -1;
  private listeners: Listener[] = [];
  private stateListeners: Listener[] = [];
  frameTimes: number[] = [];
  continuous = false;

  // interaction
  /** Hues mode: the hue at grab time and the previous pointer position */
  private dragPlane: {
    start: THREE.Vector3; offset0: number; pointerId: number; y0: number;
    hue0: number; prev: { x: number; y: number };
  } | null = null;
  private downAt: { x: number; y: number; t: number } | null = null;
  private pendingHover: { x: number; y: number } | null = null;
  /** last cursor position over the canvas with no button held (null when outside / dragging) */
  private lastPointer: { x: number; y: number } | null = null;
  /** the scene moved under a still cursor: hover/tooltip need a re-pick */
  private hoverStale = false;
  private lastHoverAt = 0;
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpV3 = new THREE.Vector3();
  private ray = new THREE.Ray();
  private ndc = new THREE.Vector2();

  constructor(readonly base: string) {
    this.canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; // only affects three's built-in materials (decor)
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.sortObjects = true;
    this.renderer.info.autoReset = false;

    this.camera.position.copy(CAMERA_HOME);
    // Shift the projection centre so the cube sits in the part of the window not covered by panels.
    // Applied after three's own projection update so it composes with setViewOffset (used by picking).
    const cam = this.camera, baseUpdate = cam.updateProjectionMatrix.bind(cam);
    cam.updateProjectionMatrix = () => {
      baseUpdate();
      const w = this.canvasRect.width || 1, h = this.canvasRect.height || 1;
      const v = cam.view;
      const kx = v && v.enabled ? v.fullWidth / v.width : 1, ky = v && v.enabled ? v.fullHeight / v.height : 1;
      const sx = (2 * this.viewShift.x) / w, sy = (-2 * this.viewShift.y) / h; // NDC shift
      cam.projectionMatrix.elements[8] -= sx * kx;
      cam.projectionMatrix.elements[9] -= sy * ky;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    };
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 120;
    this.controls.maxDistance = 2200;
    this.controls.autoRotateSpeed = 0.8;
    this.controls.addEventListener('change', () => { this.dirty = true; this.labels3dDirty = true; this.hoverStale = true; });

    this.root.position.set(-128, -128, -128);
    this.scene.add(this.root);
    this.buildDecor();
    // exactly on the cube faces; the vertex shader pushes it back along the view ray
    const bg = new THREE.BoxGeometry(256, 256, 256).translate(128, 128, 128);
    const backingUniforms = { uShade: this.shared.uShade, uClip: this.shared.uClip, uClipSide: this.shared.uClipSide, uClipOn: this.shared.uClipOn };
    this.backingMat = new THREE.ShaderMaterial({ vertexShader: backingVertex, fragmentShader: backingFragment, uniforms: backingUniforms });
    this.backingPickMat = new THREE.ShaderMaterial({
      vertexShader: backingVertex, fragmentShader: backingPickFragment, uniforms: { ...backingUniforms, uPickId: { value: PICK_FACE } },
    });
    this.backing = new THREE.Mesh(bg, this.backingMat);
    this.backing.renderOrder = 1; // after the blobs, so it only fills the gaps (early-z rejects the rest)
    this.root.add(this.backing);

    // name mask (r = visible, g = highlighted)
    this.nameMask = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.nameMask.minFilter = this.nameMask.magFilter = THREE.NearestFilter;
    this.nameMask.needsUpdate = true;

    this.sliceUniforms = {
      uLabels: this.shared.uLabels,
      uNameMask: { value: this.nameMask },
      uBorderPx: { value: 1.5 * this.renderer.getPixelRatio() },
      uBlur: { value: 1 },
      uDimHidden: { value: 1 },
    };

    // in-scene slice plane
    this.planeMat = new THREE.ShaderMaterial({
      vertexShader: slice3DVertex, fragmentShader: sliceFragment,
      uniforms: { ...this.sliceUniforms, uOpacity: { value: 1 }, uHiddenAlpha: { value: 1 }, uPick: { value: 0 }, uPickId: { value: PICK_PLANE } },
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    });
    this.planePickMat = new THREE.ShaderMaterial({
      vertexShader: slice3DVertex, fragmentShader: sliceFragment,
      uniforms: { ...this.sliceUniforms, uOpacity: { value: 1 }, uHiddenAlpha: { value: 1 }, uPick: { value: 1 }, uPickId: { value: PICK_PLANE } },
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    });
    this.plane = new THREE.Mesh(this.planeGeom, this.planeMat);
    this.plane.renderOrder = 2;
    this.root.add(this.plane);
    // a plane cuts the cube in at most 6 points: preallocate and draw the first n (setDrawRange)
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    lineGeom.setDrawRange(0, 0);
    this.outline = new THREE.LineLoop(lineGeom, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    this.outlineGhost = new THREE.LineLoop(lineGeom, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthTest: false }));
    this.outline.renderOrder = 3; this.outlineGhost.renderOrder = 4;
    this.outline.frustumCulled = this.outlineGhost.frustumCulled = false;
    this.root.add(this.outline, this.outlineGhost);

    // drag handle: double arrow along the plane normal
    this.handleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, depthTest: false });
    this.handlePickMat = new THREE.ShaderMaterial({ vertexShader: flatPickVertex, fragmentShader: flatPickFragment, uniforms: { uPickId: { value: PICK_HANDLE } }, depthTest: false });
    this.handle = new THREE.Group();
    const backMat = new THREE.MeshBasicMaterial({ color: 0x0b0d11, transparent: true, opacity: 0.55, depthTest: false });
    const arrow = (mat: THREE.Material, grow: number, order: number) => {
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.1 + grow, 1.1 + grow, 22, 12), mat);
      const c1 = new THREE.Mesh(new THREE.ConeGeometry(4 + grow * 1.6, 9 + grow * 2, 24), mat); c1.position.y = 15;
      const c2 = c1.clone(); c2.position.y = -15; c2.rotation.z = Math.PI;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(2.8 + grow, 16, 12), mat);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(9, 0.9 + grow, 8, 48), mat); ring.rotation.x = Math.PI / 2;
      g.add(shaft, c1, c2, ball, ring);
      g.traverse((o) => { o.renderOrder = order; });
      return g;
    };
    this.handle.add(arrow(backMat, 1.1, 19), arrow(this.handleMat, 0, 20));
    this.root.add(this.handle);

    this.marker = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
    this.marker.renderOrder = 30; this.marker.visible = false;
    this.root.add(this.marker);

    this.pickTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });

    this.map = new Map2D(document.getElementById('map-host')!, this.sliceUniforms);
    this.map.onLabels = () => this.emit();
    this.map.nameHidden = (i) => this.nameVisible[i] === false;
    this.labels3d = new Labels3D(document.getElementById('labels3d')!);

    this.bindPointer();
    window.addEventListener('resize', () => this.resize());
    // theme change: MAP_BG is re-read by a module-level listener registered before this one
    window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => { this.map.invalidate(); this.dirty = true; this.overlayDirty = true; });
    if (!this.renderer.extensions.has('EXT_color_buffer_float')) {
      console.warn('EXT_color_buffer_float is not available: hover, click and plane dragging (float pick targets) will not work');
    }
    new ResizeObserver(() => this.layoutMap()).observe(this.map.host);
    this.resize();
    requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- events for UI
  onChange(fn: Listener) { this.listeners.push(fn); }
  onState(fn: Listener) { this.stateListeners.push(fn); }
  private emit() { for (const f of this.listeners) f(); }
  emitState() { for (const f of this.stateListeners) f(); this.dirty = true; this.hoverStale = true; }
  requestRender() { this.dirty = true; }

  // ---------------------------------------------------------------- scene decor
  private buildDecor() {
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(256, 256, 256));
    const box = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x8b93a3, transparent: true, opacity: 0.28 }));
    box.position.set(128, 128, 128);
    this.decor.add(box);
    const axis = (to: THREE.Vector3, color: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), to]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    };
    this.decor.add(axis(new THREE.Vector3(290, 0, 0), 0xff4d4d), axis(new THREE.Vector3(0, 290, 0), 0x45d65a), axis(new THREE.Vector3(0, 0, 290), 0x4d86ff));
    this.root.add(this.decor);
  }

  /** Screen positions for the R/G/B axis-end labels. */
  axisLabelPositions(out: { x: number; y: number; vis: boolean }[]) {
    // pushed out with the explode so the letters don't land on the exploded blobs, but pulled back
    // along the axis when that would put them off-canvas or under a panel (where they'd be hidden)
    const Lmax = 300 + 256 * this.explode, STEPS = 8, M = 10;
    const w = this.canvasRect.width, h = this.canvasRect.height, ox = this.canvasRect.left, oy = this.canvasRect.top;
    const avoid = this.avoidRects;
    for (let i = 0; i < 3; i++) {
      let p: { x: number; y: number; vis: boolean } | null = null;
      for (let s = 0; s <= STEPS; s++) {
        const L = Lmax - ((Lmax - 300) * s) / STEPS;
        this.tmpV.set(i === 0 ? L : 0, i === 1 ? L : 0, i === 2 ? L : 0).subScalar(128).project(this.camera);
        const q = { x: (this.tmpV.x * 0.5 + 0.5) * w, y: (-this.tmpV.y * 0.5 + 0.5) * h, vis: this.tmpV.z < 1 };
        if (!p) p = q;
        const cx = q.x + ox, cy = q.y + oy;
        const free = q.vis && q.x > M && q.x < w - M && q.y > M && q.y < h - M &&
          !avoid.some((r) => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1);
        if (free) { p = q; break; }
        if (Lmax - 300 < 1) break;
      }
      out[i] = p!;
    }
  }

  // ---------------------------------------------------------------- loading
  async setLevel(info: LevelInfo, progress: (f: number, what: string) => void) {
    const data = await loadLevel(this.base, info, progress);
    // dispose previous GPU resources
    if (this.blobs) { this.blobs.dispose(); this.blobs = null; }
    if (this.labelTexture) { this.labelTexture.dispose(); this.labelTexture = null; }
    this.level = data;
    const tex = new THREE.Data3DTexture(data.labels, 256, 256, 256);
    tex.format = THREE.RedIntegerFormat;
    tex.type = THREE.UnsignedByteType;
    tex.internalFormat = 'R8UI';
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.labelTexture = tex;
    this.sliceUniforms.uLabels.value = tex;

    this.blobs = new BlobSet(data, this.shared);
    this.blobs.setExplode(this.explode);
    this.blobs.setClipping(this.clipActive());
    this.root.add(this.blobs.group);
    const names = data.meta.names.map((n) => n.name);
    this.nameVisible = names.map(() => true);
    this.hoverComp = -1; this.hoverName = -1; this.hover = null;
    this.blobs.setNameVisibility(this.nameVisible);
    this.updateNameMask();

    // swap the map's names and volume together (drops labels placed for the previous level)
    this.map.names = names.map((n) => n.toUpperCase());
    this.map.setVolume(data.labels);
    this.map.invalidate();
    await document.fonts.load(`100px "xkcd-script"`).catch(() => undefined);
    this.metrics = measureNames(names);
    this.labels3d.build(this.blobs, (i) => names[i]);
    this.sliceVersionSeen = -1;
    // compile shaders up-front so the first interaction doesn't hitch
    this.renderer.compile(this.scene, this.camera);
    progress(1, 'ready');
    this.labels3dDirty = true;
    this.emitState();
  }

  // ---------------------------------------------------------------- state mutations
  clipActive() { return this.clipOn && this.showSlice3D; }

  setExplode(k: number, animate = true) {
    this.explodeTarget = Math.max(0, Math.min(1, k));
    if (this.explodeTarget > 0.02) this.lastExplode = this.explodeTarget;
    if (!animate) {
      const ratio = (1 + DOLLY * this.explodeTarget) / (1 + DOLLY * this.explode);
      this.camera.position.sub(this.controls.target).multiplyScalar(ratio).add(this.controls.target);
      this.explode = this.explodeTarget;
      this.blobs?.setExplode(this.explode);
      this.labels3dDirty = true;
    }
    this.dirty = true;
    this.emitState();
  }
  toggleExplode() { this.setExplode(this.explodeTarget > 0.02 ? 0 : this.lastExplode || 0.55); }

  setShade(v: number) { this.shared.uShade.value = v; this.emitState(); }
  setOrientation(o: Orientation) { this.slice.setOrientation(o); this.emitState(); }
  setSliderValue(v: number) { this.slice.setSliderValue(v); this.emitState(); }
  nudgeSlice(steps: number) {
    this.slice.setSliderValue(this.slice.sliderValue + steps);
    this.emitState();
  }
  setAngles(az: number, el: number) { this.slice.setAngles(az, el); this.emitState(); }
  setClip(on: boolean) { this.clipOn = on; this.emitState(); }
  flipClip() { this.clipSide = -this.clipSide; this.slice.setViewSign(this.clipSide); this.emitState(); }
  setShowSlice(on: boolean) { this.showSlice3D = on; this.emitState(); }
  setBlur(v: number) { this.sliceUniforms.uBlur.value = v; this.map.invalidate(); this.dirty = true; this.emitState(); }
  setLabelsOn(on: boolean) { this.labelsOn = on; this.labels3dDirty = true; this.emitState(); }
  setSpin(on: boolean) { this.controls.autoRotate = on; this.emitState(); }
  resetCamera() {
    this.camera.position.copy(CAMERA_HOME).multiplyScalar(1 + DOLLY * this.explode); this.controls.target.set(0, 0, 0); this.camera.up.set(0, 1, 0);
    this.controls.update(); this.dirty = true;
  }
  setMapVisible(on: boolean) { this.mapVisible = on; this.emitState(); this.layoutMap(); }

  /** Solo a name: if it is already the only visible one, show everything. */
  solo(name: number) {
    const only = this.nameVisible.every((v, i) => v === (i === name));
    this.nameVisible = this.nameVisible.map((_, i) => only || i === name);
    this.applyVisibility();
  }
  toggleName(name: number) { this.nameVisible[name] = !this.nameVisible[name]; this.applyVisibility(); }
  showAll() { this.nameVisible = this.nameVisible.map(() => true); this.applyVisibility(); }
  setVisibility(v: boolean[]) { this.nameVisible = v; this.applyVisibility(); }
  private applyVisibility() {
    this.blobs?.setNameVisibility(this.nameVisible);
    this.updateNameMask();
    this.placeHandle();
    this.labels3dDirty = true;
    this.overlayDirty = true; // map labels of hidden names are dimmed in the Canvas2D overlay
    this.emitState();
  }
  get anyHidden() { return this.nameVisible.some((v) => !v); }

  setHoverName(i: number) {
    if (i === this.hoverName) return;
    this.hoverName = i;
    this.updateNameMask();
    this.updateHighlightTargets();
    this.map.hoverName = i;
    this.overlayDirty = true;
    this.dirty = true;
  }

  private updateHighlightTargets() {
    if (!this.blobs) return;
    const comps = this.blobs.level.meta.components;
    const t = this.blobs.highlightTarget;
    for (let i = 0; i < t.length; i++) t[i] = i === this.hoverComp ? 1 : comps[i].nameIndex === this.hoverName ? 0.75 : 0;
  }

  private updateNameMask() {
    const d = this.nameMask.image.data as Uint8Array;
    d.fill(0);
    for (let i = 0; i < 256; i++) {
      d[i * 4] = this.nameVisible[i] === false ? 0 : 255;
      d[i * 4 + 1] = i === this.hoverName ? 255 : 0;
      d[i * 4 + 3] = 255;
    }
    this.nameMask.needsUpdate = true;
    this.map.invalidate();
    this.dirty = true;
  }

  // ---------------------------------------------------------------- layout
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.canvasRect = this.canvas.getBoundingClientRect();
    this.camera.aspect = w / h;
    // keep the cube framed horizontally on portrait screens
    const baseFov = 32, tanH = Math.tan(THREE.MathUtils.degToRad(baseFov / 2));
    this.camera.fov = this.camera.aspect >= 1.15 ? baseFov : Math.min(70, 2 * THREE.MathUtils.radToDeg(Math.atan((tanH * 1.15) / this.camera.aspect)));
    this.camera.updateProjectionMatrix();
    this.canvasRect = this.canvas.getBoundingClientRect();
    this.sliceUniforms.uBorderPx.value = 1.5 * this.renderer.getPixelRatio();
    this.map.invalidate();
    this.layoutMap();
    this.dirty = true; this.labels3dDirty = true;
  }

  /** Pixel offset of the 3D view centre (positive = right / down). */
  viewShift = { x: 0, y: 0 };
  updateViewShift() {
    const w = this.canvasRect.width, h = this.canvasRect.height;
    let left = 0, right = w, top = 0, bottom = h;
    const side = document.getElementById('side');
    if (side && !side.classList.contains('collapsed') && w > 700) left = side.offsetLeft + side.offsetWidth;
    const mp = document.getElementById('map-panel');
    let cx = (left + right) / 2;
    if (mp && !mp.hidden) {
      if (w <= 700) bottom = mp.offsetTop;
      // docked bottom-right: centre the cube in the strip left of it
      else if (mp.offsetHeight > 0.4 * h) cx = (left + mp.offsetLeft) / 2;
    }
    this.viewShiftTarget.x = cx - w / 2;
    this.viewShiftTarget.y = (top + bottom) / 2 - h / 2;
    if (!this.level) { this.viewShift.x = this.viewShiftTarget.x; this.viewShift.y = this.viewShiftTarget.y; this.camera.updateProjectionMatrix(); }
  }
  private viewShiftTarget = { x: 0, y: 0 };
  private stepViewShift(dt: number) {
    const t = this.viewShiftTarget, v = this.viewShift;
    if (Math.abs(t.x - v.x) < 0.3 && Math.abs(t.y - v.y) < 0.3) {
      if (t.x === v.x && t.y === v.y) return;
      v.x = t.x; v.y = t.y;
    } else {
      const a = 1 - Math.exp(-dt * 10);
      v.x += (t.x - v.x) * a; v.y += (t.y - v.y) * a;
    }
    this.camera.updateProjectionMatrix();
    this.dirty = true; this.labels3dDirty = true;
  }

  layoutMap() {
    this.updateViewShift();
    this.map.layout();
    this.map.invalidate();
    this.map.requestViewLabels();
    this.overlayDirty = true;
    this.labels3dDirty = true;
    this.dirty = true;
  }

  // ---------------------------------------------------------------- slice sync
  private syncSlice() {
    if (this.slice.version === this.sliceVersionSeen || !this.level) return;
    const prevOrientation = this.lastOrientation;
    this.sliceVersionSeen = this.slice.version;
    this.lastOrientation = this.slice.orientation;
    const faces = this.slice.faces();
    buildPlaneGeometry(faces, this.planeGeom);
    // outline
    const pts = faces[0].pos3;
    const lg = this.outline.geometry, lp = lg.getAttribute('position') as THREE.BufferAttribute;
    const n = Math.min(pts.length, lp.count);
    for (let i = 0; i < n; i++) lp.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
    lp.needsUpdate = true;
    lg.setDrawRange(0, n);
    this.hasPolygon = pts.length > 0;
    this.polygon = pts;
    this.placeHandle();
    this.slice.clipVec4(this.shared.uClip.value);
    this.map.setFaces(faces, this.metrics, prevOrientation === this.slice.orientation);
    this.map.axes = this.slice.axisNotes().map((a) => ({ edge: a.edge as 'bottom' | 'left', label: a.label, from: a.from, to: a.to }));
    this.map.invalidate();
    this.overlayDirty = true;
    this.dirty = true;
    this.emit();
  }
  private lastOrientation: Orientation | null = null;
  private polygon: THREE.Vector3[] = [];
  private handlePlacer = new HandlePlacer();

  /**
   * Handle at the polygon centroid; Hues mode: out on the hue side (the centroid is on the axis, which has no
   * leverage for a rotating drag). With names hidden, the nearest spot to that whose drag path never covers a
   * visible name, if there is one.
   */
  private placeHandle() {
    const pts = this.polygon;
    if (!pts.length) return;
    const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    if (this.slice.orientation === 'hues') {
      const h = hueDir(this.slice.hue), o = this.slice.center();
      const reach = Math.max(...pts.map((p) => p.clone().sub(o).dot(h)));
      c.copy(o).addScaledVector(h, 0.6 * reach);
    }
    if (this.anyHidden && this.level) {
      const spot = this.handlePlacer.place(this.level.labels, this.nameVisible, this.slice, c);
      if (spot) c.copy(spot);
    }
    this.handle.position.copy(c);
    this.handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.slice.normal);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- picking
  /**
   * Render the id/grid pass (pick materials) into a float target with the current camera. The plane and
   * its handle are included only when asked (and visible); the backing box takes part while it is drawn.
   */
  private renderIds(target: THREE.WebGLRenderTarget, withPlane: boolean, withHandle = withPlane) {
    const restore = this.blobs!.usePickMaterial();
    const decorVis = this.decor.visible, outVis = this.outline.visible, ghostVis = this.outlineGhost.visible, markVis = this.marker.visible;
    const planeVis = this.plane.visible, handleVis = this.handle.visible;
    this.decor.visible = this.outline.visible = this.outlineGhost.visible = this.marker.visible = false;
    if (!withPlane) this.plane.visible = false;
    if (!withHandle) this.handle.visible = false;
    this.plane.material = this.planePickMat;
    this.backing.material = this.backingPickMat;
    const handleMeshes: THREE.Mesh[] = [];
    this.handle.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { handleMeshes.push(m); m.userData.mat = m.material; m.material = this.handlePickMat; }
    });
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(0x000000, prevAlpha);
    restore();
    this.plane.material = this.planeMat;
    this.backing.material = this.backingMat;
    for (const m of handleMeshes) m.material = m.userData.mat as THREE.Material;
    this.decor.visible = decorVis; this.outline.visible = outVis; this.outlineGhost.visible = ghostVis; this.marker.visible = markVis;
    this.plane.visible = planeVis; this.handle.visible = handleVis;
  }

  /**
   * GPU pick at client coords: returns id (comp+1, PICK_PLANE, PICK_HANDLE, PICK_FACE or 0) and grid point.
   * While the plane is faded (exploded view) it is only a ghost: blobs and the handle are picked first,
   * and the plane only where nothing else is under the cursor.
   */
  pick(clientX: number, clientY: number): { id: number; grid: THREE.Vector3 } {
    const r = this.canvasRect;
    const x = clientX - r.left, y = clientY - r.top;
    const res = { id: PICK_NONE, grid: new THREE.Vector3() };
    if (!this.blobs || x < 0 || y < 0 || x >= r.width || y >= r.height) return res;
    this.syncSlice();
    this.syncState();
    const dpr = this.renderer.getPixelRatio();
    this.camera.setViewOffset(r.width * dpr, r.height * dpr, Math.floor(x * dpr), Math.floor(y * dpr), 1, 1);
    const ghost = this.planeGhost;
    this.renderIds(this.pickTarget, !ghost, true);
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, this.pickBuf);
    if (ghost && Math.round(this.pickBuf[0]) === PICK_NONE && this.plane.visible) {
      this.renderIds(this.pickTarget, true, true);
      this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, this.pickBuf);
    }
    this.camera.clearViewOffset();
    res.id = Math.round(this.pickBuf[0]);
    res.grid.set(this.pickBuf[1], this.pickBuf[2], this.pickBuf[3]);
    return res;
  }

  /**
   * Label spots: render ids at 1/SPOT_DS resolution, chamfer distance transform to the edges of each
   * component's visible area (screen edges and panels count as edges), and per component keep the
   * pixel with the largest clearance (ties broken towards its projected interior anchor).
   */
  private async computeLabelSpots() {
    if (!this.blobs || !this.level) { this.labelSpots = null; return; }
    if (this.spotBusy) { this.spotPending = true; return; }
    const S = SPOT_DS, cw = this.canvasRect.width, ch = this.canvasRect.height;
    const W = Math.max(8, Math.ceil(cw / S)), H = Math.max(8, Math.ceil(ch / S)), N = W * H;
    if (this.spotTarget.width !== W || this.spotTarget.height !== H) this.spotTarget.setSize(W, H);
    if (this.spotBuf.length !== N * 4) { this.spotBuf = new Float32Array(N * 4); this.spotIds = new Int32Array(N); this.spotDist = new Float32Array(N); }
    let t0 = performance.now();
    this.syncState();
    this.renderIds(this.spotTarget, false);
    const buf = this.spotBuf, ids = this.spotIds, dist = this.spotDist, level = this.level;
    // asynchronous readback (PBO + fence): no pipeline stall on the main thread
    this.spotBusy = true;
    let cpu = performance.now() - t0;
    try { await this.renderer.readRenderTargetPixelsAsync(this.spotTarget, 0, 0, W, H, buf); }
    catch { this.spotBusy = false; return; }
    this.spotBusy = false;
    if (level !== this.level || !this.blobs || buf !== this.spotBuf) return; // level switched / resized meanwhile
    t0 = performance.now();
    // flip rows so y grows downwards (screen order); panels mask out pixels
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W;
      for (let x = 0; x < W; x++) ids[y * W + x] = Math.round(buf[(src + x) * 4]);
    }
    for (const r of this.avoidRects) {
      const x0 = Math.max(0, Math.floor((r.x0 - this.canvasRect.left) / S)), x1 = Math.min(W - 1, Math.ceil((r.x1 - this.canvasRect.left) / S));
      const y0 = Math.max(0, Math.floor((r.y0 - this.canvasRect.top) / S)), y1 = Math.min(H - 1, Math.ceil((r.y1 - this.canvasRect.top) / S));
      for (let y = y0; y <= y1; y++) ids.fill(0, y * W + x0, y * W + x1 + 1);
    }
    const INF = 1e9;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, id = ids[i];
      if (id <= 0) { dist[i] = 0; continue; }
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
        ids[i - 1] !== id || ids[i + 1] !== id || ids[i - W] !== id || ids[i + W] !== id;
      dist[i] = edge ? 1 : INF;
    }
    // two-pass 3-4 chamfer (units of 1/3 px), restricted to same-id pixels via the edge seeds
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x; if (dist[i] <= 1) continue;
      dist[i] = Math.min(dist[i], dist[i - 1] + 1, dist[i - W] + 1, dist[i - W - 1] + 1.4142, dist[i - W + 1] + 1.4142);
    }
    for (let y = H - 2; y >= 1; y--) for (let x = W - 2; x >= 1; x--) {
      const i = y * W + x; if (dist[i] <= 1) continue;
      dist[i] = Math.min(dist[i], dist[i + 1] + 1, dist[i + W] + 1, dist[i + W + 1] + 1.4142, dist[i + W - 1] + 1.4142);
    }
    const comps = this.level.meta.components, nc = comps.length;
    const best = new Float32Array(nc).fill(-INF), bestI = new Int32Array(nc).fill(-1);
    // projected anchors (low-res px) for tie-breaking
    const ax = new Float32Array(nc), ay = new Float32Array(nc);
    comps.forEach((c, ci) => {
      const a = c.anchor ?? c.centroid, m = this.blobs!.meshes[ci];
      this.tmpV.set(a[0] - 128, a[1] - 128, a[2] - 128);
      if (m) this.tmpV.add(m.position);
      this.tmpV.project(this.camera);
      ax[ci] = ((this.tmpV.x * 0.5 + 0.5) * cw) / S; ay[ci] = ((-this.tmpV.y * 0.5 + 0.5) * ch) / S;
    });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, id = ids[i] - 1;
      if (id < 0 || id >= nc) continue;
      const sc = dist[i] - 0.03 * Math.hypot(x - ax[id], y - ay[id]);
      if (sc > best[id]) { best[id] = sc; bestI[id] = i; }
    }
    const spots: (LabelSpot | null)[] = new Array(nc).fill(null);
    for (let ci = 0; ci < nc; ci++) {
      const i = bestI[ci];
      if (i < 0) continue;
      const x = i % W, y = (i - x) / W, src = ((H - 1 - y) * W + x) * 4;
      spots[ci] = { x: buf[src + 1], y: buf[src + 2], z: buf[src + 3], clearPx: dist[i] * S };
    }
    this.labelSpots = spots;
    this.spotMs = cpu + performance.now() - t0;
    this.labels3dDirty = true;
  }

  private inMapPanel(clientX: number, clientY: number) {
    if (!this.mapVisible) return false;
    const r = (this.map.host.parentElement as HTMLElement).getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  private bindPointer() {
    const el = this.canvas;
    // capture phase so we can claim plane drags before OrbitControls sees them
    el.parentElement!.addEventListener('pointerdown', (e) => {
      if (e.target !== el || e.button !== 0) return;
      this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (!this.showSlice3D) return;
      const p = this.pick(e.clientX, e.clientY);
      if (p.id === PICK_PLANE || p.id === PICK_HANDLE) {
        e.stopPropagation(); e.preventDefault();
        const start = p.id === PICK_HANDLE ? this.handle.position.clone() : p.grid.clone();
        this.dragPlane = {
          start, offset0: this.slice.offset, pointerId: e.pointerId, y0: e.clientY,
          hue0: this.slice.hue, prev: { x: e.clientX, y: e.clientY },
        };
        this.lastPointer = null;
        el.setPointerCapture(e.pointerId);
        el.style.cursor = 'grabbing';
        document.body.classList.add('dragging-plane');
        this.hideTooltip();
      }
    }, { capture: true });
    el.addEventListener('pointermove', (e) => {
      if (this.dragPlane && e.pointerId === this.dragPlane.pointerId) { this.dragTo(e.clientX, e.clientY); return; }
      if (e.buttons) { this.pendingHover = null; this.lastPointer = null; this.clearHover(); return; }
      this.pendingHover = { x: e.clientX, y: e.clientY };
      this.lastPointer = { x: e.clientX, y: e.clientY };
    });
    const end = (e: PointerEvent) => {
      if (this.dragPlane && e.pointerId === this.dragPlane.pointerId) {
        this.dragPlane = null;
        el.releasePointerCapture(e.pointerId);
        el.style.cursor = '';
        document.body.classList.remove('dragging-plane');
        this.downAt = null;
        if (e.type === 'pointerup') { this.lastPointer = { x: e.clientX, y: e.clientY }; this.hoverStale = true; }
        return;
      }
      if (e.type === 'pointerup') { this.lastPointer = { x: e.clientX, y: e.clientY }; this.hoverStale = true; }
      if (e.type === 'pointerup' && this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) < 5) {
        this.click(e.clientX, e.clientY, e.shiftKey);
      }
      this.downAt = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { this.lastPointer = null; if (!this.dragPlane) { this.pendingHover = null; this.clearHover(); } });
  }

  private dragTo(clientX: number, clientY: number) {
    const d = this.dragPlane!;
    const r = this.canvasRect;
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.origin.setFromMatrixPosition(this.camera.matrixWorld);
    this.ray.direction.set(this.ndc.x, this.ndc.y, 0.5).unproject(this.camera).sub(this.ray.origin).normalize();
    if (this.slice.orientation === 'hues') { this.dragHues(d, clientX, clientY); this.emitState(); return; }
    // world-space line through the grab point along the normal
    const n = this.slice.normal;
    const P = this.tmpV.copy(d.start).add(this.root.position); // grid -> world (unexploded)
    const w0 = this.tmpV2.copy(P).sub(this.ray.origin);
    const b = n.dot(this.ray.direction), dd = n.dot(w0), e = this.ray.direction.dot(w0);
    let s: number;
    if (Math.abs(b) > 0.9) {
      // Looking (nearly) along the normal: the closest-point construction below has a gain of
      // 1/(1 - b^2), which explodes. Map the vertical pointer motion instead, one world unit per screen
      // pixel at the grab point's depth; dragging up moves the plane towards the camera.
      const dist = w0.length();
      const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / Math.max(1, r.height);
      const side = Math.sign(n.dot(this.camera.position) - n.dot(P)) || 1;
      s = (d.y0 - clientY) * worldPerPx * side;
    } else {
      s = (b * e - dd) / (1 - b * b);
    }
    this.slice.setOffset(d.offset0 + s);
    this.emitState();
  }

  /**
   * Hues mode: the plane turns about the gray axis, carrying the grab point around a circle. Where that
   * circle's plane faces the camera, intersect the pointer ray with it and turn the grab point to the hit's
   * angle (exact, unlimited, nothing accumulates). Seen edge-on that intersection is unstable, so instead turn
   * by the pointer motion along the grab point's on-screen direction of travel.
   */
  private dragHues(d: NonNullable<App['dragPlane']>, clientX: number, clientY: number) {
    const C = this.tmpV.setScalar(128).add(this.root.position); // cube centre, world (unexploded)
    // the grab point now, relative to the centre
    const rel = this.tmpV2.copy(d.start).subScalar(128).applyAxisAngle(GRAY, THREE.MathUtils.degToRad(this.slice.hue - d.hue0));
    const rd = this.ray.direction, facing = rd.dot(GRAY);
    let turn = 0; // radians, right-handed about GRAY (= towards higher hue)
    if (Math.abs(facing) > 0.3) {
      const hit = this.ray.at(this.tmpV3.copy(rel).add(C).sub(this.ray.origin).dot(GRAY) / facing, this.tmpV3).sub(C);
      hit.addScaledVector(GRAY, -hit.dot(GRAY));
      if (hit.length() > 4) { // too close to the axis, the angle is noise
        const a = Math.atan2(hit.dot(E2), hit.dot(E1)) - Math.atan2(rel.dot(E2), rel.dot(E1));
        turn = Math.atan2(Math.sin(a), Math.cos(a));
      }
    } else {
      const r = this.canvasRect;
      const p = this.tmpV3.copy(rel).add(C), q = rel.cross(GRAY).negate().multiplyScalar(0.05).add(p); // + 0.05 rad of travel
      p.project(this.camera); q.project(this.camera);
      const tx = ((q.x - p.x) * r.width) / 2 / 0.05, ty = (-(q.y - p.y) * r.height) / 2 / 0.05; // px per radian
      // floor the gain where the travel points at the camera (the point barely moves on screen)
      turn = ((clientX - d.prev.x) * tx + (clientY - d.prev.y) * ty) / Math.max(tx * tx + ty * ty, 80 * 80);
    }
    d.prev.x = clientX; d.prev.y = clientY;
    if (turn) this.slice.setHue(this.slice.hue + THREE.MathUtils.radToDeg(turn));
  }

  private click(clientX: number, clientY: number, shift: boolean) {
    if (this.inMapPanel(clientX, clientY)) return;
    const p = this.pick(clientX, clientY);
    let name = -1;
    if (p.id > 0 && this.level) name = this.level.meta.components[p.id - 1].nameIndex;
    else if ((p.id === PICK_PLANE || p.id === PICK_FACE) && this.level) name = majorityLabel(this.level.labels, p.grid.x, p.grid.y, p.grid.z);
    if (name < 0) return;
    if (shift) this.toggleName(name); else this.solo(name);
  }

  private clearHover() {
    if (this.hover && this.hover.kind !== 'map') { this.hover = null; this.hoverComp = -1; this.updateHighlightTargets(); this.hideTooltip(); this.emit(); }
    this.canvas.style.cursor = '';
  }

  private doHover(x: number, y: number) {
    if (!this.level) return;
    this.lastHoverAt = performance.now();
    const p = this.pick(x, y);
    if (p.id === PICK_NONE) { this.clearHover(); return; }
    if (p.id === PICK_HANDLE) {
      this.canvas.style.cursor = 'grab';
      this.hover = null; this.hoverComp = -1; this.updateHighlightTargets(); this.hideTooltip();
      return;
    }
    const comp = p.id > 0 ? p.id - 1 : -1;
    const name = comp >= 0 ? this.level.meta.components[comp].nameIndex : majorityLabel(this.level.labels, p.grid.x, p.grid.y, p.grid.z);
    this.canvas.style.cursor = p.id === PICK_PLANE ? 'grab' : 'pointer';
    this.hover = { kind: comp >= 0 ? 'blob' : p.id === PICK_FACE ? 'face' : 'plane', comp, name, grid: p.grid, clientX: x, clientY: y };
    if (comp !== this.hoverComp) { this.hoverComp = comp; this.updateHighlightTargets(); this.labels3dDirty = true; }
    this.showTooltip(this.hover);
    this.emit();
  }

  /** Smooth-majority label at a grid point (-1 before a level is loaded). */
  labelAt(x: number, y: number, z: number) { return this.level ? majorityLabel(this.level.labels, x, y, z) : -1; }

  /** Grid point shown at a client position inside the 2D map (null outside the slice). */
  mapGridAt(clientX: number, clientY: number): { g: THREE.Vector3; mx: number; my: number } | null {
    const hr = this.map.hostRect, v = this.map.view();
    const [mx, my] = this.map.toMap(v, clientX - hr.left, clientY - hr.top);
    const g = mapToGrid(this.map.faces, mx, my, new THREE.Vector3());
    return g ? { g, mx, my } : null;
  }

  /** Hover from the 2D map (client coordinates). */
  mapHover(clientX: number, clientY: number) {
    if (!this.level) return;
    const hit = this.mapGridAt(clientX, clientY);
    if (!hit) { this.mapLeave(); return; }
    const { g, mx, my } = hit;
    const name = majorityLabel(this.level.labels, g.x, g.y, g.z);
    this.hover = { kind: 'map', comp: -1, name, grid: g, clientX, clientY };
    this.map.hoverMap = { x: mx, y: my };
    this.marker.position.copy(g);
    this.marker.visible = true;
    this.setHoverName(name);
    this.showTooltip(this.hover);
    this.overlayDirty = true; this.dirty = true;
  }
  mapLeave() {
    if (this.hover?.kind === 'map') { this.hover = null; this.hideTooltip(); }
    this.map.hoverMap = null; this.marker.visible = false;
    this.setHoverName(-1);
    this.overlayDirty = true; this.dirty = true;
  }
  mapClick(clientX: number, clientY: number, shift: boolean) {
    if (!this.level) return;
    const g = this.mapGridAt(clientX, clientY)?.g;
    if (!g) return;
    const name = majorityLabel(this.level.labels, g.x, g.y, g.z);
    if (shift) this.toggleName(name); else this.solo(name);
  }

  // tooltip
  private tooltipEl = document.getElementById('tooltip') as HTMLDivElement;
  showTooltip(h: HoverInfo) {
    if (!this.level) return;
    const nm = this.level.meta.names[h.name];
    const r = gridToByte(h.grid.x), g = gridToByte(h.grid.y), b = gridToByte(h.grid.z);
    const hex = toHex(r, g, b);
    let extra = '';
    if (h.comp >= 0) {
      const c = this.level.meta.components[h.comp];
      const sameName = this.level.meta.components.filter((x) => x.nameIndex === c.nameIndex).length;
      extra = `<div class="tt-row"><span>blob</span><b>${(100 * c.voxels / 16777216).toFixed(c.voxels > 167772 ? 1 : 3)}% of cube</b></div>` +
        (sameName > 1 ? `<div class="tt-row"><span>name total</span><b>${(100 * nm.fraction).toFixed(2)}% · ${sameName} blobs</b></div>` : '');
    } else {
      extra = `<div class="tt-row"><span>name total</span><b>${(100 * nm.fraction).toFixed(2)}% of cube</b></div>`;
    }
    this.tooltipEl.innerHTML =
      `<div class="tt-name"><span class="tt-sw" style="background:${hex}"></span>${escapeHtml(nm.name)}</div>` +
      `<div class="tt-row"><span>color</span><b class="mono">${hex}</b></div>` +
      `<div class="tt-row"><span>RGB</span><b class="mono">${r}, ${g}, ${b}</b></div>` + extra;
    this.tooltipEl.hidden = false;
    const W = window.innerWidth, H = window.innerHeight;
    const tw = this.tooltipEl.offsetWidth, th = this.tooltipEl.offsetHeight;
    let x = h.clientX + 16, y = h.clientY + 16;
    if (x + tw > W - 8) x = h.clientX - tw - 16;
    if (y + th > H - 8) y = h.clientY - th - 16;
    this.tooltipEl.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }
  hideTooltip() { this.tooltipEl.hidden = true; }

  // ---------------------------------------------------------------- frame loop
  private frame = (now: number) => {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.stepViewShift(dt);
    if (this.controls.update()) { this.dirty = true; this.labels3dDirty = true; }
    if (this.controls.autoRotate) { this.dirty = true; this.labels3dDirty = true; }

    if (Math.abs(this.explode - this.explodeTarget) > 1e-4) {
      const prev = this.explode;
      this.explode += (this.explodeTarget - this.explode) * (1 - Math.exp(-dt * 9));
      if (Math.abs(this.explode - this.explodeTarget) < 1e-3) this.explode = this.explodeTarget;
      this.hoverStale = true;
      // dolly the camera so the exploded cube stays framed
      const ratio = (1 + DOLLY * this.explode) / (1 + DOLLY * prev);
      this.camera.position.sub(this.controls.target).multiplyScalar(ratio).add(this.controls.target);
      this.blobs?.setExplode(this.explode);
      this.dirty = true; this.labels3dDirty = true;
    }
    if (this.blobs?.animate(dt)) this.dirty = true;
    this.syncSlice();

    // the scene moved under a still cursor (orbit/zoom, explode, slice keys, solo...): re-pick, throttled
    if (this.hoverStale && !this.pendingHover && !this.dragPlane && now - this.lastHoverAt > HOVER_REPICK_MS) {
      this.hoverStale = false;
      if (this.lastPointer) this.pendingHover = { ...this.lastPointer };
    }
    if (this.pendingHover && !this.dragPlane) {
      const { x, y } = this.pendingHover; this.pendingHover = null;
      if (!this.inMapPanel(x, y)) this.doHover(x, y);
    }

    this.syncState();
    if (this.dirty || this.continuous) { this.dirty = false; this.renderFrame(); }
    if (this.overlayDirty && this.mapVisible) { this.overlayDirty = false; this.map.drawOverlay(); }
    if (this.labels3dDirty) this.spotPending = true;
    const labelFade = THREE.MathUtils.smoothstep(this.explode, 0.02, 0.25);
    const labelsWanted = this.labelsOn && (labelFade > 0.02 || this.anyHidden);
    if (this.spotPending && labelsWanted && now - this.spotAt > SPOT_INTERVAL_MS) {
      this.spotPending = false; this.spotAt = now;
      void this.computeLabelSpots();
    } else if (!labelsWanted) this.labelSpots = null;
    if (this.labels3dDirty) {
      this.labels3dDirty = false;
      const avoid = this.avoidRects; avoid.length = 0;
      for (const id of ['side', 'map-panel']) {
        const el = document.getElementById(id);
        if (el && !el.hidden && !el.classList.contains('collapsed')) {
          const rr = el.getBoundingClientRect();
          avoid.push({ x0: rr.left - 4, y0: rr.top - 4, x1: rr.right + 4, y1: rr.bottom + 4 });
        }
      }
      if (this.handle.visible) {
        // keep 3D labels off the plane's drag handle
        this.tmpV.copy(this.handle.position).add(this.root.position).project(this.camera);
        const hx = this.canvasRect.left + (this.tmpV.x * 0.5 + 0.5) * this.canvasRect.width;
        const hy = this.canvasRect.top + (-this.tmpV.y * 0.5 + 0.5) * this.canvasRect.height;
        avoid.push({ x0: hx - 24, y0: hy - 24, x1: hx + 24, y1: hy + 24 });
      }
      const fade = THREE.MathUtils.smoothstep(this.explode, 0.02, 0.25);
      const fadeL = this.labelsOn ? Math.max(fade, this.anyHidden ? 1 : 0) : 0;
      this.labels3d.update(this.camera, this.blobs, this.canvasRect.width, this.canvasRect.height, fadeL,
        this.labelVisible, avoid, this.hoverComp, this.labelSpots);
      this.emitFrame();
    }
  };
  /** Hide labels of blobs that the cut removes completely. */
  private labelVisible = (comp: number) => {
    if (!this.clipActive() || !this.level) return true;
    const c = this.level.meta.components[comp], n = this.slice.normal, t = this.slice.offset;
    for (let k = 0; k < 8; k++) {
      const x = (k & 1 ? c.bboxMax[0] : c.bboxMin[0]) - 128, y = (k & 2 ? c.bboxMax[1] : c.bboxMin[1]) - 128, z = (k & 4 ? c.bboxMax[2] : c.bboxMin[2]) - 128;
      if (this.clipSide * (x * n.x + y * n.y + z * n.z - t) <= 0) return true;
    }
    return false;
  };
  readonly avoidRects: { x0: number; y0: number; x1: number; y1: number }[] = [];

  /** Push app state into uniforms / object visibility. Cheap; called before every render or pick. */
  private syncState() {
    const clip = this.clipActive();
    this.blobs?.setClipping(clip);
    this.shared.uClipOn.value = clip ? 1 : 0;
    this.shared.uClipSide.value = this.clipSide;
    const fade = THREE.MathUtils.smoothstep(this.explode, 0.02, 0.25);
    const showPlane = this.showSlice3D;
    this.plane.visible = showPlane;
    const planeOpacity = 1 - 0.8 * fade;
    this.planeMat.uniforms.uOpacity.value = planeOpacity;
    this.planeGhost = planeOpacity < 0.999;
    // hidden names fade out of the plane, so the selection's cross-section (and the blobs behind) stand out
    const hiddenAlpha = this.anyHidden ? this.hiddenPlaneAlpha : 1;
    this.planeMat.uniforms.uHiddenAlpha.value = hiddenAlpha;
    const transparent = this.planeGhost || hiddenAlpha < 1;
    if (this.planeMat.transparent !== transparent) { this.planeMat.transparent = transparent; this.planeMat.needsUpdate = true; }
    this.planeMat.depthWrite = !transparent;
    this.outline.visible = this.outlineGhost.visible = showPlane && this.hasPolygon;
    this.handle.visible = showPlane && this.hasPolygon;
    this.backing.visible = this.explode < 1e-3 && !this.anyHidden;
    this.shared.uAssembled.value = this.backing.visible ? 1 : 0;
  }
  private hasPolygon = true;
  /** alpha of the 3D plane's regions of hidden names, while some names are hidden */
  hiddenPlaneAlpha = 0.15;
  /** the plane is faded (exploded view): picks prefer blobs and the handle (see pick()) */
  private planeGhost = false;

  private renderFrame() {
    const t0 = performance.now();
    this.renderer.info.reset();
    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, this.canvasRect.width, this.canvasRect.height);
    this.renderer.render(this.scene, this.camera);
    if (this.mapVisible) this.map.render(this.renderer, this.canvasRect, MAP_BG);
    this.frameTimes.push(performance.now() - t0);
    if (this.frameTimes.length > 240) this.frameTimes.shift();
  }

  private frameListeners: Listener[] = [];
  onFrame(fn: Listener) { this.frameListeners.push(fn); }
  private emitFrame() { for (const f of this.frameListeners) f(); }

  // ---------------------------------------------------------------- test hooks
  /** Render with flat shading and read back the canvas pixel at a client position. */
  readPixel(clientX: number, clientY: number): { rgba: number[]; pick: { id: number; grid: number[] } } {
    const p = this.pick(clientX, clientY);
    this.renderFrame();
    const gl = this.renderer.getContext();
    const dpr = this.renderer.getPixelRatio();
    const r = this.canvasRect;
    // same pixel as pick(): row floor(y*dpr) from the top = GL row H-1-floor(y*dpr)
    const x = Math.floor((clientX - r.left) * dpr), y = this.renderer.domElement.height - 1 - Math.floor((clientY - r.top) * dpr);
    const buf = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { rgba: Array.from(buf), pick: { id: p.id, grid: p.grid.toArray() } };
  }

  benchmark(frames: number): Promise<{ fps: number; avgCpuMs: number; triangles: number; drawCalls: number }> {
    return new Promise((resolve) => {
      this.continuous = true;
      const spin = this.controls.autoRotate, speed = this.controls.autoRotateSpeed;
      this.controls.autoRotate = true; this.controls.autoRotateSpeed = 6;
      const start = performance.now();
      let n = 0;
      const tick = () => {
        n++;
        this.dirty = true;
        if (n < frames) requestAnimationFrame(tick);
        else {
          const el = performance.now() - start;
          this.continuous = false;
          this.controls.autoRotate = spin; this.controls.autoRotateSpeed = speed;
          const info = this.renderer.info.render;
          const cpu = this.frameTimes.slice(-frames);
          resolve({ fps: (frames * 1000) / el, avgCpuMs: cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length), triangles: info.triangles, drawCalls: info.calls });
        }
      };
      requestAnimationFrame(tick);
    });
  }
}

const SPOT_DS = 4;            // label-spot id render downscale
const SPOT_INTERVAL_MS = 90;  // at most this often while the view moves
const MAP_BG = new THREE.Color('#15171c');
function readMapBg() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--map-bg').trim();
  if (v) MAP_BG.setStyle(v);
}
readMapBg();
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', readMapBg);

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
