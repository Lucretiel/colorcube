#!/usr/bin/env python3
"""Step 7: validate web/public/assets against docs/CONTRACT.md and against xkcd.

(a) asserts every contract invariant (offsets, counts, index ranges, components
    cover the volume, sorting, closed + outward meshes, mesh volume accuracy, ...)
    and, from build/<level>, that neighbouring labels track each other in the
    candidate lists and that the top-K lists match exact densities at random voxels
(b) agreement of each level's cleaned labels with satfaces.txt on the 3 faces
(c) build/validation/faces_<level>.png: ours | xkcd | diff, laid out like
    satfaces_map_huge.png
(d) build/validation/slice_<level>_<axis><v>.png: labelled slices
Exit status is non-zero if any invariant fails.
"""
import argparse
import gzip
import json
import sys
from collections import Counter

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage
from skimage.measure import label as cc_label

from common import ASSETS, BUILD, N, basic_head, face_slices, load_satfaces, write_json

OUT = BUILD / "validation"
FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print("  FAIL:", msg)
    return cond


def load_level(level):
    d = ASSETS / level
    meta = json.loads((d / "meta.json").read_text())
    raw = (d / meta["mesh"]["file"]).read_bytes()
    if raw[:2] == b"\x1f\x8b":  # contract: meshes.bin may be gzip-compressed
        raw = gzip.decompress(raw)
    lab = np.frombuffer(gzip.decompress((d / "labels.lbl").read_bytes()), np.uint8)
    return meta, raw, lab


