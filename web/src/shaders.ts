// GLSL (WebGL2 / GLSL ES 3.00) sources. All materials are THREE.ShaderMaterial with glslVersion GLSL3.
//
// TRUE COLOR: none of these shaders include three's <colorspace_fragment> / <tonemapping_fragment>,
// so what we write to gl_FragColor lands in the (sRGB) canvas unchanged. The colour of a grid point
// p is simply p/256, written as-is. Optional shading is done in linear light and converted back.

const COMMON = /* glsl */ `
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`;

// ---------------------------------------------------------------- blobs

// A back face seen through the cut is only a valid cap if the cut point q lies inside this blob's
// cross-section; otherwise (e.g. a back face behind the blob's own front face) it must not write the
// plane depth. Checked against the label volume with ~1.5 voxel tolerance (mesh vs voxel mismatch).
const CAP_CHECK = /* glsl */ `
bool capInside(vec3 q) {
  uint want = uint(uNameIndex + 0.5);
  ivec3 c = ivec3(floor(q));
  if (texelFetch(uLabels, clamp(c, ivec3(0), ivec3(255)), 0).r == want) return true;
  for (int k = 0; k < 8; k++) {
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, k >> 2) * 4 - 2;
    if (texelFetch(uLabels, clamp(c + o, ivec3(0), ivec3(255)), 0).r == want) return true;
  }
  return false;
}
`;

export const blobVertex = /* glsl */ `
// centroid: with MSAA, edge pixels must not extrapolate the grid position outside the triangle
centroid out vec3 vGrid;
out vec3 vNormalV;
out vec3 vViewPos;
out vec3 vWorld;
void main() {
  vGrid = position * 256.0;              // normalised Uint16 positions -> grid units
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mv = viewMatrix * world;
  vViewPos = mv.xyz;
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

// Surfaces just under a cube face (where a region boundary meets the face at a shallow angle the
// simplified meshes leave slivers) would show as shaded hairlines; while the cube is assembled they are
// discarded and the backing box shows instead. Shared by the colour and pick passes so picks match.
const SLIVER_DISCARD = /* glsl */ `
  if (uAssembled > 0.5) {
    vec3 dm = min(vGrid, 256.0 - vGrid);
    float dFace = min(dm.x, min(dm.y, dm.z));
    if (dFace > 0.02 && dFace < 1.0) discard;
  }
