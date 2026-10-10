# colorcube data pipeline

Turns the raw xkcd colour-survey SQL dump into the static assets the web app loads
(`web/public/assets/`, format in [`docs/CONTRACT.md`](../docs/CONTRACT.md)).

```sh
pipeline/build.sh          # re-execs itself inside `nix develop`; ~90 s on an M-series Mac
```

It needs xkcd's [`colorsurvey.tar.gz`](https://xkcd.com/color/colorsurvey.tar.gz) in the repo root
(git-ignored); the first run extracts `data/mainsurvey_sqldump.txt` from it. The script re-execs
itself in this flake's dev shell unless `COLORCUBE_DEVSHELL` is set (any other nix shell is not
enough), and reinstalls the meshoptimizer npm package when `package-lock.json` changes.

| step | script | output |
|---|---|---|
| 1 parse | `parse.py` | `build/answers.npz`, `build/parse_stats.json` |
| 2 calibrate | `calibrate.py` | `build/calibration.json` (sigma sweep vs `satfaces.txt`) |
| 3 labels | `labels.py` | `build/<level>/topv.npy, topi.npy, candidates.json` |
| 4 clean | `clean.py` | `build/<level>/labels.npy, comp.npy, effv.npy, effi.npy, clean.json` |
| 5 meshes | `meshes.py` + `simplify.mjs` | `build/<level>/mesh.npz, mesh_report.json` |
| 6 export | `export.py` | `web/public/assets/levels.json`, `<level>/{meta.json,meshes.bin,labels.lbl}` |
| 7 validate | `validate.py` | `build/validation/report.json`, `faces_<level>.png`, `slice_<level>_<axis>128.png` |

Every step reads only the outputs of earlier steps, so you can re-run any step on its own
(e.g. `nix develop -c python3 pipeline/meshes.py --levels detailed --target-error 0.05`).
Volumes are numpy arrays indexed `[b, g, r]`, so `.ravel()` gives the contract's flat order
`r + 256 g + 65536 b`.

## 1. Parsing and filtering

* The dump is streamed line by line with regexes (no SQLite needed): 152,401 users and 3,408,036 answers.
* **Spam threshold `spamprob <= 0.5`.** Quantiles of spamprob: median 0.031, p75 0.090,
  p90 0.25, p95 1.0. Values of exactly 1.0 are users who gave no answers, and values above 1
  are almost all abusive or junk. I looked at samples from each bin: users in 0.1–0.5 are
  overwhelmingly real. Their spamprob is higher mainly because they answered more questions,
  so they also gave more unusual names. Agreement of the standard level with `satfaces.txt`
  at sigma 8 for each threshold:

  | threshold | answers kept | agreement |
  |---|---|---|
  | 0.10 | 2.19 M | 0.800 |
  | 0.25 | 2.97 M | 0.849 |
  | **0.50** | **3.10 M** | **0.854** |
  | 1.00 | 3.14 M | 0.854 |

  0.5 drops the obvious spam (12,656 users, 156 k answers) and loses no agreement.
* **Colour-blind users excluded** (self-reported `colorblind=1`: 5,588 users, 118 k answers).
  Agreement 0.8540 without them against 0.8529 with them. The gain is small, but the
  exclusion is also the methodologically clean choice.
* **Name normalisation:** lowercase, trim, `-`, `_`, `/` and `\` become spaces ("blue/green" →
  "blue green"), double quotes and backticks removed, trailing `.!?,;:` and leading/trailing
  apostrophes stripped, whitespace collapsed. Then, word by word: `grey→gray` (also greyish),
  `blueish→bluish`, `purpleish→purplish`, `redish→reddish`, plus a small table of common
  misspellings (fuschia/fushia/fuscia/fucsia→fuchsia, burgandy→burgundy, forrest→forest,
  lavendar→lavender, turqoise→turquoise, …), and two phrase folds: "sea foam"→"seafoam",
  "robins egg"/"robin egg"→"robin's egg". A trailing word "color" and a leading "a/an/the" are
  dropped. Suffixes like "-ish" are **not** removed ("bluish green" is not "green").
* **Junk names dropped:** anything that does not match `[a-z][a-z' ]*[a-z]` after
  normalisation (digits, symbols, non-ASCII, single letters), or is longer than 40 characters.
  That is 23 k answers.
* **Result:** 3,110,453 answers from 134,597 users, with 100,504 distinct names (179 with ≥1500 answers).

## 2. Densities and labels

For each candidate name its answers are histogrammed into the 256³ grid and blurred with an
isotropic Gaussian (`scipy.ndimage.gaussian_filter`, `mode='constant'`, truncate 4σ). This is a
kernel density estimate in "answers per voxel". The label of a voxel is the argmax over the
level's candidates, so it is the **most popular name for that colour** (counts are not normalised
per name). We never hold all densities at once. Each worker keeps a running per-voxel
**top-4** of `(log(d+1e-5), candidate)`, and the workers' lists are merged at the end. Four is
enough to get the argmax, the runner-up for cleaning, and the margin field for meshing, because
a label's boundary only occurs where it is in the top two or three. The lists are kept in a total
order (value descending, then candidate index), so the result does not depend on how candidates
are split across workers (`--jobs`); `labels.py` self-tests the insertion on startup, and
`validate.py` re-checks slots 0–1 against exact densities at random voxels.

