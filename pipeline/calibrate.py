#!/usr/bin/env python3
"""Choose the density-smoothing sigma by agreement with xkcd's satfaces.txt.

The 3D Gaussian KDE evaluated on a cube face (e.g. voxel index r=0) equals a 2D
Gaussian blur of a 2D histogram whose samples are weighted by
exp(-(r_s - 0)^2 / 2 sigma^2), so the sweep is exact and cheap.

Writes build/calibration.json and prints the agreement table.
"""
import sys
from collections import Counter

import numpy as np
from scipy.ndimage import gaussian_filter

from common import BUILD, N, level_groups, load_answers, load_satfaces, write_json

SIGMAS = [3, 4, 5, 6, 7, 8, 10, 12, 16]
TOPS = [20, 27, 36, 50, 80]
TOL = 0.001


def face_labels(A, groups_ids, sigma, aniso=None):
    """groups_ids: list of arrays of raw name ids per candidate.
    Returns dict face -> argmax candidate index (256x256)."""
    rgb = A["rgb"].astype(np.int64)
    nid = A["name_id"]
    lut = np.full(len(A["names"]), -1, np.int64)
    for k, ids in enumerate(groups_ids):
        lut[ids] = k
    cand = lut[nid]
    sel = cand >= 0
    rgb, cand = rgb[sel], cand[sel]
    K = len(groups_ids)
    out = {}
    # face key -> (normal channel, row channel, col channel)
    spec = {"r0": (0, 1, 2), "g0": (1, 0, 2), "b0": (2, 1, 0)}
    for key, (nc, rc, cc) in spec.items():
        d = rgb[:, nc].astype(np.float64)
        m = d < 4.5 * sigma
        w = np.exp(-(d[m] ** 2) / (2 * sigma * sigma))
        flat = cand[m] * N * N + rgb[m, rc] * N + rgb[m, cc]
        H = np.bincount(flat, weights=w, minlength=K * N * N).reshape(K, N, N)
        best = np.full((N, N), -1.0)
        arg = np.zeros((N, N), np.int64)
        for k in range(K):
            dk = gaussian_filter(H[k], sigma, mode="constant", truncate=4.0)
            better = dk > best
            best[better] = dk[better]
            arg[better] = k
        out[key] = arg
    return out


def agreement(labels, pred, truth):
    tot = agree = 0
    conf = Counter()
    for key in truth:
        p = np.array(labels, dtype=object)[pred[key]]
        t = truth[key]
        agree += int((p == t).sum())
        tot += t.size
        for a, b in zip(t.ravel(), p.ravel()):
            if a != b:
                conf[(a, b)] += 1
    return agree / tot, conf


def main():
    A = load_answers()
    names = [str(n) for n in A["names"]]
    idx = {n: i for i, n in enumerate(names)}
    truth = load_satfaces()
    truth_names = sorted(set().union(*[set(t.ravel()) for t in truth.values()]))
    print("satfaces names:", len(truth_names), "missing from survey:",
          [n for n in truth_names if n not in idx])

    sets = {}
    for lv in ("standard", "detailed"):
        labels, groups = level_groups(lv, A)
        sets[lv] = (labels, groups)
    for k in TOPS:
        sets[f"top{k}"] = (names[:k], [np.array([i]) for i in range(k)])
    sets["satfaces27"] = (truth_names, [np.array([idx[n]]) for n in truth_names])
    table, confs = {}, {}
    for sname, (labels, groups) in sets.items():
        row = {}
        for s in SIGMAS:
            pred = face_labels(A, groups, s)
            acc, conf = agreement(labels, pred, truth)
            row[s] = round(acc, 4)
            confs[(sname, s)] = conf
        table[sname] = row
        print(f"{sname:>11}: " + "  ".join(f"s={s}:{a:.3f}" for s, a in row.items()), flush=True)

    # standard: the agreement-maximising sigma (ties -> larger, i.e. smoother).
    # detailed: favour resolution -- the smallest sigma within TOL of its optimum.
    chosen = {}
    row = table["standard"]
    best = max(row.values())
    chosen["standard"] = max(s for s, a in row.items() if a == best)
    chosen["basic"] = chosen["standard"]  # satfaces vocabulary can't score basic terms
    row = table["detailed"]
    best = max(row.values())
    chosen["detailed"] = min(s for s, a in row.items() if a >= best - TOL)
    print("chosen sigma per level:", chosen)
    for lv in ("standard", "detailed"):
        s = chosen[lv]
        print(f"\n[{lv}] sigma {s}: agreement {table[lv][s]:.4f}; top confusions (xkcd -> ours, pixels):")
        for (a, b), c in confs[(lv, s)].most_common(20):
            print(f"  {a:>12} -> {b:<14} {c}")
    write_json(BUILD / "calibration.json", {
        "sigmas": SIGMAS, "table": table, "tolerance_detailed": TOL,
        "chosen_sigma": chosen,
        "confusions": {lv: [[a, b, c] for (a, b), c in confs[(lv, chosen[lv])].most_common(40)]
                       for lv in ("standard", "detailed")}})


if __name__ == "__main__":
    sys.exit(main())