def validate_contract(level):
    print(f"[{level}] contract checks")
    meta, raw, lab = load_level(level)
    m = meta["mesh"]
    names, comps = meta["names"], meta["components"]
    check(meta["level"] == level, "level id")
    check(meta["resolution"] == N, "resolution")
    for k in ("answers", "users", "sigma", "notes"):
        check(k in meta["source"], f"source.{k}")
    check(m["file"] == "meshes.bin", "mesh.file")
    V, I = m["vertexCount"], m["indexCount"]
    for k in ("positionsByteOffset", "normalsByteOffset", "indicesByteOffset"):
        check(m[k] % 4 == 0, f"{k} % 4")
    check(m["normalsByteOffset"] >= m["positionsByteOffset"] + 6 * V, "positions fit")
    check(m["indicesByteOffset"] >= m["normalsByteOffset"] + 4 * V, "normals fit")
    check(len(raw) == m["indicesByteOffset"] + 4 * I, "meshes.bin size")
    check(I % 3 == 0, "indexCount % 3")
    pos = np.frombuffer(raw, "<u2", 3 * V, m["positionsByteOffset"]).reshape(V, 3)
    nrm = np.frombuffer(raw, "<i1", 4 * V, m["normalsByteOffset"]).reshape(V, 4)
    idx = np.frombuffer(raw, "<u4", I, m["indicesByteOffset"])
    P = pos.astype(np.float64) * 256.0 / 65535.0
    check((nrm[:, 3] == 0).all(), "normal w == 0")
    nl = np.linalg.norm(nrm[:, :3].astype(np.float64) / 127.0, axis=1)
    check(np.abs(nl - 1).max() < 0.03, f"normals unit length (max dev {np.abs(nl-1).max():.3f})")

    check(lab.size == N ** 3, "labels.lbl length")
    check(int(lab.max()) < len(names), "label values < len(names)")
    # names stats
    vox = np.bincount(lab, minlength=len(names))
    for i, nm in enumerate(names):
        check(nm["voxels"] == int(vox[i]), f"names[{i}].voxels")
        check(abs(nm["fraction"] - vox[i] / N ** 3) < 1e-5, f"names[{i}].fraction")
        for key in ("answers", "meanColor", "centroid"):
            check(key in nm, f"names[{i}].{key}")
    check(all(v > 0 for v in vox), "every name has voxels")

    # components
    check(all(comps[i]["voxels"] >= comps[i + 1]["voxels"] for i in range(len(comps) - 1)),
          "components sorted by voxels desc")
    check(sum(c["voxels"] for c in comps) == N ** 3, "components cover the volume")
    cc = cc_label(lab.reshape(N, N, N).astype(np.int16), background=-1, connectivity=1)
    sizes = np.bincount(cc.ravel())[1:]
    check(len(sizes) == len(comps), f"component count ({len(sizes)} vs {len(comps)})")
    check(sorted(sizes.tolist(), reverse=True) == [c["voxels"] for c in comps],
          "component sizes match the label volume")
    per_name = Counter()
    fv = fi = 0
    closed_bad = vol_bad = 0
    tri_total = 0
    verrs = []
    for k, c in enumerate(comps):
        per_name[c["nameIndex"]] += c["voxels"]
        check(c["firstVertex"] == fv and c["firstIndex"] == fi, f"comp {k} contiguous offsets")
        fv += c["vertexCount"]
        fi += c["indexCount"]
        ci = idx[c["firstIndex"]:c["firstIndex"] + c["indexCount"]].astype(np.int64)
        check(c["indexCount"] % 3 == 0 and c["indexCount"] > 0, f"comp {k} indexCount")
        check(ci.size == 0 or ci.max() < c["vertexCount"], f"comp {k} index range")
        cp = P[c["firstVertex"]:c["firstVertex"] + c["vertexCount"]]
        cn = nrm[c["firstVertex"]:c["firstVertex"] + c["vertexCount"], :3].astype(np.float64)
        bmin, bmax = np.array(c["bboxMin"]), np.array(c["bboxMax"])
        check((cp.min(0) >= bmin - 1.01).all() and (cp.max(0) <= bmax + 1.01).all(),
              f"comp {k} vertices inside bbox")
        f = ci.reshape(-1, 3)
        tri_total += len(f)
        # closed 2-manifold: every directed edge has its reverse exactly once
        e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
        key = e[:, 0] * c["vertexCount"] + e[:, 1]
        rkey = e[:, 1] * c["vertexCount"] + e[:, 0]
        ks = np.sort(key)
        dup = (ks[1:] == ks[:-1]).sum()
        missing = (~np.isin(rkey, key)).sum()
        if dup or missing:
            closed_bad += 1
            print(f"  note: comp {k} ({names[c['nameIndex']]['name']}) not closed: "
                  f"{dup} duplicate directed edges, {missing} unmatched")
        v0, v1, v2 = cp[f[:, 0]], cp[f[:, 1]], cp[f[:, 2]]
        fn = np.cross(v1 - v0, v2 - v0)
        vol = np.einsum("ij,ij->i", v0, np.cross(v1, v2)).sum() / 6.0
        if not check(vol > 0, f"comp {k} positive signed volume (CCW outward)"):
            vol_bad += 1
        # normals agree with face orientation
        agree = (np.einsum("ij,ij->i", fn, cn[f[:, 0]] + cn[f[:, 1]] + cn[f[:, 2]]) > 0).mean()
        check(agree > 0.97, f"comp {k} normals agree with winding ({agree:.3f})")
        verr = abs(vol - c["voxels"]) / c["voxels"]
        verrs.append(verr)
        check(verr < 0.05, f"comp {k} mesh volume vs voxels ({verr:.3f})")
        check(names[c["nameIndex"]] is not None, f"comp {k} nameIndex")
    check(fv == meta["mesh"]["vertexCount"] and fi == meta["mesh"]["indexCount"],
          "component ranges cover the buffers")
    check(all(per_name[i] == names[i]["voxels"] for i in range(len(names))),
          "component voxels sum to names voxels")
    check(closed_bad == 0, f"{closed_bad} component meshes not closed")
    # aggregate mesh accuracy (catches systematically misplaced boundaries, e.g. from
    # wrong runner-up densities, which per-component tolerances let through)
    verrs = np.array(verrs)
    vw = np.array([c["voxels"] for c in comps], np.float64)
    vmed, vmean = float(np.median(verrs)), float((verrs * vw).sum() / vw.sum())
    check(vmed < 0.005, f"median mesh volume error {vmed:.4f} < 0.5%")
    check(vmean < 0.01, f"voxel-weighted mean mesh volume error {vmean:.4f} < 1%")
    check(P.min() >= 0 and P.max() <= 256, "positions in [0,256]")
    print(f"  {len(names)} names, {len(comps)} components, {tri_total} triangles, "
          f"{V} vertices; closed-mesh failures {closed_bad}; volume error median "
          f"{vmed:.4f}, weighted mean {vmean:.4f}, max {verrs.max():.4f}")
    return meta, lab


