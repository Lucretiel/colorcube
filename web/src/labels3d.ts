// Floating DOM labels for the components, following their exploded positions.
// Placement uses "spots" computed by App from a low-resolution id render: for every component the
// visible surface pixel farthest from the edge of its visible area (so labels never float over a
// blob that hides the one they name). Without spots it falls back to the pipeline's interior anchor.
// Greedy de-cluttering: larger components claim screen space first; overlapping labels fade out.
import * as THREE from 'three';
import type { BlobSet } from './blobs';

interface Item {
  comp: number;
  name: number;
  el: HTMLDivElement;
  world: THREE.Vector3;
  radius: number;   // sphere-equivalent radius (grid units)
  shown: boolean;
  w: number; h: number; // measured at 1em = 16px
}

/** Visible label spot of a component: unexploded grid point on its visible surface + clearance in CSS px. */
export interface LabelSpot { x: number; y: number; z: number; clearPx: number }

const MAX_LABELS = 90;
type Rect = { x0: number; y0: number; x1: number; y1: number };

export class Labels3D {
  private items: Item[] = [];
  private placed: Rect[] = [];
  /** labels placed this pass, per name (several blobs of one name side by side would repeat it) */
  private byName = new Map<number, { x: number; y: number; w: number; h: number }[]>();
  private v = new THREE.Vector3();
  constructor(private layer: HTMLElement) {}

  build(blobs: BlobSet, nameText: (i: number) => string) {
    this.clear();
    const comps = blobs.level.meta.components;
    const n = Math.min(MAX_LABELS, comps.length);
    for (let i = 0; i < n; i++) {
      const c = comps[i];
      if (!blobs.meshes[i]) continue;
      const el = document.createElement('div');
      el.className = 'blob-label';
      el.textContent = nameText(c.nameIndex);
      this.layer.appendChild(el);
      this.items.push({ comp: i, name: c.nameIndex, el, world: new THREE.Vector3(), radius: Math.cbrt((3 * c.voxels) / (4 * Math.PI)), shown: false, w: 0, h: 0 });
    }
    // measure once (font-size 16px reference)
    for (const it of this.items) { it.w = it.el.offsetWidth; it.h = it.el.offsetHeight; }
  }

  clear() {
    for (const it of this.items) it.el.remove();
    this.items = [];
  }

  update(camera: THREE.PerspectiveCamera, blobs: BlobSet | null, width: number, height: number, fade: number,
    visible: (comp: number) => boolean, avoid: Rect[], hoverComp: number, spots: (LabelSpot | null)[] | null) {
    if (!blobs) return;
    const placed = this.placed; placed.length = 0;
    for (const r of avoid) placed.push(r);
    const byName = this.byName; byName.clear();
    const camPos = camera.position;
    const focal = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    for (const it of this.items) {
      const mesh = blobs.meshes[it.comp];
      let show = fade > 0.02 && !!mesh && mesh.visible && visible(it.comp);
      let x = 0, y = 0, scale = 1;
      if (show && mesh) {
        const c = blobs.level.meta.components[it.comp];
        const spot = spots ? spots[it.comp] : null;
        const hovered = it.comp === hoverComp;
        if (spots && !spot && !hovered) show = false;
        const p = spot ?? (c.anchor ? { x: c.anchor[0], y: c.anchor[1], z: c.anchor[2] } : { x: c.centroid[0], y: c.centroid[1], z: c.centroid[2] });
        it.world.set(p.x - 128, p.y - 128, p.z - 128).add(mesh.position);
        const dist = it.world.distanceTo(camPos);
        this.v.copy(it.world).project(camera);
        if (this.v.z > 1 || this.v.z < -1) show = false;
        x = (this.v.x * 0.5 + 0.5) * width; y = (-this.v.y * 0.5 + 0.5) * height;
        const rPx = (it.radius * focal) / Math.max(1, dist);
        let px = Math.min(30, Math.max(11, rPx * 0.32));
        if (spot) px = Math.min(px, Math.max(11, spot.clearPx * 0.9));
        scale = px / 16;
        if ((rPx < 7 || (spot && spot.clearPx < 4)) && !hovered) show = false;
        if (show) {
          const hw = (it.w * scale) / 2 + 3, hh = (it.h * scale) / 2 + 1;
          const r = { x0: x - hw, y0: y - hh, x1: x + hw, y1: y + hh };
          // components come largest first, so the biggest blob of a name keeps the label when two of
          // its blobs would put the same text (nearly) on top of each other
          const same = byName.get(it.name);
          const stacked = !!same && same.some((q) => Math.abs(q.x - x) < Math.max(q.w, 2 * hw) && Math.abs(q.y - y) < 1.5 * Math.max(q.h, 2 * hh));
          if (r.x1 < 0 || r.y1 < 0 || r.x0 > width || r.y0 > height) show = false;
          else if (!hovered && (stacked || placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0))) show = false;
          else {
            placed.push(r);
            if (same) same.push({ x, y, w: 2 * hw, h: 2 * hh }); else byName.set(it.name, [{ x, y, w: 2 * hw, h: 2 * hh }]);
          }
        }
      }
      if (show) {
        it.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
        it.el.style.opacity = String(fade);
        it.el.classList.toggle('hover', it.comp === hoverComp);
      }
      if (show !== it.shown) {
        it.shown = show;
        if (!show) it.el.style.opacity = '0';
      }
    }
  }
}
