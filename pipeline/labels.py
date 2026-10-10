#!/usr/bin/env python3
"""Step 2: smoothed per-name densities on the 256^3 grid -> per-voxel top-K.

For each level, every candidate name's answers are histogrammed into a 256^3
grid (flat index r + 256 g + 65536 b, i.e. numpy arrays indexed [b, g, r]) and
blurred with an isotropic Gaussian (sigma from calibration). Instead of keeping
every density we keep, per voxel, the K=4 largest log-densities and which
candidate they belong to. That is enough to (a) take the argmax label, (b) relabel
small components to their runner-up during cleaning and (c) build smooth
"margin" fields log d_L - max_{k != L} log d_k for meshing, because a label's
boundary is only ever near where it is in the top two/three.

Writes build/<level>/topv.npy (float32 [K,256,256,256], descending),
build/<level>/topi.npy (uint8, candidate index, 255 = none) and
build/<level>/candidates.json.
"""
import argparse
import json
import os
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from scipy.ndimage import gaussian_filter

from common import BUILD, N, flat_index, level_groups, load_answers, write_json

K = 4
EPS = 1e-5  # answers / voxel; ~1/10 of a single answer's peak contribution at sigma 8
NONE = 255


def insert(vals, idx, d, i):
    """Insert density d (labelled i) into the per-voxel descending top-K lists in place.

    Bubble-down insertion over all K slots: a value that loses slot j at every voxel
    can still belong in slot j+1, so there is no early exit. Lists are ordered by
    (value desc, candidate index asc), a total order, so the result does not depend
    on insertion order (i.e. on how candidates are split across workers)."""
    cur_v = d
    cur_i = np.full(d.shape, i, np.uint8) if np.isscalar(i) else i
    for j in range(vals.shape[0]):
        m = (cur_v > vals[j]) | ((cur_v == vals[j]) & (cur_i < idx[j]))
        nv = np.where(m, vals[j], cur_v)
        ni = np.where(m, idx[j], cur_i)
        vals[j] = np.where(m, cur_v, vals[j])
        idx[j] = np.where(m, cur_i, idx[j])
        cur_v, cur_i = nv, ni


def _selftest():
    """Regression check for insert() (it once stopped early and dropped runner-ups)."""
    v = np.full((K, 2), -np.inf, np.float32)
    ix = np.full((K, 2), NONE, np.uint8)
    for val, c in ((5, 0), (3, 1), (4, 2), (1, 3), (2, 4), (4, 5)):
        insert(v, ix, np.array([val, -val], np.float32), c)
    assert v[:, 0].tolist() == [5, 4, 4, 3] and ix[:, 0].tolist() == [0, 2, 5, 1], (v, ix)
    assert v[:, 1].tolist() == [-1, -2, -3, -4] and ix[:, 1].tolist() == [3, 4, 1, 2], (v, ix)
    # merging two partial lists in either order gives the same result
    a = [np.full((K, 1), -np.inf, np.float32), np.full((K, 1), NONE, np.uint8)]
    b = [a[0].copy(), a[1].copy()]
    for val, c in ((5, 0), (3, 2)):
        insert(a[0], a[1], np.array([val], np.float32), c)
    for val, c in ((4, 1), (3, 3), (3, 4)):
        insert(b[0], b[1], np.array([val], np.float32), c)
    m1 = [a[0].copy(), a[1].copy()]
    m2 = [b[0].copy(), b[1].copy()]
    for j in range(K):
        insert(m1[0], m1[1], b[0][j], b[1][j])
        insert(m2[0], m2[1], a[0][j], a[1][j])
    assert (m1[0] == m2[0]).all() and (m1[1] == m2[1]).all(), (m1, m2)
    assert m1[1][:, 0].tolist() == [0, 1, 2, 3], m1


def worker(args):
    level, cand_ids, groups, sigma, outpath = args
    A = load_answers()
    lut = np.full(len(A["names"]), -1, np.int64)
    for c, ids in zip(cand_ids, groups):
        lut[ids] = c
    cand = lut[A["name_id"]]
    sel = cand >= 0
    flat = flat_index(A["rgb"][sel])
    cand = cand[sel]
    order = np.argsort(cand, kind="stable")
    flat, cand = flat[order], cand[order]
    bounds = np.searchsorted(cand, cand_ids + [cand_ids[-1] + 1])
    vals = np.full((K, N * N * N), -np.inf, np.float32)
    idx = np.full((K, N * N * N), NONE, np.uint8)
    for j, c in enumerate(cand_ids):
        f = flat[bounds[j]:bounds[j + 1]]
        h = np.bincount(f, minlength=N ** 3).astype(np.float32).reshape(N, N, N)
        d = gaussian_filter(h, sigma, mode="constant", truncate=4.0)
        np.maximum(d, 0, out=d)
        d = np.log(d + EPS).ravel()
        insert(vals, idx, d, c)
    np.save(outpath + ".v.npy", vals)
    np.save(outpath + ".i.npy", idx)
    return outpath


def run_level(level, A, sigma, jobs):
    t0 = time.time()
    labels, groups = level_groups(level, A)
    counts = A["name_counts"]
    answers = [int(counts[g].sum()) for g in groups]
    nc = len(labels)
    assert nc < NONE
    # interleave candidates across workers to balance (big names cost the same as small)
    chunks = [list(range(w, nc, jobs)) for w in range(min(jobs, nc))]
    tmpdir = tempfile.mkdtemp(dir=BUILD)
    tasks = [(level, ch, [groups[c] for c in ch], sigma, os.path.join(tmpdir, f"w{w}"))
             for w, ch in enumerate(chunks)]
    with ProcessPoolExecutor(max_workers=len(tasks)) as ex:
        outs = list(ex.map(worker, tasks))
    vals = idx = None
    for o in outs:
        v, i = np.load(o + ".v.npy"), np.load(o + ".i.npy")
        if vals is None:
            vals, idx = v, i
        else:
            for j in range(K):
                insert(vals, idx, v[j], i[j])
        os.remove(o + ".v.npy")
        os.remove(o + ".i.npy")
    os.rmdir(tmpdir)
    out = BUILD / level
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / "topv.npy", vals.reshape(K, N, N, N))
    np.save(out / "topi.npy", idx.reshape(K, N, N, N))
    raw = idx[0]
    present = np.bincount(raw, minlength=256)
    margin = vals[0] - vals[1]
    write_json(out / "candidates.json", {
        "level": level, "sigma": sigma, "eps": EPS, "K": K,
        "labels": labels, "answers": answers,
        "raw_voxels": [int(present[c]) for c in range(nc)],
    })
    won = int((present[:nc] > 0).sum())
    print(f"[{level}] {nc} candidates, {won} win somewhere; median top1-top2 log margin "
          f"{float(np.median(margin)):.3f}; {time.time()-t0:.1f}s", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--levels", default="basic,standard,detailed")
    ap.add_argument("--sigma", type=float, default=None,
                    help="default: per-level chosen_sigma from build/calibration.json")
    ap.add_argument("--jobs", type=int, default=min(12, os.cpu_count() or 4))
    args = ap.parse_args()
    _selftest()
    chosen = json.loads((BUILD / "calibration.json").read_text())["chosen_sigma"]
    A = load_answers()
    for level in args.levels.split(","):
        sigma = args.sigma if args.sigma is not None else float(chosen[level])
        run_level(level, A, sigma, args.jobs)


if __name__ == "__main__":
    sys.exit(main())
