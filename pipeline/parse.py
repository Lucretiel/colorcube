#!/usr/bin/env python3
"""Step 1: stream the xkcd main-survey SQL dump -> build/answers.npz.

Extracts users (id, spamprob, colorblind, monitor) and answers (user, r, g, b,
colorname), normalises colour names, drops junk names, spam users and
(self-reported) colour-blind users, and caches the result as compact numpy
arrays plus a name table sorted by answer count.

Usage: python3 pipeline/parse.py [--dump data/mainsurvey_sqldump.txt] [--out build/answers.npz]
"""
import argparse
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent

# Users whose spam probability is above this are dropped. The xkcd survey
# assigned every user a "spamprob" (fraction of their answers that looked like
# junk/abuse, sometimes > 1). The distribution is very heavy near 0 with a long
# tail; see README for the histogram that motivated this value.
SPAM_THRESHOLD = 0.5
EXCLUDE_COLORBLIND = True

MAX_NAME_LEN = 40

USER_RE = re.compile(
    r"^INSERT INTO \"users\" VALUES\((\d+),(?:'(?:[^']|'')*'|NULL),[^,]*,(?:'(?:[^']|'')*'|NULL),"
    r"(?:'(?:[^']|'')*'|NULL),('(?:[^']|'')*'|NULL),[^,]*,[^,]*,([^,]*),[^,]*,(?:'(?:[^']|'')*'|NULL),([^,]*)\);$"
)
ANSWER_RE = re.compile(
    r"^INSERT INTO \"answers\" VALUES\((\d+),(\d+),[^,]*,(\d+),(\d+),(\d+),('(?:[^']|'')*'|NULL)\);$"
)

# Common misspellings / spelling variants folded together. Applied per word.
WORD_FIXES = {
    "grey": "gray", "greyish": "grayish", "greys": "gray",
    "blueish": "bluish", "purpleish": "purplish", "redish": "reddish",
    "orangeish": "orangish", "pinkish": "pinkish", "yellowy": "yellowish",
    "fuschia": "fuchsia", "fuschsia": "fuchsia", "fucshia": "fuchsia", "fushia": "fuchsia",
    "fuchia": "fuchsia", "fusia": "fuchsia", "fuchsia": "fuchsia",
    "fuscia": "fuchsia", "fucsia": "fuchsia", "fuchsa": "fuchsia",
    "burgandy": "burgundy", "forrest": "forest",
    "lavendar": "lavender", "lavander": "lavender",
    "turqoise": "turquoise", "turquiose": "turquoise", "torquoise": "turquoise",
    "turquise": "turquoise", "tourquoise": "turquoise", "turquoize": "turquoise",
    "aquamarin": "aquamarine", "chartruese": "chartreuse", "chartruse": "chartreuse",
    "maroon": "maroon", "marroon": "maroon", "marron": "maroon",
    "violette": "violet", "beige": "beige", "biege": "beige",
    "periwinkel": "periwinkle", "perriwinkle": "periwinkle",
    "magneta": "magenta", "megenta": "magenta",
    "colour": "color",
}
# Multi-word variants folded together. Applied (as whole words) after the word fixes.
PHRASE_FIXES = [
    (re.compile(r"\bsea foam\b"), "seafoam"),
    (re.compile(r"\brobins? egg\b"), "robin's egg"),
]
LEADING_JUNK = ("a ", "an ", "the ")


def sql_str(tok):
    if tok == "NULL":
        return None
    return tok[1:-1].replace("''", "'")


def normalise(raw):
    """Return a normalised colour name, or None if it is junk."""
    if raw is None:
        return None
    s = raw.lower().strip()
    s = re.sub(r"[-_/\\]", " ", s)  # "blue-green", "blue/green" -> "blue green"
    s = re.sub(r"[\"`]", "", s)
    s = re.sub(r"[.!?,;:]+$", "", s).strip().strip("'").strip()
    s = re.sub(r"\s+", " ", s)
    if not s or len(s) > MAX_NAME_LEN:
        return None
    if not re.fullmatch(r"[a-z][a-z' ]*[a-z]", s):
        return None  # digits, symbols, non-ascii letters, single chars
    words = [WORD_FIXES.get(w, w) for w in s.split(" ")]
    # "sky blue color" -> "sky blue"
    while len(words) > 1 and words[-1] == "color":
        words.pop()
    s = " ".join(words)
    for rx, rep in PHRASE_FIXES:
        s = rx.sub(rep, s)
    for lj in LEADING_JUNK:
        if s.startswith(lj) and len(s) > len(lj) + 2:
            s = s[len(lj):]
    return s


