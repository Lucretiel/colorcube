#!/usr/bin/env python3
"""Step 3: remove tiny connected components from the argmax label volume.

Phase 1 (principled): any 6-connected component smaller than the level's
threshold has its label *suppressed* in those voxels, so each voxel falls back to
its runner-up name (the next most popular name for that exact colour). Repeat
until stable -- a runner-up may itself form a new tiny component.
Phase 2 (fallback, rare): components that are still too small (e.g. every
tracked candidate was suppressed) are merged into the most common neighbouring
label.

Outputs build/<level>/{labels,comp,effv,effi}.npy:
  labels  uint8 [256^3]  final label (index into final names, flat r+256g+65536b)
  comp    int32 [256^3]  component id (index into components, sorted by size)
  effv/effi [K, 256^3]   per-voxel candidate (label, log-density) lists after
                         suppression/forcing, descending; used to build the
                         meshing margin fields so meshes agree with `labels`.
and build/<level>/clean.json (names + components, contract-shaped).
"""
import argparse
import json
import sys
import time

import numpy as np
from scipy import ndimage
from skimage.measure import label as cc_label

from common import BUILD, N, write_json
from labels import EPS

LOG_FLOOR = float(np.log(EPS))  # smallest possible log-density (no answers nearby)

NONE = 255
MIN_VOXELS = {"basic": 1000, "standard": 1000, "detailed": 1000}
FORCE_DELTA = 0.05  # log-units a forced label is put above the best remaining candidate
STRUCT6 = ndimage.generate_binary_structure(3, 1)


def components(lab3):
    """6-connected components of equal label. Returns (comp ids 1.., sizes[0..])."""
    c = cc_label(lab3.astype(np.int16), background=-1, connectivity=1)
    return c, np.bincount(c.ravel())


def effective(vals, idx, supp):
    """Compact the non-suppressed entries of the top-K lists to the front."""
    valid = (~supp) & (idx != NONE)
    order = np.argsort(~valid, axis=0, kind="stable")  # valid first, keep order
    ev = np.take_along_axis(vals, order, 0)
    ei = np.take_along_axis(idx, order, 0)
    vv = np.take_along_axis(valid, order, 0)
    ev[~vv] = -np.inf
    ei[~vv] = NONE
    return ev, ei


def neighbour_mode(lab3, mask3):
    """For the voxels in mask3 return the most common label among their 6-neighbours
    outside mask3 (or -1 if none)."""
    zz, yy, xx = np.nonzero(ndimage.binary_dilation(mask3, STRUCT6) & ~mask3)
    labs = lab3[zz, yy, xx]
    if labs.size == 0:
        return -1
    return int(np.bincount(labs).argmax())