### Sigma (chosen by agreement with `satfaces.txt`)

On a cube face the 3D KDE equals a 2D blur of a 2D histogram whose samples are weighted by
`exp(-d²/2σ²)`, where d is the distance from the face. The sweep is therefore exact and takes
seconds. Agreement with xkcd's 196,608 face labels (r=0, g=0, b=0):

| candidate set | σ=3 | 4 | 5 | 6 | 7 | 8 | 10 | 12 | 16 |
|---|---|---|---|---|---|---|---|---|---|
| **standard** (top-36 + black, white) | .844 | .849 | .849 | .850 | **.850** | .849 | .847 | .844 | .836 |
| **detailed** (179 names ≥1500) | .833 | .840 | **.841** | .841 | .842 | .842 | .840 | .837 | .831 |
| top-20 | .837 | .842 | .842 | .843 | .843 | .843 | .841 | .839 | .831 |
| top-36 | .846 | .852 | .853 | .854 | .854 | .854 | .853 | .850 | .844 |
| xkcd's own 27 names | .839 | .844 | .844 | .844 | .843 | .842 | .840 | .837 | .831 |

The optimum is broad (σ 5–8). Choices:

* **basic & standard: σ = 7**, the agreement maximum. Satfaces' vocabulary can't score basic terms directly.
* **detailed: σ = 5**, the smallest σ within 0.001 of that level's optimum. The detailed level
  favours resolution, and σ=5 lets 50 rather than 39 candidates win somewhere before cleaning.

`satfaces.txt` comes from a *different* survey (a face-only follow-up), so ~85% is probably close
to the ceiling. Most disagreement is boundary placement between neighbouring names
(`build/validation/faces_*.png`). The largest confusions (xkcd → ours, pixels, standard):
pink→magenta 3116 (our magenta extends further toward the magenta corner), blue→dark blue 2000,
light blue→blue 1925 (xkcd has a light-blue patch on the r=0 face that our data gives to
cyan/blue), pink→purple 1768, teal→green 1767, green→dark green 1631, red→maroon 1466.
A perceptual space (CIELAB KDE) was not tried. sRGB is already roughly perceptually spaced,
the agreement curve is flat, and the separable-grid trick would be lost.

### Levels

| level | candidates | σ | names after cleaning | components |
|---|---|---|---|---|
| basic | 11 Berlin–Kay terms. **Every answer whose last word is a basic term counts for it** ("dark green", "bluish green", "lime green" → green), which is far more data than the bare words | 7 | 11 | 11 |
| standard | 36 most frequent names + black + white (38) | 7 | 28 | 28 |
| detailed | all 179 names with ≥1500 answers | 5 | 39 | 41 |

* Black is name #40, so plain top-N would leave the black corner to "dark green/dark blue".
  Forcing the basic terms into standard costs ~0.4 pt of satfaces agreement, because xkcd's
  black region is smaller than ours.
* Basic agrees with xkcd on 94.1% of the face pixels where xkcd's name has a basic head word
  (91% of pixels), and 81.2% overall.
* Names (by volume share):
  * basic: green 28%, blue 23%, purple 17%, pink 10%, brown, red, orange, yellow, gray, black, white.
  * standard adds: teal, light blue, tan, lavender, cyan, light green, maroon, magenta, dark green,
    dark blue, salmon, beige, olive, lime green, mauve, dark purple, turquoise.
  * detailed adds: peach, mustard, navy blue, yellow green, light pink, dark gray, off white,
    cream, periwinkle, burnt orange, dark teal.
* The levels differ less than the candidate counts suggest. Generic names are so dominant
  (green, blue and purple together cover 50% of the cube) that only ~40 of the 179 names are
  ever the *most* popular.

## 3. Cleaning

The 6-connected components of the argmax volume are computed with `skimage.measure.label`,
one pass over all labels. **Components smaller than 1000 voxels (≈10³) are removed**:

1. Their label is *suppressed* in those voxels, so each voxel falls back to its **runner-up
   name**: the next most popular name for that exact colour. This is more principled than "most
   common neighbour" and it splits a pocket along the natural density boundary. Repeat until
   stable.
2. If a voxel's tracked candidates are exhausted, merge into the most common neighbouring label.
   This fallback is not needed by the current levels (0 merges); forced voxels get a finite
   density (the best remaining candidate, or the density floor `log(1e-5)`), so the margin field
   stays finite if it ever is.

What it changes:

* basic: 1 tiny component, 2 voxels.
* standard: 32 components, 1,618 voxels (0.01%).
* detailed: 154 components, 12,112 voxels (0.07%), almost all < 100 voxels.

Raw component size histograms are in `build/<level>/clean.json`. The suppression is also
applied to the candidate lists used for meshing, so meshes agree with the cleaned volume.

## 4. Meshes

