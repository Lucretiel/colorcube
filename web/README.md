# colorcube web app

An explorable, exploded RGB cube of the most popular color names from the
[xkcd color survey](https://blog.xkcd.com/2010/05/03/color-survey-results/) (Randall Munroe, 2010),
with draggable slice planes that produce labelled 2D maps in the style of xkcd's
"fully saturated color map". Vite + TypeScript + three.js (WebGL2).

The app reads the static assets described in [`docs/CONTRACT.md`](../docs/CONTRACT.md) from
`public/assets/` (written by the Python pipeline in `pipeline/`).

## Running

All tooling comes from the repo's nix flake. From the repo root:

```sh
nix develop -c npm --prefix web ci                # once (exact versions from package-lock.json)
nix develop -c npm --prefix web run setup:browsers  # once, for the tests: Playwright's headless Chromium
nix develop -c npm --prefix web run dev           # dev server, http://localhost:5173/
nix develop -c npm --prefix web run build         # typecheck (tsc) + production build into web/dist/
nix develop -c npm --prefix web run preview       # serve web/dist/
```

URL parameters:

- `?assets=fake-assets` – load the fake assets instead of `assets/` (see below).
- `?level=detailed` – start on a given detail level (otherwise the last used one, then `levels.json` default).

`npm run build` leaves `public/fake-assets/` (~56 MB of test data) out of `dist/`; `npm test` builds with
`CC_FAKE=1` so the smoke test can use them.

### Fake assets

`web/scripts/make-fake-assets.mjs` generates contract-conformant fake data into `public/fake-assets/`
(nearest-of-N anchor colors, connected components, Taubin-smoothed voxel surfaces, gzip label volume),
including a `dense` level with ~2.5M triangles for performance testing:

```sh
nix develop -c npm --prefix web run fake-assets   # ~8 s
```

### Smoke test

```sh
nix develop -c npm --prefix web test             # build (CC_FAKE=1 keeps fake assets in dist), then scripts/smoke.mjs against `vite preview`
nix develop -c node web/scripts/smoke.mjs --dev  # against the dev server (no build)
#   --only=fake|real   --bench (frame-rate benchmark per level)   --headed
```

It opens the app with the fake assets (if generated) and the real ones (if `public/assets/levels.json`
exists), fails on console errors, checks true color by pixel readback (blob surfaces, the 3D slice plane
and the 2D map, each within ±1 of `round(p/256·255)`), exercises explode, hover/solo, every slice
orientation, dragging the plane in 3D, 2D labels + hover, PNG export and level switching,
and writes screenshots to `build/screens/`.

### Screenshots

`scripts/shot.mjs` drives a running dev server with a small steps file; `scripts/final-screens.mjs`
is the set used for `build/screens/final-*.png`:

```sh
nix develop -c npm --prefix web run dev -- --port 5288 &
nix develop -c node web/scripts/shot.mjs web/scripts/final-screens.mjs   # [--scheme=light] [--q=assets=fake-assets]
```

## Features

- **3D view** – one mesh per connected component (region of the cube with the same most popular name).
  Color comes from position in the shader, so every surface point shows its own true sRGB color.
  Gentle optional shading (hemisphere + rim, applied in linear light) so shapes read in 3D.
- **Explode** – components move apart along `(centroid − 128)·k` with a smooth animation; the camera
  dollies out to keep the cube framed. Hand-lettered labels for the large components follow them,
  scale with distance and de-clutter (greedy, larger blobs first; a second blob of the same name right
  next to a labelled one stays unlabelled). The R/G/B axis letters move out with the explode.
- **Hover / solo** – hover a blob for its name, share of the cube and the color under the cursor
  (hex + RGB). Click a blob, a region of the slice or a legend row to solo that name (click again to
  show all); Shift-click hides/shows a name.
- **Legend** – every name with its mean color, % of the cube, a size bar, visibility toggle and filter box.
- **Detail levels** from `levels.json`, loaded lazily; GPU resources of the previous level are disposed.
- **Slices** – R, G, B, gray-diagonal (constant R+G+B) and free orientation (azimuth/elevation).
  Drag the plane itself or its arrow handle in the 3D view, or use the sliders / arrow keys.
  The plane shows the labelled cross-section sampled from the 256³ label volume (R8UI 3D texture) with
  smooth borders. Blobs can be cut on one side of the plane – the cut happens in unexploded RGB space,
  so in exploded mode every blob is cut at the same plane and moved apart, and cut blobs get
  true-color caps so they look solid.
- **2D map panel** – the current slice as a satmap-style map (true colors, thin white borders,
  white UPPERCASE hand-lettered labels sized to their regions; dark letters on light regions near the
  white corner), axis annotations (when zoomed in, the visible range at the axis ends), hover readout,
  wheel zoom / drag pan / double-click reset (when zoomed in, the visible part is relabelled at a finer
  raster so small regions get labels too), resizable, PNG download (2400 px, white background, black
  frame, like the original). The map is oriented as the cut face is seen in 3D (from the side the cut
  removes), so it is never mirrored relative to the 3D view; *Flip side* flips both.
- Dark and light themes (follows the OS), collapsible panels, works on narrow screens.

### Keyboard

| Key | Action |
| --- | --- |
| drag / right-drag / wheel | orbit / pan / zoom |
| `E`, `[`, `]` | explode toggle, less, more |
| `1` `2` `3` `4` `5` | slice orientation R, G, B, Gray, Free |
| `↑` `↓` (`Shift` ×10) | move the slice; `←` `→` rotate a free slice |
| `V` / `C` / `F` | slice in 3D / cut blobs / flip the cut side |
| `D` | download the 2D map as PNG |
| `S` / `L` / `A` / `R` | shading / labels / spin / reset camera |
| `P` / `M` | side panel / slice map |
| `/` | filter names |
| `Esc` | show all names |
| `?` | help overlay |

## How it works

| File | Role |
| --- | --- |
| `src/main.ts` | boot: levels, default level, `window.__cc` test hook |
| `src/data.ts` | contract types, abortable parallel loading with progress, gzip mesh buffer + label volume, CPU majority lookup |
| `src/app.ts` | renderer, scene, state, GPU picking, plane dragging, frame loop (render on demand) |
| `src/blobs.ts` | per-component meshes over shared typed-array views, explode, clip/pick materials |
| `src/shaders.ts` | all GLSL: blobs (true color, shading, clip + caps), slice (smooth majority + AA borders) |
| `src/slice.ts` | slice plane state, plane/cube polygon, map ↔ RGB mapping |
| `src/map2d.ts` | 2D map: cached render target blitted into the main canvas + Canvas2D overlay, PNG export |
| `src/labeler.ts`, `src/labelWorker.ts` | 2D label placement in a web worker |
| `src/labels3d.ts` | floating DOM labels for exploded blobs |
| `src/ui.ts` | side panel, legend, map panel, keyboard |

**True color.** All materials are `ShaderMaterial`s that do *not* include three's color-space or
tone-mapping chunks, so the value written is what lands in the (sRGB) canvas: `rgb = grid / 256`.
With shading off, a pixel readback of a blob surface equals `round(p/256·255)` of the picked
position up to rounding (the smoke test checks 40 interior pixels per run; max channel error ≤ 1, it fails
above 2). Shading multiplies
in linear light and converts back.

**Soft borders.** The slice shader takes the 8 voxels around the sample point, sums trilinear weights
per label and picks the label with the largest weight (a smooth majority vote that removes the
voxel staircase); the default "Smooth" mode additionally averages a 3×3 in-plane tent of such samples.
The margin between the best and second-best label (zero exactly on the border) and its analytic
gradient give the distance to the border in screen pixels, so the white borders are a constant
~1.5 px wide and antialiased at any zoom or angle.

**Seamless cube faces.** The blob meshes are simplified independently, so where two regions meet on
a cube face there are hairline gaps and slivers just under the face. While the cube is assembled
(no explode, nothing hidden) blob fragments within 1 voxel under a face are discarded and a backing
box on the cube faces (pushed back 0.8 units along the view ray) fills in with the face's own color
and shading; the blob varyings use `centroid` interpolation so MSAA edge pixels don't extrapolate.

**Caps on cut blobs.** With clipping on, blobs are drawn double-sided; a back face seen through the
cut is shaded with the color of the point where the view ray meets the cut plane (in unexploded
space) and writes that point's depth. It is accepted only if that point lies inside the blob's
cross-section according to the label volume; otherwise it is drawn as an ordinary back face (with its
own depth), which also hides hairline gaps between neighbouring meshes.

**2D labels.** The worker rasterises the slice's label image (~420 px on the long side) with the same
smooth majority rule, finds 4-connected regions, computes an exact Euclidean distance transform to
the region borders, and takes each region's pole of inaccessibility (max distance). For one- and
two-line layouts, horizontal or along the region's principal axis when it is an elongated diagonal
band, and a few candidate centres along that axis, it binary-searches the largest font size whose
rotated text box fits inside the region, and keeps the best (horizontal / one line preferred).
Labelling a slice takes ~10 ms (median; max ~30 ms) off the main thread; while dragging, only the
newest request is processed (full-slice and zoomed-view requests are queued separately).

**Picking** renders the scene into a 1×1 float target (`setViewOffset`) with pick materials that apply
the same clipping/explode/sliver discard as the visible ones, returning the component id and the exact
RGB point under the cursor. The slice plane, the drag handle and the backing box (cube faces showing
through hairline gaps) have their own ids; plane and face hits are named by the CPU majority lookup.
While the plane is faded out (exploded view) it is only a ghost: blobs and the handle are picked first,
and the plane only where nothing else is under the cursor. Hover is re-picked (throttled) when the view
moves under a still cursor. When the view is nearly perpendicular to the plane, dragging it maps vertical
pointer motion to the offset instead of the ray/normal construction, whose gain diverges there.

**Performance** (Apple M4 Max, Chrome/Metal, 1600×1000, real assets): 60 fps (vsync-capped) on every
level, collapsed and exploded (detailed: 257k triangles, ~60 draw calls, ~0.5–0.7 ms CPU per frame), and
also for the 2.5M-triangle fake `dense` level. Sweeping a slice one step per frame keeps 60 fps; 2D labels
arrive ~17 ms (median) after a slice change. A level loads in ~20–30 ms from a local server
(gzip mesh buffers 0.34 / 0.78 / 2.0 MB, label volumes 0.2–0.3 MB; levels.json is requested before
WebGL init and labels.lbl in parallel with meta.json). Frames are only rendered when something changes,
and the 2D map (the most expensive shader) is re-rendered only when its content changes: orbiting or
exploding the 3D view just copies the cached map.

## Credits

- Data: xkcd color survey, Randall Munroe (2010).
- Label font: *xkcd Script* (`xkcd-font` npm package, derived from Randall Munroe's handwriting;
  CC BY-NC 3.0), with *Patrick Hand* (OFL) as fallback.
