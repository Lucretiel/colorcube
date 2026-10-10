#!/usr/bin/env python3
"""Steps 5/6: write web/public/assets/<level>/{meta.json,meshes.bin,labels.lbl}
and web/public/assets/levels.json exactly per docs/CONTRACT.md."""
import argparse
import gzip
import json
import sys

import numpy as np
from scipy import ndimage

from common import ASSETS, BUILD, LEVELS, N, write_json

LEVEL_ORDER = ["basic", "standard", "detailed"]
DEFAULT_LEVEL = "standard"


def align4(n):
    return (n + 3) & ~3


def anchors(comp, ncomp):
    """Per component: the interior voxel farthest from the component's boundary
    (a good 3D label position, unlike the centroid of a non-convex region)."""
    comp3 = comp.reshape(N, N, N)
    out = [None] * ncomp
    objs = ndimage.find_objects(comp3 + 1)  # label k -> k+1
    for k in range(ncomp):
        sl = objs[k]
        sl = tuple(slice(max(s.start - 1, 0), min(s.stop + 1, N)) for s in sl)
        m = comp3[sl] == k
        # distance to the nearest voxel outside the component (cube faces count as
        # boundary too, so labels are not placed on the cube surface)
        mp = np.pad(m, 1, constant_values=False)
        dt = ndimage.distance_transform_edt(mp)[1:-1, 1:-1, 1:-1]
        i = np.unravel_index(np.argmax(dt), dt.shape)
        b, g, r = (i[j] + sl[j].start for j in range(3))
        out[k] = ([float(r) + 0.5, float(g) + 0.5, float(b) + 0.5], float(dt[i]))
    return out


def export_level(level, stats):
    d = BUILD / level
    info = json.loads((d / "clean.json").read_text())
    cand = json.loads((d / "candidates.json").read_text())
    mrep = json.loads((d / "mesh_report.json").read_text())
    M = np.load(d / "mesh.npz")
    lab = np.load(d / "labels.npy")
    comp = np.load(d / "comp.npy")
    out = ASSETS / level
    out.mkdir(parents=True, exist_ok=True)

    pos, nrm, idx = M["pos"], M["nrm"], M["idx"]
    vcount, icount = M["vcount"], M["icount"]
    V, I = int(len(pos)), int(len(idx))
    q = np.clip(np.rint(pos.astype(np.float64) * 65535.0 / 256.0), 0, 65535).astype("<u2")
    n = nrm.astype(np.float64)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    n8 = np.zeros((V, 4), "<i1")
    n8[:, :3] = np.clip(np.rint(n * 127.0), -127, 127).astype(np.int8)
    pos_off = 0
    nrm_off = align4(pos_off + q.nbytes)
    idx_off = align4(nrm_off + n8.nbytes)
    total = idx_off + I * 4
    buf = bytearray(total)
    buf[pos_off:pos_off + q.nbytes] = q.tobytes()
    buf[nrm_off:nrm_off + n8.nbytes] = n8.tobytes()
    buf[idx_off:] = idx.astype("<u4").tobytes()
    # gzip the whole buffer: the contract layout is unchanged once decompressed, and many
    # static hosts don't compress application/octet-stream themselves (~55% smaller)
    (out / "meshes.bin").write_bytes(gzip.compress(bytes(buf), 9, mtime=0))

    comps = info["components"]
    anc = anchors(comp, len(comps))
    fv = fi = 0
    for k, c in enumerate(comps):
        c["firstVertex"], c["vertexCount"] = fv, int(vcount[k])
        c["firstIndex"], c["indexCount"] = fi, int(icount[k])
        c["anchor"], c["anchorDepth"] = anc[k][0], round(anc[k][1], 2)
        fv += int(vcount[k])
        fi += int(icount[k])
    assert fv == V and fi == I

    rep = info["report"]
    meta = {
        "level": level,
        "resolution": N,
        "source": {
            "answers": int(stats["answers_kept"]),
            "users": int(stats["users_kept"]),
            "sigma": float(cand["sigma"]),
            "candidates": int(info["candidates"]),
            "minComponentVoxels": int(rep["min_voxels"]),
            "meshError": float(mrep["target_error"]),
            "notes": (
                "xkcd color survey (Munroe 2010), main survey answers. Users with spamprob > "
                f"{stats['spam_threshold']} and self-reported color-blind users removed; names "
                "normalized (case, whitespace, grey->gray, hyphens/slashes, common misspellings). "
                f"Per-name Gaussian KDE (sigma {cand['sigma']} voxels) over the 256^3 RGB grid; "
                "label = most popular name. Components smaller than "
                f"{rep['min_voxels']} voxels relabelled to the runner-up name."
            ),
        },
        "names": info["names"],
        "components": comps,
        "mesh": {
            "file": "meshes.bin",
            "vertexCount": V, "indexCount": I,
            "positionsByteOffset": pos_off,
            "normalsByteOffset": nrm_off,
            "indicesByteOffset": idx_off,
        },
    }
    write_json(out / "meta.json", meta)
    (out / "labels.lbl").write_bytes(gzip.compress(lab.astype(np.uint8).tobytes(), 9, mtime=0))
    sizes = {f: (out / f).stat().st_size for f in ("meta.json", "meshes.bin", "labels.lbl")}
    print(f"[{level}] names={len(info['names'])} components={len(comps)} triangles={I//3} "
          f"vertices={V} sizes={sizes} total={sum(sizes.values())/1e6:.2f} MB", flush=True)
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--levels", default=",".join(LEVEL_ORDER))
    args = ap.parse_args()
    stats = json.loads((BUILD / "parse_stats.json").read_text())
    levels = []
    for level in args.levels.split(","):
        meta = export_level(level, stats)
        cand = json.loads((BUILD / level / "candidates.json").read_text())
        cfg = LEVELS[level]
        n = len(meta["names"])
        k = len(cand["labels"])
        top = cfg.get("top", k)
        mincount = int(sorted(cand["answers"], reverse=True)[min(top, k) - 1])
        fmt = dict(n=n, k=k, mincount=mincount, top=top)
        levels.append({"id": level, "title": cfg["title"].format(**fmt),
                       "description": cfg["description"].format(**fmt)})
    order = {l: i for i, l in enumerate(LEVEL_ORDER)}
    levels.sort(key=lambda l: order.get(l["id"], 99))
    write_json(ASSETS / "levels.json", {"default": DEFAULT_LEVEL, "levels": levels})


if __name__ == "__main__":
    sys.exit(main())