def main():
    global SPAM_THRESHOLD, EXCLUDE_COLORBLIND
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", default=str(ROOT / "data/mainsurvey_sqldump.txt"))
    ap.add_argument("--out", default=str(ROOT / "build/answers.npz"))
    ap.add_argument("--spam-threshold", type=float, default=SPAM_THRESHOLD)
    ap.add_argument("--keep-colorblind", action="store_true")
    args = ap.parse_args()
    SPAM_THRESHOLD = args.spam_threshold
    EXCLUDE_COLORBLIND = not args.keep_colorblind

    t0 = time.time()
    users = {}  # id -> (spamprob, colorblind, monitor)
    a_user, a_r, a_g, a_b, a_name = [], [], [], [], []
    bad_user_lines = bad_answer_lines = 0
    with open(args.dump, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith('INSERT INTO "answers"'):
                m = ANSWER_RE.match(line.rstrip("\n"))
                if not m:
                    bad_answer_lines += 1
                    continue
                a_user.append(int(m.group(2)))
                a_r.append(int(m.group(3)))
                a_g.append(int(m.group(4)))
                a_b.append(int(m.group(5)))
                a_name.append(sql_str(m.group(6)))
            elif line.startswith('INSERT INTO "users"'):
                m = USER_RE.match(line.rstrip("\n"))
                if not m:
                    bad_user_lines += 1
                    continue
                uid = int(m.group(1))
                mon = sql_str(m.group(2))
                cb = m.group(3)
                sp = m.group(4)
                users[uid] = (
                    float(sp) if sp not in ("NULL", "") else np.nan,
                    int(cb) if cb not in ("NULL", "") else -1,
                    mon or "",
                )
    print(f"parsed {len(users)} users, {len(a_user)} answers in {time.time()-t0:.1f}s "
          f"(unparsed lines: users {bad_user_lines}, answers {bad_answer_lines})")

    a_user = np.asarray(a_user, np.int32)
    rgb = np.stack([np.asarray(a_r), np.asarray(a_g), np.asarray(a_b)], 1)
    assert rgb.min() >= 0 and rgb.max() <= 255
    rgb = rgb.astype(np.uint8)

    uids = np.array(sorted(users), np.int32)
    spam = np.array([users[u][0] for u in uids], np.float64)
    cblind = np.array([users[u][1] for u in uids], np.int8)
    monitor = [users[u][2] for u in uids]

    # spamprob distribution (for documentation)
    finite = spam[np.isfinite(spam)]
    qs = [0.5, 0.75, 0.9, 0.95, 0.98, 0.99]
    print("spamprob quantiles:", {q: round(float(np.quantile(finite, q)), 4) for q in qs})
    edges = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1.0, 1.01, np.inf]
    h, _ = np.histogram(finite, bins=edges)
    print("spamprob histogram:", {f"[{edges[i]},{edges[i+1]})": int(h[i]) for i in range(len(h))})
    # answers per spam bin
    uid_to_row = {u: i for i, u in enumerate(uids)}
    rows = np.array([uid_to_row.get(u, -1) for u in a_user.tolist()], np.int64)
    known = rows >= 0
    a_spam = np.full(len(a_user), np.nan)
    a_spam[known] = spam[rows[known]]
    a_cb = np.full(len(a_user), -1, np.int8)
    a_cb[known] = cblind[rows[known]]

    stats = {"answers_raw": int(len(a_user)), "users_raw": int(len(uids))}
    keep = np.ones(len(a_user), bool)
    keep_spam = np.isfinite(a_spam) & (a_spam <= SPAM_THRESHOLD)
    stats["answers_dropped_spam_or_unknown_user"] = int((~keep_spam).sum())
    keep &= keep_spam
    if EXCLUDE_COLORBLIND:
        keep_cb = a_cb != 1
        stats["answers_dropped_colorblind"] = int((keep & ~keep_cb).sum())
        keep &= keep_cb
    stats["users_spam"] = int((~(np.isfinite(spam) & (spam <= SPAM_THRESHOLD))).sum())
    stats["users_colorblind"] = int((cblind == 1).sum())

    # name normalisation (cache per distinct raw string)
    cache = {}
    norm = []
    for n in a_name:
        v = cache.get(n, 0)
        if v == 0:
            v = normalise(n)
            cache[n] = v
        norm.append(v)
    junk = np.array([v is None for v in norm])
    stats["answers_dropped_junk_name"] = int((keep & junk).sum())
    keep &= ~junk
    stats["distinct_raw_names"] = len(cache)

    kept_names = [norm[i] for i in np.flatnonzero(keep)]
    counts = Counter(kept_names)
    name_table = [n for n, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
    idx = {n: i for i, n in enumerate(name_table)}
    name_ids = np.array([idx[n] for n in kept_names], np.int32)
    name_counts = np.array([counts[n] for n in name_table], np.int64)
    kept_users = np.unique(a_user[keep])

    stats["answers_kept"] = int(keep.sum())
    stats["users_kept"] = int(len(kept_users))
    stats["distinct_names_kept"] = len(name_table)
    stats["spam_threshold"] = SPAM_THRESHOLD
    stats["exclude_colorblind"] = EXCLUDE_COLORBLIND
    print(json.dumps(stats, indent=1))
    print("top 60 names:", [(n, int(c)) for n, c in zip(name_table[:60], name_counts[:60])])
    print("names with >=1000 answers:", int((name_counts >= 1000).sum()),
          ">=1500:", int((name_counts >= 1500).sum()), ">=2000:", int((name_counts >= 2000).sum()))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out,
        rgb=rgb[keep], name_id=name_ids, user_id=a_user[keep],
        names=np.array(name_table, dtype=object).astype(str), name_counts=name_counts,
        user_ids=uids, user_spamprob=spam, user_colorblind=cblind,
        user_monitor=np.array(monitor, dtype=str),
    )
    (out.parent / "parse_stats.json").write_text(json.dumps(stats, indent=1))
    print(f"wrote {out} in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