`;

export const blobFragment = /* glsl */ `
precision highp float;
uniform float uShade;       // 0 = flat true colour, 1 = full gentle shading
uniform float uHighlight;   // per object (hover)
uniform vec4 uClip;         // plane: dot(grid - 128, n) = t ; xyz = n, w = t
uniform float uClipSide;    // +1: discard dot(...) - t > 0 ; -1: the opposite
uniform vec3 uOffset;       // explode offset of this object (world units)
uniform vec3 uRootOffset;   // world = grid + uRootOffset + uOffset
uniform mat4 projectionMatrix;
uniform highp usampler3D uLabels;
uniform float uNameIndex;
uniform float uAssembled;   // 1 while the cube is assembled and the backing box is drawn
centroid in vec3 vGrid;
in vec3 vNormalV;
in vec3 vViewPos;
in vec3 vWorld;
${COMMON}
${CAP_CHECK}
void main() {
  vec3 grid = vGrid;
  vec3 col;
${SLIVER_DISCARD}
#ifdef CLIP
  float sd = (dot(grid - 128.0, uClip.xyz) - uClip.w) * uClipSide;
  if (sd > 0.0) discard;
  if (!gl_FrontFacing) {
    // Back face seen through the cut: colour it with the point where the view ray meets the
    // cut plane (in unexploded grid space) -> the blob looks solid with a true-colour cap.
    // If the cut point is not inside this blob (e.g. a back face seen through a hairline gap between
    // independently simplified meshes) fall through and draw it as an ordinary back face instead.
    vec3 o = cameraPosition - uRootOffset - uOffset;
    vec3 d = (vWorld - uRootOffset - uOffset) - o;
    float denom = dot(d, uClip.xyz);
    float lam = abs(denom) < 1e-6 ? -1.0 : (uClip.w - dot(o - 128.0, uClip.xyz)) / denom;
    vec3 q = o + lam * d;
    if (lam >= 0.0 && all(greaterThanEqual(q, vec3(-0.5))) && all(lessThanEqual(q, vec3(256.5))) && capInside(q)) {
      col = clamp(q / 256.0, 0.0, 1.0);
      col = mix(col, vec3(1.0), 0.16 * uHighlight);
      vec4 clip = projectionMatrix * viewMatrix * vec4(q + uRootOffset + uOffset, 1.0);
      gl_FragDepth = clamp(0.5 * clip.z / clip.w + 0.5, 0.0, 1.0);
      gl_FragColor = vec4(col, 1.0);
      return;
    }
  }
  gl_FragDepth = gl_FragCoord.z;
#endif
  col = clamp(grid / 256.0, 0.0, 1.0);
  vec3 n = normalize(vNormalV);
  // On the cube's own faces use the exact axis normal (mesh normals there are often smoothed with the
  // interior surface, which shows up as faint terrain-like shading on what should be a flat face).
  vec3 an = vec3(grid.x < 0.02 ? -1.0 : grid.x > 255.98 ? 1.0 : 0.0,
                 grid.y < 0.02 ? -1.0 : grid.y > 255.98 ? 1.0 : 0.0,
                 grid.z < 0.02 ? -1.0 : grid.z > 255.98 ? 1.0 : 0.0);
  if (dot(an, an) > 0.5) n = normalize(mat3(viewMatrix) * an);
  else {
    // Just below a face (sliver triangles where a region boundary meets the face at a shallow angle):
    // blend towards the face normal so they don't show up as shaded hairlines along region borders.
    vec3 dlo = grid, dhi = 256.0 - grid;
    vec3 dm = min(dlo, dhi);
    float d = min(dm.x, min(dm.y, dm.z));
    vec3 ax = dm.x <= d ? vec3(dlo.x < dhi.x ? -1.0 : 1.0, 0.0, 0.0)
            : dm.y <= d ? vec3(0.0, dlo.y < dhi.y ? -1.0 : 1.0, 0.0)
                        : vec3(0.0, 0.0, dlo.z < dhi.z ? -1.0 : 1.0);
    vec3 axV = normalize(mat3(viewMatrix) * ax);
    float w = (1.0 - smoothstep(0.0, 2.0, d)) * smoothstep(0.15, 0.6, dot(gl_FrontFacing ? n : -n, axV));
    n = normalize(mix(n, gl_FrontFacing ? axV : -axV, w));
  }
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(-vViewPos);
  float ndl = dot(n, normalize(vec3(0.35, 0.75, 0.55)));
  float hemi = 0.5 + 0.5 * ndl;
  float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
  float shade = mix(1.0, (0.70 + 0.42 * hemi) * (1.0 - 0.35 * rim), uShade);
  vec3 lin = srgbToLinear(col) * shade;
  col = linearToSrgb(lin);
  col = mix(col, vec3(1.0), uHighlight * (0.14 + 0.55 * rim));
  gl_FragColor = vec4(col, 1.0);
}
`;

// Picking: writes (id, grid.xyz) into an RGBA32F target. id: component index + 1.
export const blobPickFragment = /* glsl */ `
precision highp float;
uniform float uPickId;
uniform vec4 uClip;
uniform float uClipSide;
uniform float uClipOn;
uniform vec3 uOffset;
uniform vec3 uRootOffset;
uniform mat4 projectionMatrix;
uniform highp usampler3D uLabels;
uniform float uNameIndex;
uniform float uAssembled;
centroid in vec3 vGrid;
in vec3 vNormalV;
in vec3 vViewPos;
in vec3 vWorld;
${CAP_CHECK}
void main() {
  vec3 grid = vGrid;
${SLIVER_DISCARD}
  if (uClipOn > 0.5) {
    float sd = (dot(grid - 128.0, uClip.xyz) - uClip.w) * uClipSide;
    if (sd > 0.0) discard;
    if (!gl_FrontFacing) {
      vec3 o = cameraPosition - uRootOffset - uOffset;
      vec3 d = (vWorld - uRootOffset - uOffset) - o;
      float denom = dot(d, uClip.xyz);
      float lam = abs(denom) < 1e-6 ? -1.0 : (uClip.w - dot(o - 128.0, uClip.xyz)) / denom;
      vec3 q = o + lam * d;
      if (lam >= 0.0 && all(greaterThanEqual(q, vec3(-0.5))) && all(lessThanEqual(q, vec3(256.5))) && capInside(q)) {
        vec4 clip = projectionMatrix * viewMatrix * vec4(q + uRootOffset + uOffset, 1.0);
        gl_FragDepth = clamp(0.5 * clip.z / clip.w + 0.5, 0.0, 1.0);
        gl_FragColor = vec4(uPickId, q);
        return;
      }
    }
  }
  gl_FragDepth = gl_FragCoord.z;
  gl_FragColor = vec4(uPickId, grid);
}
`;

// ---------------------------------------------------------------- slices

// 3D plane: position = where the quad is drawn (grid units, inside root group),
// aGrid = the RGB point sampled (the same point).
export const slice3DVertex = /* glsl */ `
in vec3 aGrid;
in vec3 aU;
in vec3 aV;
out vec3 vGrid;
out vec3 vU;
out vec3 vV;
void main() {
  vGrid = aGrid; vU = aU; vV = aV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// 2D map: position.xy are map units; uView maps them to clip space.
export const slice2DVertex = /* glsl */ `
in vec3 aGrid;
in vec3 aU;
in vec3 aV;
uniform vec4 uView; // clip = (xy - uView.xy) * uView.zw
out vec3 vGrid;
out vec3 vU;
out vec3 vV;
void main() {
  vGrid = aGrid; vU = aU; vV = aV;
  gl_Position = vec4((position.xy - uView.xy) * uView.zw, 0.0, 1.0);
}
`;

export const sliceFragment = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler3D;
uniform highp usampler3D uLabels;
uniform sampler2D uNameMask;   // 256x1: r = visible, g = highlighted
uniform float uBorderPx;       // white border width in device px
uniform float uBlur;           // in-plane smoothing radius (grid units); 0 = trilinear majority only
uniform float uOpacity;
uniform float uDimHidden;
uniform float uPick;           // > 0.5: write pick output instead of colour
uniform float uPickId;
in vec3 vGrid;
in vec3 vU;
in vec3 vV;

// Up to 8 distinct labels with summed trilinear weights and their gradients.
uint sl[8];
float sw[8];
vec3 sg[8];
int sn;

void addLabel(uint L, float w, vec3 g) {
  for (int i = 0; i < 8; i++) {
    if (i >= sn) break;
    if (sl[i] == L) { sw[i] += w; sg[i] += g; return; }
  }
  if (sn < 8) { sl[sn] = L; sw[sn] = w; sg[sn] = g; sn++; }
}

void accumulate(vec3 p, float weight) {
  vec3 q = p - 0.5;
  vec3 b = floor(q);
  vec3 f = q - b;
  ivec3 ib = ivec3(b);
  for (int k = 0; k < 8; k++) {
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, k >> 2);
    vec3 fo = vec3(o);
    vec3 a = mix(1.0 - f, f, fo);              // per-axis weights
    vec3 s = mix(vec3(-1.0), vec3(1.0), fo);   // d(weight)/d(f)
    float w = a.x * a.y * a.z;
    vec3 g = vec3(s.x * a.y * a.z, a.x * s.y * a.z, a.x * a.y * s.z);
    uint L = texelFetch(uLabels, clamp(ib + o, ivec3(0), ivec3(255)), 0).r;
    addLabel(L, w * weight, g * weight);
  }
}

