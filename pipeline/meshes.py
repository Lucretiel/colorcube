#!/usr/bin/env python3
"""Step 4: one smooth closed surface per connected component.

Field. For a component of label L we use the log-density margin
    f_L(x) = log d_L(x) - max_{k != L} log d_k(x)
evaluated from the per-voxel candidate lists produced by clean.py (in which
labels of removed tiny components are suppressed), so sign(f_L) at every voxel
centre is exactly "cleaned label == L". Between voxel centres marching cubes
interpolates the smooth density ratio, which gives sub-voxel, naturally smooth
borders; on a two-label interface f_A = -f_B, so neighbouring meshes share the
same surface. Other components of the same label inside the crop are forced
negative. The crop is padded by one layer whose value is -|f| of the adjacent
boundary voxel, which places the cap exactly on the cube face (0 or 256) and
closes the mesh.

Then marching cubes (skimage, Lewiner), vertex normals from the field gradient,
CCW-outward winding, meshoptimizer simplification (node simplify.mjs, absolute
error in voxels), vertex compaction. Writes build/<level>/mesh.npz.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from skimage.measure import marching_cubes

from common import BUILD, N, ROOT

NONE = 255
LOG_FLOOR = float(np.log(1e-5))  # log(labels.EPS): the smallest possible log-density
TARGET_ERROR = 0.1  # voxels (absolute, meshoptimizer)
_G = {}


def _init(level):
    d = BUILD / level
    _G["effv"] = np.load(d / "effv.npy", mmap_mode="r")
    _G["effi"] = np.load(d / "effi.npy", mmap_mode="r")
    _G["lab"] = np.load(d / "labels.npy", mmap_mode="r").reshape(N, N, N)
    _G["comp"] = np.load(d / "comp.npy", mmap_mode="r").reshape(N, N, N)


def margin_field(ev, ei, L):
    """ev/ei: [K, ...] descending candidate lists. Returns f_L (float32)."""
    valid = ei != NONE
    lowest = np.where(valid, ev, np.inf).min(0)
    floor = lowest - 2.0  # anything not tracked is below the K-th candidate
    floor = np.where(np.isfinite(floor), floor, LOG_FLOOR - 2.0)
    evf = np.where(valid, ev, floor[None])
    isL = (ei == L) & valid
    vL = np.where(isL.any(0), np.where(isL, evf, -np.inf).max(0), floor)
    top_is_L = ei[0] == L
    second = evf[1]
    f = np.where(top_is_L, evf[0] - second, vL - evf[0])
    # exact float ties (rare): the cleaned label (slot 0) wins
    f = np.where(top_is_L, np.maximum(f, 1e-4), np.minimum(f, -1e-4))
    return f.astype(np.float32)


def mesh_component(task):
    k, L, bmin, bmax = task  # bbox in (r,g,b), voxel index ranges [min, max)
    lo = [max(0, a - 2) for a in bmin]
    hi = [min(N, b + 2) for b in bmax]
    sl = (slice(lo[2], hi[2]), slice(lo[1], hi[1]), slice(lo[0], hi[0]))  # [b,g,r]
    ev = np.asarray(_G["effv"][(slice(None),) + sl])
    ei = np.asarray(_G["effi"][(slice(None),) + sl])
    f = margin_field(ev, ei, L)
    comp = np.asarray(_G["comp"][sl])
    lab = np.asarray(_G["lab"][sl])
    inside = comp == k
    assert np.isfinite(f).all(), f"component {k}: non-finite margin field"
    assert (f[inside] > 0).all() and (f[~inside & (lab != L)] < 0).all()
    other = (lab == L) & ~inside
    f[other] = -np.abs(f[other]) - 1e-3
    fp = np.pad(f, 1, mode="edge")
    core = np.zeros(fp.shape, bool)
    core[1:-1, 1:-1, 1:-1] = True
    fp[~core] = -np.abs(fp[~core]) - 1e-6
    verts, faces, normals, _ = marching_cubes(fp, 0.0, method="lewiner", allow_degenerate=False)
    # [b,g,r] padded index -> grid units (x=r, y=g, z=b); voxel centre = index + 0.5
    off = np.array([lo[2], lo[1], lo[0]], np.float64) - 1 + 0.5
    pos = (verts.astype(np.float64) + off)[:, ::-1].copy()
    nrm = normals[:, ::-1].astype(np.float64)
    faces = faces.astype(np.int64)
    # orientation: CCW seen from outside <=> positive signed volume
    v0, v1, v2 = pos[faces[:, 0]], pos[faces[:, 1]], pos[faces[:, 2]]
    vol = np.einsum("ij,ij->i", v0, np.cross(v1, v2)).sum() / 6.0
    if vol < 0:
        faces = faces[:, [0, 2, 1]]
        v1, v2 = v2, v1
    fn = np.cross(v1 - v0, v2 - v0)
    vn = np.zeros_like(pos)
    for j in range(3):
        np.add.at(vn, faces[:, j], fn)
    # field increases inwards; make normals agree with geometric outward normals
    if np.einsum("ij,ij->", vn, nrm) < 0:
        nrm = -nrm
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    bad = ln[:, 0] < 1e-8
    nrm[~bad] /= ln[~bad]
    if bad.any():  # fall back to geometric normals
        g = vn[bad] / np.maximum(np.linalg.norm(vn[bad], axis=1, keepdims=True), 1e-12)
        nrm[bad] = g
    pos = np.clip(pos, 0, N)
    return k, pos.astype(np.float32), nrm.astype(np.float32), faces.astype(np.uint32), abs(vol)


def run_level(level, jobs, target_error):
    t0 = time.time()
    d = BUILD / level
    info = json.loads((d / "clean.json").read_text())
    comps = info["components"]
    tasks = [(k, c["nameIndex"], c["bboxMin"], c["bboxMax"]) for k, c in enumerate(comps)]
    # biggest first for load balancing
    tasks.sort(key=lambda t: -np.prod(np.subtract(t[3], t[2])))
    results = {}
    with ProcessPoolExecutor(max_workers=jobs, initializer=_init, initargs=(level,)) as ex:
        for k, pos, nrm, faces, vol in ex.map(mesh_component, tasks):
            results[k] = (pos, nrm, faces, vol)
    tri_mc = sum(len(r[2]) for r in results.values())
    vol_err = [abs(results[k][3] - c["voxels"]) / c["voxels"] for k, c in enumerate(comps)]
    print(f"[{level}] marching cubes: {len(comps)} meshes, {tri_mc} triangles, "
          f"mesh-vs-voxel volume error median {np.median(vol_err):.4f} max {max(vol_err):.4f} "
          f"({time.time()-t0:.1f}s)", flush=True)

    # write input for the node simplifier
    vcounts = [len(results[k][0]) for k in range(len(comps))]
    icounts = [results[k][2].size for k in range(len(comps))]
    voffs = np.concatenate([[0], np.cumsum(vcounts)[:-1]]).astype(int)
    ioffs = np.concatenate([[0], np.cumsum(icounts)[:-1]]).astype(int)
    P = np.concatenate([results[k][0] for k in range(len(comps))])
    I = np.concatenate([results[k][2].ravel() for k in range(len(comps))])
    mc_bin, mc_json = d / "mc.bin", d / "mc.json"
    with open(mc_bin, "wb") as fh:
        fh.write(P.astype("<f4").tobytes())
        fh.write(I.astype("<u4").tobytes())
    json.dump({"vertexCount": int(len(P)), "indexCount": int(len(I)), "positionsByteOffset": 0,
               "indicesByteOffset": int(P.nbytes),
               "components": [{"vOff": int(voffs[k]), "vCount": vcounts[k], "iOff": int(ioffs[k]),
                               "iCount": icounts[k]} for k in range(len(comps))]},
              open(mc_json, "w"))
    s_bin, s_json = d / "simp.bin", d / "simp.json"
    subprocess.run(["node", str(ROOT / "pipeline/simplify.mjs"), str(mc_bin), str(mc_json),
                    str(s_bin), str(s_json), str(target_error)], check=True,
                   cwd=ROOT / "pipeline")
    smeta = json.loads(s_json.read_text())
    SI = np.fromfile(s_bin, dtype="<u4")

    # compact vertices per component
    out_pos, out_nrm, out_idx, out_comp = [], [], [], []
    for k in range(len(comps)):
        pos, nrm, _, _ = results[k]
        sc = smeta["components"][k]
        ind = SI[sc["iOff"]:sc["iOff"] + sc["iCount"]].astype(np.int64)
        used, inv = np.unique(ind, return_inverse=True)
        out_pos.append(pos[used])
        out_nrm.append(nrm[used])
        out_idx.append(inv.astype(np.uint32))
        out_comp.append((len(used), len(inv), sc["error"]))
    np.savez(d / "mesh.npz",
             pos=np.concatenate(out_pos), nrm=np.concatenate(out_nrm),
             idx=np.concatenate(out_idx),
             vcount=np.array([c[0] for c in out_comp]), icount=np.array([c[1] for c in out_comp]),
             error=np.array([c[2] for c in out_comp]))
    tri = sum(c[1] for c in out_comp) // 3
    print(f"[{level}] final: {tri} triangles, {sum(c[0] for c in out_comp)} vertices, "
          f"max simplification error {max(c[2] for c in out_comp):.3f} voxels "
          f"({time.time()-t0:.1f}s)", flush=True)
    for p in (mc_bin, s_bin):
        os.remove(p)
    json.dump({"triangles_marching_cubes": int(tri_mc), "triangles": int(tri),
               "target_error": target_error,
               "max_error": float(max(c[2] for c in out_comp)),
               "volume_error_median": float(np.median(vol_err)),
               "volume_error_max": float(max(vol_err))},
              open(d / "mesh_report.json", "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--levels", default="basic,standard,detailed")
    ap.add_argument("--jobs", type=int, default=min(8, os.cpu_count() or 4))
    ap.add_argument("--target-error", type=float, default=TARGET_ERROR)
    args = ap.parse_args()
    for level in args.levels.split(","):
        run_level(level, args.jobs, args.target_error)


if __name__ == "__main__":
    sys.exit(main())