* **Field.** For a component of label L:
  `f_L = log d_L − max_{k≠L} log d_k`, taken from the cleaned candidate lists. Its sign at every
  voxel centre is exactly "cleaned label == L". Between voxel centres it is the smooth density
  ratio, so isosurfaces get sub-voxel, naturally smooth borders. These are the "smooth borders"
  of the 2D map, without any blur of the labels.
* On a two-label interface f_A = −f_B, so neighbouring meshes share the same surface. Near
  triple junctions they agree only approximately. This needs each label to be in its neighbour's
  candidate list: `validate.py` checks that at every pair of 6-neighbour voxels with different
  labels (0 / 0.001 / 0.02% misses for basic / standard / detailed, limit 1%). Other components of
  the same label in the crop are forced negative.
* Exact float ties are resolved toward the cleaned label.
* **Closing.** The crop is padded by one layer set to `−|f|` of the adjacent voxel. This puts
  the cap exactly on the cube face (0 or 256) and closes every mesh.
* **Marching cubes:** skimage Lewiner. Vertex = padded index − 1 + 0.5 + crop offset, so voxel
  centres sit at index + 0.5. Axes are reordered from `[b,g,r]` to x=R, y=G, z=B.
* **Orientation.** The winding is flipped if the signed volume is negative. Normals come from
  the field gradient and are oriented to agree with the geometric outward normal.
* **Simplification:** meshoptimizer (`simplify.mjs`, npm `meshoptimizer@1.3`) with an
  **absolute error of 0.1 voxel** (`--target-error`). Because the surfaces are smooth, error 0.1
  still cuts the triangle count 15–50×.
* **Manifold repair.** The simplifier occasionally pinches the thin wedges where a region meets
  a cube face at a shallow angle into non-manifold edges. Such vertices and a few rings around
  them are locked, and the component is simplified again. Per level this happened 5 / 8 / 12
  times, locking 241 / 246 / 526 vertices. The validator confirms every mesh is a closed
  2-manifold (each directed edge appears once, together with its reverse).
* **Accuracy:** mesh volume against voxel count: median per component 0.02 / 0.09 / 0.20%
  (basic / standard / detailed), voxel-weighted mean ≤ 0.05%, max 3.4% (small components).
  `validate.py` requires median < 0.5%, weighted mean < 1% and every component < 5%.

| level | MC triangles | final triangles | vertices | meshes.bin (gzip) | labels.lbl | meta.json | total |
|---|---|---|---|---|---|---|---|
| basic | 2.26 M | 44,332 | 22,184 | 0.34 MB | 0.19 MB | 7 KB | **0.54 MB** |
| standard | 2.94 M | 99,622 | 49,859 | 0.78 MB | 0.26 MB | 17 KB | **1.06 MB** |
| detailed | 3.29 M | 257,158 | 128,601 | 2.02 MB | 0.30 MB | 24 KB | **2.34 MB** |

There is plenty of headroom: `--target-error 0.04` gives ~4× the triangles if more silhouette
precision is ever wanted.

## 5–7. Export and validation

* `labels.lbl` is the gzip (level 9, mtime 0) of the cleaned uint8 volume. `meshes.bin` is the
  gzip of the contract's binary layout (the name has no `.gz`, so servers don't add
  `Content-Encoding`; the client detects the gzip magic). Many static hosts don't compress
  `application/octet-stream`, and the mesh buffer is most of the download.
* `meta.json` follows the contract, with these additive extensions (documented in the contract):
  * `source.candidates`, `source.minComponentVoxels`, `source.meshError`
  * `components[].anchor` / `anchorDepth`: the interior point farthest from the component
    boundary, and its depth. Use it to place a 3D label, since the centroid of a curved region
    can lie outside it.
* `validate.py` asserts:
  * every contract invariant: offsets % 4, buffer sizes, index ranges, contiguous component
    ranges, names/components voxel stats against the decompressed volume
  * components recomputed from `labels.lbl` match `meta.json` and are sorted
  * closed meshes, positive signed volume (CCW outward), normals agreeing with the winding,
    positions in [0,256], mesh volume accuracy (per component and aggregate)
  * from `build/<level>/`: neighbouring labels are in each other's candidate lists (shared
    boundaries, see §4), and the top-K lists match exact Gaussian sums at 400 random voxels
    (`--no-candidates` skips these)
* It then scores each level against `satfaces.txt` and writes the comparison PNGs: ours | xkcd |
  disagreement, laid out like `satfaces_map_huge.png`, plus labelled slices r/g/b = 128.

## Known weaknesses

* Agreement with xkcd's face map is ~85%. The remaining differences are systematic differences
  between the two surveys and boundary placement in low-margin areas, mainly pink/magenta,
  light blue, and the dark centre.
* Meshes of adjacent regions are simplified independently. They may separate or overlap by up
  to ~0.2 voxel (2 × error), and a bit more near triple junctions. This can't be seen at
  normal zoom.
* Answers are not weighted by user. Heavy contributors count more.
* The dark corner (black / dark green / dark blue / navy) has low margins, so its boundaries
  depend most on σ.