def run_level(level, min_vox):
    t0 = time.time()
    d = BUILD / level
    cand = json.loads((d / "candidates.json").read_text())
    vals = np.load(d / "topv.npy").reshape(4, -1)
    idx = np.load(d / "topi.npy").reshape(4, -1)
    K, V = vals.shape
    supp = np.zeros((K, V), bool)
    report = {"min_voxels": min_vox}

    lab = idx[0].copy()
    c, sizes = components(lab.reshape(N, N, N))
    sz = sizes[1:]
    report["raw_components"] = int(sz.size)
    report["raw_small_components"] = int((sz < min_vox).sum())
    report["raw_small_voxels"] = int(sz[sz < min_vox].sum())
    hist_edges = [1, 10, 100, 500, 1000, 2000, 5000, 10 ** 9]
    report["raw_size_hist"] = {f"[{a},{b})": int(((sz >= a) & (sz < b)).sum())
                               for a, b in zip(hist_edges[:-1], hist_edges[1:])}

    # Phase 1: suppress small components' labels -> runner-up.
    rows = np.arange(V)
    it = 0
    for it in range(1, 30):
        ev_slot = np.argmax((~supp) & (idx != NONE), axis=0)  # first valid slot
        has = ((~supp) & (idx != NONE)).any(0)
        lab = np.where(has, idx[ev_slot, rows], NONE).astype(np.uint8)
        c, sizes = components(lab.reshape(N, N, N))
        small = sizes < min_vox
        small[0] = False
        sv = small[c.ravel()] & has
        if not sv.any():
            break
        supp[ev_slot[sv], rows[sv]] = True
    report["phase1_iterations"] = it
    report["phase1_suppressed_voxels"] = int(supp.any(0).sum())

    # Phase 2: merge whatever is still small (or unlabelled) into the most common
    # neighbouring label; one component at a time, smallest first, until stable.
    forced = np.full(V, -1, np.int16)
    lab = lab.copy()
    merges = 0
    for _ in range(50):
        lab3 = lab.reshape(N, N, N)
        c, sizes = components(lab3)
        bad = np.flatnonzero((sizes < min_vox) & (np.arange(sizes.size) > 0))
        unl = np.unique(c.ravel()[lab == NONE])
        bad = np.union1d(bad, unl[unl > 0])
        if bad.size == 0:
            break
        objs = ndimage.find_objects(c)
        changed = False
        for b in bad[np.argsort(sizes[bad])]:
            sl = objs[b - 1]
            sl = tuple(slice(max(s.start - 1, 0), s.stop + 1) for s in sl)
            m = c[sl] == b
            new = neighbour_mode(lab3[sl], m)
            if new < 0 or new == NONE:
                continue
            lab3[sl][m] = new
            forced.reshape(N, N, N)[sl][m] = new
            merges += 1
            changed = True
        if not changed:
            break
    report["phase2_merges"] = merges
    report["phase2_forced_voxels"] = int((forced >= 0).sum())
    assert (lab != NONE).all()

    # Effective candidate lists consistent with the final labels.
    ev, ei = effective(vals, idx, supp)
    fv = np.flatnonzero(forced >= 0)
    if fv.size:
        fl = forced[fv].astype(np.uint8)
        sub_v, sub_i = ev[:, fv], ei[:, fv]
        # base the forced value on the best remaining candidate; if every tracked
        # candidate was suppressed that is -inf, so use the density floor instead
        # (keeps the margin fields finite)
        top = np.where(np.isfinite(sub_v[0]), sub_v[0], LOG_FLOOR)
        sub_v[sub_i == fl[None, :]] = -np.inf  # remove forced label from its old slot
        o = np.argsort(-sub_v, axis=0, kind="stable")
        sub_v = np.take_along_axis(sub_v, o, 0)
        sub_i = np.take_along_axis(sub_i, o, 0)
        sub_i[~np.isfinite(sub_v)] = NONE
        sub_v = np.concatenate([(top + FORCE_DELTA)[None], sub_v[:-1]], 0)
        sub_i = np.concatenate([fl[None], sub_i[:-1]], 0)
        ev[:, fv], ei[:, fv] = sub_v, sub_i
    assert (ei[0] == lab).all(), "effective lists disagree with cleaned labels"

    # Final names: present labels sorted by voxel count; absent candidates after.
    nc = len(cand["labels"])
    vox = np.bincount(lab, minlength=nc)[:nc]
    present = [i for i in np.argsort(-vox, kind="stable") if vox[i] > 0]
    absent = [i for i in range(nc) if vox[i] == 0]
    remap = np.full(256, NONE, np.uint8)
    for new, old in enumerate(present + absent):
        remap[old] = new
    lab = remap[lab]
    ei = remap[ei]
    n_names = len(present)

    # Components of the final volume, sorted by size desc.
    lab3 = lab.reshape(N, N, N)
    c, sizes = components(lab3)
    ncomp = sizes.size - 1
    assert sizes[1:].min() >= min_vox
    order = np.argsort(-sizes[1:], kind="stable")  # old id-1 sorted
    newid = np.empty(ncomp + 1, np.int32)
    newid[0] = -1
    newid[order + 1] = np.arange(ncomp, dtype=np.int32)
    comp = newid[c.ravel()]
    objs = ndimage.find_objects(c)

    # stats
    bb, gg, rr = np.meshgrid(np.arange(N), np.arange(N), np.arange(N), indexing="ij")
    rr, gg, bb = rr.ravel().astype(np.float64), gg.ravel().astype(np.float64), bb.ravel().astype(np.float64)

    def means(key, n):
        cnt = np.bincount(key, minlength=n).astype(np.float64)
        return cnt, np.stack([np.bincount(key, weights=w, minlength=n) / np.maximum(cnt, 1)
                              for w in (rr, gg, bb)], 1)

    ncnt, nmean = means(lab, n_names)
    ccnt, cmean = means(comp, ncomp)
    comp_label = np.zeros(ncomp, np.int64)
    comp_label[comp] = lab  # every voxel of a component has the same label
    names = []
    for new, old in enumerate(present):
        names.append({
            "name": cand["labels"][old],
            "voxels": int(ncnt[new]),
            "fraction": round(float(ncnt[new]) / N ** 3, 6),
            "answers": int(cand["answers"][old]),
            "meanColor": [round(float(x), 2) for x in nmean[new]],
            "centroid": [round(float(x) + 0.5, 3) for x in nmean[new]],
        })
    comps = []
    for k in range(ncomp):
        sl = objs[order[k]]  # slices in [b, g, r]
        comps.append({
            "nameIndex": int(comp_label[k]),
            "voxels": int(ccnt[k]),
            "centroid": [round(float(x) + 0.5, 3) for x in cmean[k]],
            "bboxMin": [sl[2].start, sl[1].start, sl[0].start],
            "bboxMax": [sl[2].stop, sl[1].stop, sl[0].stop],
        })
    absent_names = [cand["labels"][i] for i in absent]
    np.save(d / "labels.npy", lab)
    np.save(d / "comp.npy", comp)
    np.save(d / "effv.npy", ev.astype(np.float32).reshape(K, N, N, N))
    np.save(d / "effi.npy", ei.reshape(K, N, N, N))
    changed = int((lab != remap[idx[0]]).sum())
    report.update(names=n_names, components=ncomp, relabelled_voxels=changed,
                  relabelled_fraction=round(changed / V, 5))
    write_json(d / "clean.json", {"level": level, "sigma": cand["sigma"], "names": names,
                                  "components": comps, "candidates": len(cand["labels"]),
                                  "absent_candidates": absent_names, "report": report})
    per_name = np.bincount(comp_label, minlength=n_names)
    multi = [(names[i]["name"], int(per_name[i])) for i in range(n_names) if per_name[i] > 1]
    print(f"[{level}] {json.dumps(report)}\n   names={n_names} comps={ncomp} "
          f"multi-component names={multi} ({time.time()-t0:.1f}s)", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--levels", default="basic,standard,detailed")
    ap.add_argument("--min-voxels", type=int, default=None)
    args = ap.parse_args()
    for level in args.levels.split(","):
        run_level(level, args.min_voxels or MIN_VOXELS[level])


if __name__ == "__main__":
    sys.exit(main())
