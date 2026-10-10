# colorcube asset contract

The Python pipeline (`pipeline/`) produces static assets in `web/public/assets/`;
the web app (`web/`, Vite + TypeScript + three.js) consumes them. This file is the
single source of truth for that interface. Change it only in lockstep on both sides.

All toolchain runs through `nix develop -c <cmd>` (flake at repo root).

## Coordinate conventions

- Voxel grid is 256³, one voxel per 8-bit RGB triple. Voxel `(r,g,b)` covers the
  cube `[r, r+1) × [g, g+1) × [b, b+1)` in "grid units"; its centre is `r+0.5` etc.
- World/mesh space is grid units in `[0, 256]` on each axis: x = R, y = G, z = B.
  The colour of a point `p` in mesh space is `sRGB(p / 256)` (clamped).
- Flat index into volumes: `i = r + 256*g + 65536*b` (R fastest). This matches a
  WebGL2 `TEXTURE_3D` upload with width=R, height=G, depth=B.

## Detail levels

`web/public/assets/levels.json`:

```json
{ "default": "standard",
  "levels": [ { "id": "basic", "title": "Basic (11 terms)", "description": "..." },
              { "id": "standard", "title": "...", "description": "..." },
              { "id": "detailed", "title": "...", "description": "..." } ] }
```

Each level has a directory `web/public/assets/<id>/` containing the three files below.

## `<id>/meta.json`

```jsonc
{
  "level": "standard",
  "resolution": 256,
  "source": { "answers": 3400000, "users": 150000, "sigma": 8.0, "notes": "..." },
  "names": [                     // index in this array == label value in labels volume
    { "name": "green",
      "voxels": 3123456,          // voxel count in the cleaned label volume
      "fraction": 0.186,          // voxels / 256^3
      "answers": 300000,          // raw (normalised-name) answer count in survey
      "meanColor": [r, g, b],     // mean sRGB 0-255 of the voxels with this label
      "centroid": [x, y, z]       // grid units, mean voxel centre
    }
  ],
  "components": [                // connected regions (6-connectivity) of one label
    { "nameIndex": 0,
      "voxels": 3000000,
      "centroid": [x, y, z],      // grid units
      "bboxMin": [x, y, z], "bboxMax": [x, y, z],
      "firstVertex": 0, "vertexCount": 12345,   // into meshes.bin vertex arrays
      "firstIndex": 0,  "indexCount": 67890      // into meshes.bin index array
    }
  ],
  "mesh": {
    "file": "meshes.bin",
    "vertexCount": 1000000, "indexCount": 6000000,
    "positionsByteOffset": 0,     // Uint16 x3 per vertex; grid = q * 256 / 65535
    "normalsByteOffset": 6000000, // Int8 x4 per vertex (nx,ny,nz,0), unit * 127, outward
    "indicesByteOffset": 10000000 // Uint32 per index, RELATIVE to component.firstVertex
  }
}
```

- `mesh.file` (always `meshes.bin` today) may be **gzip-compressed**: if its first two bytes are
  the gzip magic `1f 8b`, decompress it first; the offsets above refer to the decompressed bytes.
  The pipeline gzips it (level 9, mtime 0); like `labels.lbl` the name deliberately has no `.gz`,
  so servers don't add `Content-Encoding`. Clients must also accept an uncompressed file.
- `components` is sorted by `voxels` descending. Tiny components (below a pipeline
  threshold) are merged into neighbouring labels *in the label volume as well*, so
  every remaining voxel belongs to a listed component and meshes agree with volume.
- Every byte offset is a multiple of 4. All binary data is little-endian.
- Triangle winding is counter-clockwise viewed from outside (front face = outward).
- Meshes of adjacent labels share (approximately) the same boundary surface, and
  every component mesh is closed (capped at the cube faces).

### Additive extensions (pipeline, all optional for the client)

- `source.candidates` — number of candidate names that competed at this level
  (`names` lists only those that won somewhere after cleaning).
- `source.minComponentVoxels` — components smaller than this were relabelled.
- `source.meshError` — absolute simplification error bound, in grid units.
- `components[].anchor` — `[x, y, z]` grid units: the interior voxel centre farthest
  from the component's boundary (cube faces count as boundary). Unlike `centroid`,
  it is always inside the component, so it is a good 3D label position.
- `components[].anchorDepth` — that distance in voxels (≈ inscribed radius; useful
  for sizing a 3D label).

## `<id>/labels.lbl`

gzip-compressed raw `Uint8Array` of length 256³ = 16,777,216, flat index as above,
value = index into `names`. The extension is deliberately not `.gz` so dev/static
servers don't add `Content-Encoding`; the client decompresses with
`new Response(blob.stream().pipeThrough(new DecompressionStream('gzip')))`.

## Notes for the client

- The label volume is what slices sample (3D texture, `R8UI`, nearest fetches with
  the client doing its own smooth majority interpolation for soft borders).
- Mesh colour should be derived from position in the shader (no colour attribute).
- The client uses `components[].anchor` (when present) as the fallback 3D label position; normally it
  places labels on the visible part of each blob from a screen-space id render.
- Neighbouring meshes are simplified independently (gaps/overlaps of ~0.2 voxel, slivers just under
  cube faces); the client hides these while the cube is assembled (see `web/README.md`).
- Colours must display as the true sRGB value of the position (watch three.js
  colour management: either feed linear values and let output convert, or bypass).
