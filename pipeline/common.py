"""Shared helpers for the colorcube pipeline."""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
ASSETS = ROOT / "web" / "public" / "assets"
N = 256

BASIC_TERMS = ["black", "white", "gray", "red", "orange", "yellow",
               "green", "blue", "purple", "pink", "brown"]

# Level definitions. Thresholds are on (normalised) answer counts.
LEVELS = {
    "basic": dict(
        title="Basic (11 terms)",
        description="The 11 Berlin–Kay basic color terms. Every answer whose head word is a "
                    "basic term counts for it (e.g. 'dark green', 'bluish green' and "
                    "'lime green' all count as green).",
    ),
    "standard": dict(
        title="Standard ({n} names)",
        description="The {top} most frequently given names (each given at least {mincount:,} times) "
                    "plus the basic terms black and white — {k} candidates, {n} of which win "
                    "somewhere. Comparable to xkcd's 2D map.",
        top=36, include_basic=True,
    ),
    "detailed": dict(
        title="Detailed ({n} names)",
        description="Every name given at least {mincount:,} times ({k} candidates) competes; "
                    "{n} of them are the most popular name somewhere in the cube.",
        mincount=1500,
    ),
}


def load_answers():
    z = np.load(BUILD / "answers.npz", allow_pickle=False)
    return {k: z[k] for k in z.files}


def basic_head(name):
    """Map a normalised name to its Berlin-Kay head term (last word), or None."""
    w = name.split(" ")
    if w[-1] in BASIC_TERMS:
        return w[-1]
    return None


def level_groups(level, A):
    """Return (labels, groups): labels[i] is the display name of candidate i and
    groups[i] is the array of raw name ids that count towards it."""
    names = A["names"]
    counts = A["name_counts"]
    if level == "basic":
        groups = {t: [] for t in BASIC_TERMS}
        for i, n in enumerate(names):
            h = basic_head(str(n))
            if h is not None:
                groups[h].append(i)
        labels = BASIC_TERMS
        return labels, [np.array(groups[t], np.int64) for t in labels]
    cfg = LEVELS[level]
    if "top" in cfg:
        k = cfg["top"]
    else:
        k = int((counts >= cfg["mincount"]).sum())
    ids = list(range(k))
    if cfg.get("include_basic"):
        idx = {str(n): i for i, n in enumerate(names)}
        ids = sorted(set(ids) | {idx[t] for t in BASIC_TERMS})
    labels = [str(names[i]) for i in ids]
    return labels, [np.array([i], np.int64) for i in ids]


def flat_index(rgb):
    rgb = rgb.astype(np.int64)
    return rgb[:, 0] + 256 * rgb[:, 1] + 65536 * rgb[:, 2]


def load_satfaces():
    """Return dict face -> (256x256 array of names-as-str). Faces:
    'b0': indexed [g, r] (b=0), 'r0': [g, b] (r=0), 'g0': [r, b] (g=0)."""
    pts = {}
    with open(ROOT / "satfaces.txt") as f:
        for line in f:
            a, b = line.split("]", 1)
            r, g, bb = (int(x) for x in a[1:].split(","))
            pts.setdefault((r, g, bb), b.strip())  # edges listed twice; 22 disagree
    faces = {}
    i = np.arange(N)
    faces["r0"] = np.array([[pts[(0, g, b)] for b in i] for g in i], dtype=object)
    faces["g0"] = np.array([[pts[(r, 0, b)] for b in i] for r in i], dtype=object)
    faces["b0"] = np.array([[pts[(r, g, 0)] for r in i] for g in i], dtype=object)
    return faces


def face_slices(vol):
    """vol is indexed [b, g, r] (flat order). Return the three faces with the
    same indexing as load_satfaces()."""
    return {"r0": vol[:, :, 0].T,  # [b,g] -> [g,b]
            "g0": vol[:, 0, :].T,  # [b,r] -> [r,b]
            "b0": vol[0, :, :]}    # [g,r]


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1))
