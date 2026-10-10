// One mesh per connected component; colour from position in the shader.
import * as THREE from 'three';
import type { LevelData } from './data';
import { blobFragment, blobPickFragment, blobVertex } from './shaders';

export interface SharedBlobUniforms {
  uShade: THREE.IUniform<number>;
  uClip: THREE.IUniform<THREE.Vector4>;
  uClipSide: THREE.IUniform<number>;
  uClipOn: THREE.IUniform<number>;
  uRootOffset: THREE.IUniform<THREE.Vector3>;
  uLabels: THREE.IUniform<THREE.Data3DTexture | null>;
  uAssembled: THREE.IUniform<number>;
}

export function makeSharedBlobUniforms(): SharedBlobUniforms {
  return {
    uShade: { value: 0.55 },
    uClip: { value: new THREE.Vector4(0, 0, 1, 0) },
    uClipSide: { value: 1 },
    uClipOn: { value: 0 },
    uRootOffset: { value: new THREE.Vector3(-128, -128, -128) },
    uLabels: { value: null },
    uAssembled: { value: 0 },
  };
}

export class BlobSet {
  readonly group = new THREE.Group();
  readonly meshes: (THREE.Mesh | null)[] = [];
  /** explode direction per component (centroid - 128), world units at k = 1 */
  readonly dirs: THREE.Vector3[] = [];
  readonly material: THREE.ShaderMaterial;
  readonly materialClip: THREE.ShaderMaterial;
  readonly pickMaterial: THREE.ShaderMaterial;
  /** per component highlight value (0..1), animated towards target */
  readonly highlight: Float32Array;
  readonly highlightTarget: Float32Array;
  private clipping = false;
  triangles = 0;

  constructor(readonly level: LevelData, shared: SharedBlobUniforms) {
    const comps = level.meta.components;
    this.highlight = new Float32Array(comps.length);
    this.highlightTarget = new Float32Array(comps.length);
    const mk = (clip: boolean) => new THREE.ShaderMaterial({
      vertexShader: blobVertex,
      fragmentShader: blobFragment,
      defines: clip ? { CLIP: 1 } : {},
      // Double-sided even without clipping: where neighbouring meshes (simplified independently) leave a
      // hairline gap, the neighbour's back face shows through with (almost) the same position colour.
      side: THREE.DoubleSide,
      uniforms: {
        ...shared,
        uHighlight: { value: 0 },
        uNameIndex: { value: 0 },
        uOffset: { value: new THREE.Vector3() },
      },
    });
    this.material = mk(false);
    this.materialClip = mk(true);
    this.pickMaterial = new THREE.ShaderMaterial({
      vertexShader: blobVertex,
      fragmentShader: blobPickFragment,
      side: THREE.DoubleSide,
      uniforms: { ...shared, uPickId: { value: 0 }, uNameIndex: { value: 0 }, uOffset: { value: new THREE.Vector3() } },
    });

    const { positions, normals, indices } = level;
    const tmpSphere = new THREE.Vector3();
    comps.forEach((c, ci) => {
      this.dirs.push(new THREE.Vector3(c.centroid[0] - 128, c.centroid[1] - 128, c.centroid[2] - 128));
      if (c.vertexCount === 0 || c.indexCount === 0) { this.meshes.push(null); return; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(positions.subarray(c.firstVertex * 3, (c.firstVertex + c.vertexCount) * 3), 3, true));
      g.setAttribute('normal', new THREE.BufferAttribute(normals.subarray(c.firstVertex * 4, (c.firstVertex + c.vertexCount) * 4), 4, true));
      const idx = indices.subarray(c.firstIndex, c.firstIndex + c.indexCount);
      g.setIndex(new THREE.BufferAttribute(c.vertexCount <= 65535 ? Uint16Array.from(idx) : idx, 1));
      const lo = c.bboxMin, hi = c.bboxMax;
      tmpSphere.set((lo[0] + hi[0]) / 512, (lo[1] + hi[1]) / 512, (lo[2] + hi[2]) / 512);
      const rad = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 512 + 0.01;
      g.boundingSphere = new THREE.Sphere(tmpSphere.clone(), rad);
      g.boundingBox = new THREE.Box3(new THREE.Vector3(lo[0] / 256, lo[1] / 256, lo[2] / 256), new THREE.Vector3(hi[0] / 256, hi[1] / 256, hi[2] / 256));
      const mesh = new THREE.Mesh(g, this.material);
      mesh.scale.setScalar(256);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.userData.comp = ci;
      mesh.onBeforeRender = (_r, _s, _c, _g, material) => {
        const m = material as THREE.ShaderMaterial;
        const u = m.uniforms;
        if (u.uHighlight) u.uHighlight.value = this.highlight[ci];
        if (u.uPickId) u.uPickId.value = ci + 1;
        u.uNameIndex.value = c.nameIndex;
        u.uOffset.value.copy(mesh.position);
        m.uniformsNeedUpdate = true;
      };
      this.triangles += c.indexCount / 3;
      this.group.add(mesh);
      this.meshes.push(mesh);
    });
  }

  setExplode(k: number) {
    this.meshes.forEach((m, i) => {
      if (!m) return;
      m.position.copy(this.dirs[i]).multiplyScalar(k);
      m.updateMatrix();
    });
  }

  setClipping(on: boolean) {
    if (on === this.clipping) return;
    this.clipping = on;
    for (const m of this.meshes) if (m) m.material = on ? this.materialClip : this.material;
  }

  setNameVisibility(visible: boolean[]) {
    const comps = this.level.meta.components;
    this.meshes.forEach((m, i) => { if (m) m.visible = visible[comps[i].nameIndex] !== false; });
  }

  /** Temporarily swap to the pick material (returns a restore function). */
  usePickMaterial(): () => void {
    for (const m of this.meshes) if (m) m.material = this.pickMaterial;
    return () => { for (const m of this.meshes) if (m) m.material = this.clipping ? this.materialClip : this.material; };
  }

  /** Advance highlight animation; returns true while still animating. */
  animate(dt: number): boolean {
    let moving = false;
    const a = 1 - Math.exp(-dt * 18);
    for (let i = 0; i < this.highlight.length; i++) {
      const d = this.highlightTarget[i] - this.highlight[i];
      if (Math.abs(d) > 0.002) { this.highlight[i] += d * a; moving = true; } else this.highlight[i] = this.highlightTarget[i];
    }
    return moving;
  }

  dispose() {
    for (const m of this.meshes) if (m) m.geometry.dispose();
    this.material.dispose(); this.materialClip.dispose(); this.pickMaterial.dispose();
    this.group.removeFromParent();
  }
}