void main() {
  vec3 p = vGrid;
  // derivatives first, in uniform control flow (they are undefined after a per-pixel discard / branch)
  vec3 dpx = dFdx(p), dpy = dFdy(p);
  if (any(lessThan(p, vec3(-0.01))) || any(greaterThan(p, vec3(256.01)))) discard;
  sn = 0;
  if (uBlur > 0.0) {
    // 3x3 in-plane tent kernel of trilinear samples
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      float w = (2.0 - abs(float(i))) * (2.0 - abs(float(j))) / 16.0;
      vec3 sp = clamp(p + (float(i) * vU + float(j) * vV) * uBlur, vec3(0.5), vec3(255.5));
      accumulate(sp, w);
    }
  } else {
    accumulate(p, 1.0);
  }
  int best = 0;
  for (int i = 1; i < 8; i++) { if (i >= sn) break; if (sw[i] > sw[best]) best = i; }
  int second = -1;
  for (int i = 0; i < 8; i++) {
    if (i >= sn) break;
    if (i != best && (second < 0 || sw[i] > sw[second])) second = i;
  }
  uint L = sl[best];
  if (uPick > 0.5) { gl_FragColor = vec4(uPickId, p); return; }

  vec4 mask = texelFetch(uNameMask, ivec2(int(L), 0), 0);
  vec3 col = clamp(p / 256.0, 0.0, 1.0);
  if (mask.r < 0.5) col = mix(col, vec3(0.5), 0.55 * uDimHidden);
  col = mix(col, vec3(1.0), 0.18 * mask.g);

  float border = 0.0;
  if (second >= 0) {
    // signed margin between the two best labels; zero on the smooth boundary
    float m = sw[best] - sw[second];
    vec3 gm = sg[best] - sg[second];
    vec2 sg2 = vec2(dot(gm, dpx), dot(gm, dpy));
    float distPx = m / max(length(sg2), 1e-6);
    float halfW = 0.5 * uBorderPx;
    border = 1.0 - smoothstep(halfW - 0.6, halfW + 0.6, distPx);
  }
  col = mix(col, vec3(1.0), border);
  gl_FragColor = vec4(col, uOpacity);
}
`;

export const flatPickFragment = /* glsl */ `
precision highp float;
uniform float uPickId;
void main() { gl_FragColor = vec4(uPickId, 0.0, 0.0, 0.0); }
`;
export const flatPickVertex = /* glsl */ `
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// Backing box just inside the cube faces, drawn only when the cube is assembled (no explode, nothing
// hidden). Neighbouring blob meshes are simplified independently, so where two regions meet on a cube
// face there can be hairline gaps; through them this box shows the face's own colour and shading
// instead of the darker interior walls.
export const backingVertex = /* glsl */ `
out vec3 vGrid;
out vec3 vViewPos;
void main() {
  vGrid = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  // Push the box back along the view ray: same screen footprint, but slightly deeper, so the blobs'
  // own (coplanar) faces always win the depth test. (Blob fragments just under a face are discarded
  // while the cube is assembled, see uAssembled.)
  mv.xyz += normalize(mv.xyz) * 0.8;
  gl_Position = projectionMatrix * mv;
}
`;
// Pick pass of the backing box: id plus the grid point snapped onto the cube face it shows.
export const backingPickFragment = /* glsl */ `
precision highp float;
uniform float uPickId;
uniform vec4 uClip;
uniform float uClipSide;
uniform float uClipOn;
in vec3 vGrid;
in vec3 vViewPos;
void main() {
  vec3 grid = vGrid;
  if (uClipOn > 0.5 && (dot(grid - 128.0, uClip.xyz) - uClip.w) * uClipSide > 0.0) discard;
  vec3 d = grid - 128.0, a = abs(d);
  vec3 an = a.x >= a.y && a.x >= a.z ? vec3(sign(d.x), 0.0, 0.0) : a.y >= a.z ? vec3(0.0, sign(d.y), 0.0) : vec3(0.0, 0.0, sign(d.z));
  grid = mix(grid, 128.0 + 128.0 * an, abs(an));
  gl_FragColor = vec4(uPickId, grid);
}
`;

