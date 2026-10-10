# colorcube

An interactive, explorable **exploded RGB cube** of color names, built from the
[xkcd color survey](https://blog.xkcd.com/2010/05/03/color-survey-results/) (Randall Munroe, 2010).

Every point of the 256³ RGB cube gets the name people most often gave to that color. Each
connected region with the same name is a blob. You can pull the cube apart to see the blobs in
3D, and drag a slice plane through it to get a labelled 2D map in the style of xkcd's
*fully saturated color map* (`satfaces_map_huge.png`).

- **3D:** one mesh per region, colored by position in the shader, so every surface point shows its true sRGB color. You can explode the cube, hover a blob for its name and color, click to solo a name, and toggle names in the legend.
- **Slices:** R, G, B, Grey (constant R+G+B, across the gray diagonal), Hues (a plane containing the gray diagonal, rotated around it by hue: one hue and its complement, black to white) or any free orientation. You can drag the plane in 3D or use the slider and keys. Blobs can be cut at the plane, and cut blobs get solid true-color caps.
- **2D map:** sampled from the 256³ label volume, with smooth borders, thin white region outlines and hand-lettered labels sized to each region (placed by a web worker). It supports zoom, pan and hover, and exports a 2400 px PNG.
- **Detail levels:** *basic* (11 basic color terms), *standard* (the top 36 names plus black and white, 28 of which win somewhere) and *detailed* (every name given at least 1,500 times, 179 candidates of which 39 win somewhere).

## Running the app

All tooling comes from the nix flake. Run these from the repo root:

```sh
nix develop -c npm --prefix web ci                  # once
nix develop -c npm --prefix web run setup:browsers  # once, before the first test: Playwright's Chromium
nix develop -c npm --prefix web run dev             # http://localhost:5173/
nix develop -c npm --prefix web run build           # typecheck + production build -> web/dist/ (static files)
nix develop -c npm --prefix web test                # build + Playwright smoke test (true-color readback etc.)
```

`web/dist/` is a self-contained static site, so any static file server can host it. See
[`web/README.md`](web/README.md) for features, keyboard shortcuts, implementation notes and
the test and screenshot scripts.

## Rebuilding the data

The processed assets are in `web/public/assets/` and are described in
[`docs/CONTRACT.md`](docs/CONTRACT.md). To rebuild them from the raw survey dump, put xkcd's
[`colorsurvey.tar.gz`](https://xkcd.com/color/colorsurvey.tar.gz) (88 MB, git-ignored) in the repo root and run:

```sh
pipeline/build.sh        # re-execs itself inside `nix develop`; ~90 s on an M-series Mac
```

The first run extracts `data/mainsurvey_sqldump.txt` from the tarball.

The pipeline parses and filters the answers: it drops spam and self-reported color-blind users and
normalises names. It then builds a Gaussian density per candidate name over the 256³ grid, with
σ calibrated against xkcd's published `satfaces.txt` (about 85% agreement on the three faces).
Each voxel is labelled with the most popular name, and regions under 1,000 voxels are relabelled.
Marching cubes then runs on the "this name vs the strongest competitor" margin, so borders are
smooth, and the meshes are simplified with meshoptimizer (≤0.1 voxel error). Validation images go
to `build/validation/`. See [`pipeline/README.md`](pipeline/README.md) for the details and the
calibration numbers.

## Layout

| Path | What |
| --- | --- |
| `flake.nix` | dev shell: python3 (numpy, scipy, scikit-image, pillow), nodejs 24 |
| `pipeline/` | data pipeline (Python + a meshoptimizer step in Node) |
| `docs/CONTRACT.md` | asset format shared by the pipeline and the web app |
| `web/` | the web app (Vite, TypeScript, three.js / WebGL2) |
| `web/public/assets/` | generated assets: `levels.json`, `<level>/{meta.json, meshes.bin, labels.lbl}` |
| `build/` | pipeline intermediates, validation images, screenshots (`build/screens/final-*.png`) |

## Credits

- **Data:** the xkcd color survey by Randall Munroe (2010): about 3.4 million color names given
  by about 150,000 visitors for random RGB colors. See the
  [results post](https://blog.xkcd.com/2010/05/03/color-survey-results/). The 2D-map style follows
  xkcd's fully saturated color map.
- **Label font:** *xkcd Script* (npm `xkcd-font`, CC BY-NC 3.0, so non-commercial use only), with
  *Patrick Hand* (OFL) as a fallback.
- **Libraries:** three.js, meshoptimizer, Vite, NumPy, SciPy, scikit-image.