def validate_candidates(level, lab, n_samples=400, seed=0):
    """Checks on the pipeline intermediates behind the meshes.

    (1) Shared boundaries: at every 6-neighbour voxel pair with different final labels,
        the neighbour's label should be in the voxel's effective candidate list (effi),
        otherwise the margin field falls back to a floor value and the two meshes no
        longer meet. Rare misses are legitimate (K-way junctions, phase-2 voxels).
    (2) Top-K correctness: exact log-densities (direct Gaussian sums over each
        candidate's answers, same truncated separable kernel as gaussian_filter) at
        random voxels must match topv/topi slots 0 and 1."""
    d = BUILD / level
    if not (d / "effi.npy").exists():
        print(f"[{level}] candidate checks skipped (no build/{level} intermediates)")
        return
    print(f"[{level}] candidate-list checks")
    effi = np.load(d / "effi.npy", mmap_mode="r")
    K = effi.shape[0]
    lab3 = lab.reshape(N, N, N)
    miss = pairs = 0
    for ax in range(3):
        a = [slice(None)] * 3
        b = [slice(None)] * 3
        a[ax], b[ax] = slice(0, -1), slice(1, None)
        la, lb = lab3[tuple(a)], lab3[tuple(b)]
        diff = la != lb
        ea = np.asarray(effi[(slice(None),) + tuple(a)])[:, diff]
        eb = np.asarray(effi[(slice(None),) + tuple(b)])[:, diff]
        la, lb = la[diff], lb[diff]
        miss += int((~(ea == lb[None]).any(0)).sum() + (~(eb == la[None]).any(0)).sum())
        pairs += 2 * int(diff.sum())
    frac = miss / max(pairs, 1)
    print(f"  boundary voxel faces whose neighbour label is untracked: {miss}/{pairs} "
          f"({frac*100:.3f}%)")
    check(frac < 0.01, f"{level}: neighbour label missing from effi at {frac*100:.2f}% "
                       f"of boundary faces (>= 1%)")
    del effi

    # (2) exact recomputation at random voxels
    from common import level_groups, load_answers
    cand = json.loads((d / "candidates.json").read_text())
    sigma = float(cand["sigma"])
    eps = float(cand["eps"])
    A = load_answers()
    labels, groups = level_groups(level, A)
    check(labels == cand["labels"], f"{level}: candidate list reproducible")
    lut = np.full(len(A["names"]), -1, np.int64)
    for c, ids in enumerate(groups):
        lut[ids] = c
    cid = lut[A["name_id"]]
    sel = cid >= 0
    rgb, cid = A["rgb"][sel].astype(np.int64), cid[sel]
    # scipy's 1D kernel: radius int(truncate*sigma + 0.5), normalised discrete Gaussian
    rad = int(4.0 * sigma + 0.5)
    w = np.exp(-0.5 * (np.arange(-rad, rad + 1) / sigma) ** 2)
    w /= w.sum()
    topv = np.load(d / "topv.npy", mmap_mode="r")
    topi = np.load(d / "topi.npy", mmap_mode="r")
    rng = np.random.default_rng(seed)
    pts = rng.integers(0, N, (n_samples, 3))  # (r, g, b)
    # bucket answers per voxel-ish cell so each sample only touches nearby answers
    cell = rad + 1
    ck = (rgb // cell) @ np.array([1, 64, 64 * 64])
    order = np.argsort(ck, kind="stable")
    ck_sorted = ck[order]
    nc = len(labels)
    bad = 0
    worst = 0.0
    for p in pts:
        lo, hi = np.maximum(p - rad, 0) // cell, np.minimum(p + rad, N - 1) // cell
        keys = [x + 64 * y + 4096 * z for z in range(lo[2], hi[2] + 1)
                for y in range(lo[1], hi[1] + 1) for x in range(lo[0], hi[0] + 1)]
        sl = [order[np.searchsorted(ck_sorted, kk):np.searchsorted(ck_sorted, kk, "right")]
              for kk in keys]
        ids = np.concatenate(sl) if sl else np.zeros(0, np.int64)
        dlt = rgb[ids] - p
        ok = (np.abs(dlt) <= rad).all(1)
        ids, dlt = ids[ok], dlt[ok]
        wt = w[dlt[:, 0] + rad] * w[dlt[:, 1] + rad] * w[dlt[:, 2] + rad]
        dens = np.bincount(cid[ids], weights=wt, minlength=nc)
        ld = np.log(dens + eps)
        exact = np.sort(ld)[::-1][:2]
        b_, g_, r_ = p[2], p[1], p[0]
        got = np.array([topv[0, b_, g_, r_], topv[1, b_, g_, r_]], np.float64)
        gi = [int(topi[0, b_, g_, r_]), int(topi[1, b_, g_, r_])]
        err = float(np.abs(got - exact).max())
        # indices must name candidates with (numerically) those densities
        ierr = max(abs(ld[gi[j]] - got[j]) if gi[j] < nc else np.inf for j in range(2))
        worst = max(worst, err, ierr)
        if err > 1e-3 or ierr > 1e-3:
            bad += 1
    print(f"  exact top-2 recomputation at {n_samples} random voxels: {bad} mismatches "
          f"(max |log-density error| {worst:.2e})")
    check(bad == 0, f"{level}: topv/topi slots 0-1 disagree with exact densities at "
                    f"{bad}/{n_samples} voxels")


# ---------------------------------------------------------------- rendering
def face_rgb(key):
    i = np.arange(N, dtype=np.uint8)
    a, b = np.meshgrid(i, i, indexing="ij")  # a = row coord, b = col coord
    z = np.zeros_like(a)
    if key == "r0":   # [g, b]
        return np.stack([z, a, b], -1)
    if key == "g0":   # [r, b]
        return np.stack([a, z, b], -1)
    return np.stack([b, a, z], -1)  # b0: [g, r]


def satmap_layout(faces):
    """faces: dict key -> 2D array (same indexing as load_satfaces). Returns a
    512x512 array laid out like satfaces_map_huge.png (bottom-left empty)."""
    first = next(iter(faces.values()))
    out = np.zeros((2 * N, 2 * N) + first.shape[2:], first.dtype)
    if out.dtype == object:
        out[:] = ""
    # top-left: b=0, x: r 255->0, y: g 255->0
    out[:N, :N] = faces["b0"][::-1, ::-1]
    # top-right: r=0, x: b 0->255, y: g 255->0
    out[:N, N:] = faces["r0"][::-1, :]
    # bottom-right: g=0, x: b 0->255, y: r 0->255
    out[N:, N:] = faces["g0"]
    return out


def borders(lab2d, valid=None):
    e = np.zeros(lab2d.shape, bool)
    e[:-1, :] |= lab2d[:-1, :] != lab2d[1:, :]
    e[1:, :] |= lab2d[:-1, :] != lab2d[1:, :]
    e[:, :-1] |= lab2d[:, :-1] != lab2d[:, 1:]
    e[:, 1:] |= lab2d[:, :-1] != lab2d[:, 1:]
    if valid is not None:
        e &= valid
    return e


def render(rgb, lab2d, label_names, valid=None, scale=3, min_area=150):
    """True colours, white borders, white uppercase names at region poles."""
    big_lab = np.kron(lab2d, np.ones((scale, scale), lab2d.dtype))
    big_rgb = np.kron(rgb, np.ones((scale, scale, 1), rgb.dtype))
    big_valid = None if valid is None else np.kron(valid, np.ones((scale, scale), bool))
    e = borders(big_lab, big_valid)
    img = big_rgb.copy()
    img[e] = 255
    if big_valid is not None:
        img[~big_valid] = 255
    im = Image.fromarray(img)
    dr = ImageDraw.Draw(im)
    regions = cc_label(lab2d.astype(np.int32), background=-1, connectivity=1)
    for rid in range(1, regions.max() + 1):
        m = regions == rid
        if valid is not None and not valid[m].all():
            continue
        area = int(m.sum())
        if area < min_area:
            continue
        dt = ndimage.distance_transform_edt(np.pad(m, 1))[1:-1, 1:-1]
        y, x = np.unravel_index(np.argmax(dt), dt.shape)
        text = label_names[int(lab2d[y, x])].upper()
        size = int(np.clip(dt[y, x] * scale * 0.55, 9, 48))
        font = ImageFont.load_default(size=size)
        while size > 9 and dr.textlength(text, font=font) > 2.2 * dt[y, x] * scale:
            size -= 1
            font = ImageFont.load_default(size=size)
        dr.text(((x + 0.5) * scale, (y + 0.5) * scale), text, fill=(255, 255, 255),
                font=font, anchor="mm", stroke_width=max(1, size // 12), stroke_fill=(40, 40, 40))
    return im


def faces_png(level, lab, names, truth, agreement_txt):
    vol = lab.reshape(N, N, N)
    ours = face_slices(vol)
    label_names = [n["name"] for n in names]
    # unify vocabularies for rendering xkcd's
    tnames = sorted(set().union(*[set(t.ravel()) for t in truth.values()]))
    tidx = {n: i for i, n in enumerate(tnames)}
    tlab = {k: np.vectorize(tidx.get)(t).astype(np.int32) for k, t in truth.items()}
    rgb = satmap_layout({k: face_rgb(k) for k in ours})
    valid = satmap_layout({k: np.ones((N, N), bool) for k in ours})
    our_lay = satmap_layout({k: v.astype(np.int32) for k, v in ours.items()})
    tr_lay = satmap_layout(tlab)
    a = render(rgb, our_lay, label_names, valid)
    b = render(rgb, tr_lay, tnames, valid)
    # diff: where our name != xkcd name (dim true colour where they agree)
    ours_s = satmap_layout({k: np.array(label_names, dtype=object)[v] for k, v in ours.items()})
    tr_s = satmap_layout({k: v for k, v in truth.items()})
    diff = (ours_s != tr_s) & valid
    dimg = (rgb.astype(np.float64) * 0.25 + 191).astype(np.uint8)
    dimg[diff] = rgb[diff]
    dimg[~valid] = 255
    c = Image.fromarray(np.kron(dimg, np.ones((3, 3, 1), np.uint8)))
    W, H = a.size
    canvas = Image.new("RGB", (3 * W + 40, H + 60), (255, 255, 255))
    for i, im in enumerate((a, b, c)):
        canvas.paste(im, (i * (W + 20), 60))
    dr = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=28)
    for i, t in enumerate((f"ours: {level}", "xkcd satfaces.txt", f"disagreement ({agreement_txt})")):
        dr.text((i * (W + 20) + 10, 15), t, fill=(0, 0, 0), font=font)
    OUT.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT / f"faces_{level}.png")


def slice_png(level, lab, names, axis, v):
    vol = lab.reshape(N, N, N)  # [b, g, r]
    i = np.arange(N, dtype=np.uint8)
    A, B = np.meshgrid(i, i, indexing="ij")  # rows, cols
    if axis == "r":   # rows g (top=255), cols b
        sl = vol[:, :, v].T[::-1]
        rgb = np.stack([np.full_like(A, v), A[::-1], B], -1)
    elif axis == "g":  # rows r (top=255), cols b
        sl = vol[:, v, :].T[::-1]
        rgb = np.stack([A[::-1], np.full_like(A, v), B], -1)
    else:              # rows g (top=255), cols r
        sl = vol[v, :, :][::-1]
        rgb = np.stack([B, A[::-1], np.full_like(A, v)], -1)
    im = render(rgb, sl.astype(np.int32), [n["name"] for n in names], scale=3, min_area=100)
    im.save(OUT / f"slice_{level}_{axis}{v}.png")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--levels", default="basic,standard,detailed")
    ap.add_argument("--no-png", action="store_true")
    ap.add_argument("--no-candidates", action="store_true",
                    help="skip the checks on build/<level> intermediates (assets only)")
    args = ap.parse_args()
    truth = load_satfaces()
    levels_json = json.loads((ASSETS / "levels.json").read_text())
    check(levels_json["default"] in [l["id"] for l in levels_json["levels"]], "levels.json default")
    report = {}
    for level in args.levels.split(","):
        check(level in [l["id"] for l in levels_json["levels"]], f"{level} in levels.json")
        meta, lab = validate_contract(level)
        if not args.no_candidates:
            validate_candidates(level, lab)
        names = meta["names"]
        ours = face_slices(lab.reshape(N, N, N))
        nm = np.array([n["name"] for n in names], dtype=object)
        agree = tot = 0
        conf = Counter()
        mapped_agree = mapped_tot = 0
        for k in truth:
            p = nm[ours[k]]
            t = truth[k]
            agree += int((p == t).sum())
            tot += t.size
            for a, b in zip(t.ravel(), p.ravel()):
                if a != b:
                    conf[(a, b)] += 1
            if level == "basic":
                th = np.vectorize(lambda s: basic_head(s) or "")(t)
                ok = th != ""
                mapped_agree += int((p[ok] == th[ok]).sum())
                mapped_tot += int(ok.sum())
        acc = agree / tot
        rep = {"agreement": round(acc, 4), "names": len(names),
               "components": len(meta["components"]),
               "triangles": meta["mesh"]["indexCount"] // 3,
               "top_confusions": [[a, b, c] for (a, b), c in conf.most_common(15)]}
        txt = f"{acc*100:.1f}% agree"
        if level == "basic":
            rep["agreement_on_basic_headed_xkcd_names"] = round(mapped_agree / mapped_tot, 4)
            rep["basic_headed_fraction"] = round(mapped_tot / tot, 4)
            txt = (f"{mapped_agree/mapped_tot*100:.1f}% agree where xkcd's name has a basic head "
                   f"({mapped_tot/tot*100:.0f}% of pixels)")
        print(f"[{level}] satfaces agreement: {txt}")
        report[level] = rep
        if not args.no_png:
            faces_png(level, lab, names, truth, txt)
            for axis in "rgb":
                slice_png(level, lab, names, axis, 128)
    write_json(BUILD / "validation" / "report.json", report)
    if FAILS:
        print(f"{len(FAILS)} FAILURES")
        return 1
    print("all contract checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