// Blit of the cached 2D map (render target -> canvas, same pixel size): exact copy, no colour conversion.
export const blitVertex = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
export const blitFragment = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
void main() { gl_FragColor = texture(uTex, vUv); }
`;

export const backingFragment = /* glsl */ `
precision highp float;
uniform float uShade;
uniform vec4 uClip;
uniform float uClipSide;
uniform float uClipOn;
in vec3 vGrid;
in vec3 vViewPos;
${COMMON}
void main() {
  vec3 grid = vGrid;
  if (uClipOn > 0.5 && (dot(grid - 128.0, uClip.xyz) - uClip.w) * uClipSide > 0.0) discard;
  vec3 d = grid - 128.0, a = abs(d);
  vec3 an = a.x >= a.y && a.x >= a.z ? vec3(sign(d.x), 0.0, 0.0) : a.y >= a.z ? vec3(0.0, sign(d.y), 0.0) : vec3(0.0, 0.0, sign(d.z));
  grid = mix(grid, 128.0 + 128.0 * an, abs(an));   // snap onto the face for the colour
  vec3 col = clamp(grid / 256.0, 0.0, 1.0);
  vec3 n = normalize(mat3(viewMatrix) * an);
  vec3 v = normalize(-vViewPos);
  float ndl = dot(n, normalize(vec3(0.35, 0.75, 0.55)));
  float hemi = 0.5 + 0.5 * ndl;
  float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
  float shade = mix(1.0, (0.70 + 0.42 * hemi) * (1.0 - 0.35 * rim), uShade);
  gl_FragColor = vec4(linearToSrgb(srgbToLinear(col) * shade), 1.0);
}
`;
