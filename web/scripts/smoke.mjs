#!/usr/bin/env node
// Playwright smoke test: starts `vite preview` (after build) or `vite` dev server, opens the app with
// fake assets (and real assets if web/public/assets/levels.json exists), checks for console errors,
// exercises the main features, verifies true colour via pixel readback, and saves screenshots
// to build/screens/.
//
// Usage: node scripts/smoke.mjs [--dev] [--headed] [--only=fake|real] [--bench]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, '..');
const ROOT = resolve(WEB, '..');
const SHOTS = join(ROOT, 'build', 'screens');
mkdirSync(SHOTS, { recursive: true });
const args = new Set(process.argv.slice(2));
const DEV = args.has('--dev');
const HEADED = args.has('--headed');
const BENCH = args.has('--bench');
const only = [...args].find((a) => a.startsWith('--only='))?.slice(7);

const PORT = DEV ? 5199 : 4199;
let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL', msg); };
const ok = (msg) => console.log('  ok  ', msg);

function startServer() {
  const cmd = DEV ? ['vite', '--port', String(PORT), '--strictPort'] : ['vite', 'preview', '--port', String(PORT), '--strictPort'];
  const p = spawn('npx', cmd, { cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = '';
    const onData = (d) => { out += d; if (out.includes(`${PORT}`)) res(p); };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('exit', (c) => rej(new Error(`server exited ${c}: ${out}`)));
    setTimeout(() => rej(new Error('server start timeout: ' + out)), 30000);
  });
}

const settle = async (page) => {
  await page.waitForFunction(() => !window.__cc.app.map.pendingLabels, null, { timeout: 5000 });
  await page.waitForTimeout(150);
};

/** Hues slices: geometry, fixed map extent, hue accuracy, true colour on the map, rotating plane drag. */
async function huesChecks(page, tag) {
  await page.keyboard.press('5');
  await page.evaluate(() => window.__cc.app.setSliderValue(30));
  await settle(page);
  await page.screenshot({ path: join(SHOTS, `${tag}-07b-hues.png`) });
  let bounds0 = null;
  for (const hue of [0, 37, 200]) {
    if (hue === 37) await page.evaluate(() => { window.__cc.app.map.zoom = 2; });
    await page.evaluate((h) => window.__cc.app.setSliderValue(h), hue);
    await settle(page);
    const r = await page.evaluate(() => {
      const a = window.__cc.app, s = a.slice, m = a.map;
      const poly = s.polygon3D().map((p) => p.toArray());
      const has = (c) => poly.some((p) => p.every((v, i) => Math.abs(v - c[i]) < 1e-3));
      let dupes = 0;
      for (let i = 0; i < poly.length; i++) for (let j = i + 1; j < poly.length; j++) if (Math.hypot(...poly[i].map((v, k) => v - poly[j][k])) < 1e-3) dupes++;
      const hsvHue = ([R, G, B]) => {
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
        if (d < 1) return NaN;
        const h = mx === R ? (G - B) / d : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
        return (h * 60 + 360) % 360;
      };
      const hueErr = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
      // HSV hue of map points right / left of the gray axis (at the map's current zoom)
      const hr = m.host.getBoundingClientRect(), I = m.inner, right = a.clipSide > 0 ? s.hue : s.hue + 180;
      let hueMax = 0, hueN = 0;
      for (const fx of [0.6, 0.75, 0.9, 0.1, 0.25, 0.4]) for (const fy of [0.3, 0.5, 0.7]) {
        const hit = a.mapGridAt(hr.left + I.x + I.w * fx, hr.top + I.y + I.h * fy);
        if (!hit) continue;
        const hh = hsvHue(hit.g.toArray());
        if (Number.isNaN(hh)) continue;
        hueMax = Math.max(hueMax, hueErr(hh, fx > 0.5 ? right : right + 180)); hueN++;
      }
      return {
        poly: poly.length, black: has([0, 0, 0]), white: has([256, 256, 256]), dupes, offset: s.offset,
        nGray: Math.abs(s.normal.x + s.normal.y + s.normal.z), bounds: { ...m.bounds }, zoom: m.zoom,
        hueMax, hueN, desc: s.describe(),
      };
    });
    const geomOk = r.black && r.white && r.dupes === 0 && r.poly >= 4 && r.poly <= 6 && r.offset === 0 && r.nGray < 1e-6;
    geomOk ? ok(`hues ${hue}°: ${r.poly}-gon through black and white corners (${r.desc})`) : fail(`hues ${hue}° geometry ${JSON.stringify(r)}`);
    r.hueN >= 10 && r.hueMax < 0.5 ? ok(`hues ${hue}°: HSV hue of ${r.hueN} map points within ${r.hueMax.toFixed(3)}°`) : fail(`hues ${hue}° hue: ${r.hueN} points, max error ${r.hueMax}`);
    if (!bounds0) bounds0 = r.bounds;
    else if (JSON.stringify(bounds0) !== JSON.stringify(r.bounds)) fail(`hues map extent changed with hue: ${JSON.stringify(bounds0)} -> ${JSON.stringify(r.bounds)}`);
    if (hue !== 0) r.zoom === 2 ? ok(`hues ${hue}°: map extent fixed, zoom kept`) : fail(`hues ${hue}°: zoom reset to ${r.zoom}`);
  }
  await page.evaluate(() => { window.__cc.app.map.zoom = 1; window.__cc.app.setSliderValue(30); });
  await settle(page);

  // true colour on the hues map, away from region borders
  const tc = await page.evaluate(() => {
    const a = window.__cc.app, s = a.slice, u = s.U.toArray(), v = s.V.toArray();
    const interior = (g) => {
      const L = a.labelAt(g[0], g[1], g[2]);
      for (const [i, j] of [[-3, 0], [3, 0], [0, -3], [0, 3], [-2, -2], [2, 2], [-2, 2], [2, -2]]) {
        if (a.labelAt(g[0] + i * u[0] + j * v[0], g[1] + i * u[1] + j * v[1], g[2] + i * u[2] + j * v[2]) !== L) return false;
      }
      return g.every((c) => c > 3 && c < 253);
    };
    const exp = (g) => g.map((c) => Math.round(Math.min(1, Math.max(0, c / 256)) * 255));
    const hr = a.map.host.getBoundingClientRect(), I = a.map.inner, out = [];
    for (let i = 0; i < 3000 && out.length < 30; i++) {
      const x = hr.left + I.x + I.w * (0.03 + 0.94 * Math.random()), y = hr.top + I.y + I.h * (0.03 + 0.94 * Math.random());
      const hit = a.mapGridAt(x, y);
      if (!hit || !interior(hit.g.toArray())) continue;
      out.push({ got: a.readPixel(x, y).rgba.slice(0, 3), exp: exp(hit.g.toArray()) });
    }
    return out;
  });
  const err = tc.reduce((m, t) => Math.max(m, ...t.got.map((v, i) => Math.abs(v - t.exp[i]))), 0);
  tc.length >= 10 && err <= 1 ? ok(`true-colour hues map: ${tc.length} samples, max channel error ${err}`) : fail(`true-colour hues map: ${tc.length} samples, max error ${err} ${JSON.stringify(tc.slice(0, 3))}`);

  // dragging the plane turns it about the gray axis without a limit, the grabbed point following the pointer:
  // trace the grab point around its circle in the default view, and seen edge-on (camera perpendicular to the
  // gray axis, where the drag can't intersect the circle's plane and follows the on-screen motion instead)
  for (const [view, sweep, hue] of [['default view', 150, 30], ['edge-on view', 60, 60]]) {
    await page.evaluate(({ view, hue }) => {
      const a = window.__cc.app;
      a.resetCamera();
      if (view === 'edge-on view') { a.camera.position.set(1, -1, 0).normalize().multiplyScalar(960); a.controls.update(); }
      a.setSliderValue(hue);
    }, { view, hue });
    await settle(page);
    const grab = await page.evaluate((sweep) => {
      const a = window.__cc.app, s = a.slice, r = a.canvas.getBoundingClientRect();
      const axis = s.normal.clone().set(1, 1, 1).normalize();
      const toScreen = (v) => { const p = v.clone().project(a.camera); return [r.left + (p.x + 1) * r.width / 2, r.top + (1 - p.y) * r.height / 2]; };
      for (let i = 0; i < 4000; i++) {
        const x = r.left + r.width * (0.2 + 0.6 * Math.random()), y = r.top + r.height * (0.1 + 0.8 * Math.random());
        const pk = a.pick(x, y);
        if (pk.id !== -1) continue;
        const rel = pk.grid.clone().addScalar(-128);
        if (Math.abs(rel.dot(s.U)) < 50) continue; // enough lever arm
        // the whole traced arc must stay on screen and keep moving across it
        const path = [];
        for (let k = 1; k <= 30; k++) path.push(toScreen(rel.clone().applyAxisAngle(axis, ((sweep * k) / 30) * Math.PI / 180)));
        const steps = path.map((p, k) => Math.hypot(p[0] - (k ? path[k - 1][0] : x), p[1] - (k ? path[k - 1][1] : y)));
        if (Math.min(...steps) < 3 || path.some(([px, py]) => px < r.left + 20 || px > r.right - 20 || py < r.top + 20 || py > r.bottom - 20)) continue;
        return { x, y, rel: rel.toArray(), hue: s.hue, path };
      }
      return null;
    }, sweep);
    if (!grab) { fail(`hues drag (${view}): could not find a usable grab point on the plane`); continue; }
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    for (const [x, y] of grab.path) { await page.mouse.move(x, y); await page.waitForTimeout(16); }
    await page.mouse.up();
    await settle(page);
    const d = await page.evaluate(({ rel, hue, last }) => {
      const a = window.__cc.app, s = a.slice, r = a.canvas.getBoundingClientRect();
      const turned = ((s.hue - hue + 540) % 360) - 180;
      const p = s.normal.clone().fromArray(rel).applyAxisAngle(s.normal.clone().set(1, 1, 1).normalize(), (turned * Math.PI) / 180).project(a.camera);
      return { turned, offset: s.offset, miss: Math.hypot(r.left + (p.x + 1) * r.width / 2 - last[0], r.top + (1 - p.y) * r.height / 2 - last[1]) };
    }, { rel: grab.rel, hue: grab.hue, last: grab.path[grab.path.length - 1] });
    Math.abs(d.turned - sweep) < 8 && d.miss < 15 && d.offset === 0
      ? ok(`hues plane drag (${view}): traced ${sweep}°, plane turned ${d.turned.toFixed(1)}°, grab point ${d.miss.toFixed(1)} px from the pointer`)
      : fail(`hues plane drag (${view}): traced ${sweep}° ${JSON.stringify(d)}`);
    await page.screenshot({ path: join(SHOTS, `${tag}-07c-hues-dragged-${view.split(' ')[0]}.png`) });
  }
  await page.evaluate(() => window.__cc.app.resetCamera());
}

async function run(browser, assets) {
  const tag = assets === 'assets' ? 'real' : 'fake';
  console.log(`\n== ${tag} assets (${assets})`);
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: process.env.SCHEME || 'dark' });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const url = `http://localhost:${PORT}/?assets=${assets}`;
  // an exception during startup means the app never becomes ready: report it now, not after the timeout
  const crashed = new Promise((_, rej) => page.once('pageerror', (e) => rej(new Error(`page error during startup: ${e.message}`))));
  crashed.catch(() => {}); // later page errors are collected in `errors` instead
  await page.goto(url);
  await Promise.race([page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 120000 }), crashed]);
  await page.waitForFunction(() => window.__cc.app.map.labels.length > 0, null, { timeout: 30000 }).catch(() => fail('2D labels never appeared'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${tag}-01-initial.png`) });
  ok('loaded');

  const info = await page.evaluate(() => {
    const a = window.__cc.app;
    return { level: a.level.info.id, names: a.level.meta.names.length, comps: a.level.meta.components.length, tris: a.blobs.triangles, levels: a.levels.levels.map((l) => l.id) };
  });
  console.log('  info', JSON.stringify(info));

  // --- true colour readback: flat shading, find a blob pixel, compare to its grid position
  const tc = await page.evaluate(() => {
    const a = window.__cc.app;
    a.setShade(0); a.setShowSlice(false); a.setExplode(0, false);
    a.setHoverName(-1);
    const r = a.canvas.getBoundingClientRect();
    const results = [];
    for (let i = 0; i < 400 && results.length < 40; i++) {
      const x = r.left + r.width * (0.25 + 0.5 * Math.random()), y = r.top + r.height * (0.15 + 0.7 * Math.random());
      const covered = ['map-panel', 'side', 'tooltip'].some((id) => {
        const el = document.getElementById(id); if (!el || el.hidden) return false;
        const b = el.getBoundingClientRect(); return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
      });
      if (covered) continue;
      const p = a.readPixel(x, y);
      if (p.pick.id <= 0) continue;
      // interior pixels only (silhouettes / blob seams are antialiased by MSAA)
      const nb = [[-2, 0], [2, 0], [0, -2], [0, 2]].map(([dx, dy]) => a.pick(x + dx, y + dy));
      if (nb.some((q) => q.id !== p.pick.id)) continue;
      // skip the cube's edges, where the (decorative) wireframe outline is drawn over the surface
      if (p.pick.grid.filter((v) => v < 2 || v > 254).length >= 2) continue;
      const exp = p.pick.grid.map((v) => Math.round(Math.min(1, Math.max(0, v / 256)) * 255));
      results.push({ got: p.rgba.slice(0, 3), exp });
    }
    a.setShade(0.55); a.setShowSlice(true);
    return results;
  });
  const maxErr = tc.reduce((m, t) => Math.max(m, ...t.got.map((v, i) => Math.abs(v - t.exp[i]))), 0);
  if (tc.length < 10) fail(`true-colour: only ${tc.length} samples`);
  else if (maxErr > 2) fail(`true-colour max channel error ${maxErr} (${JSON.stringify(tc.filter((t) => t.got.some((v, i) => Math.abs(v - t.exp[i]) > 2)).slice(0, 4))})`);
  else ok(`true-colour readback: ${tc.length} samples, max channel error ${maxErr}`);

  // --- true colour on the slice: the 3D plane and the 2D map, away from region borders
  const sliceTc = await page.evaluate(() => {
    const a = window.__cc.app;
    a.resetCamera(); a.setShowSlice(true); a.setClip(true); a.setExplode(0, false); a.setHoverName(-1);
    a.setOrientation('b'); a.setSliderValue(100);
    a.decor.visible = false; // the decorative cube wireframe is drawn over the plane where the cut opened it
    const out = { plane: [], map: [] };
    // interior of a region: same smooth label everywhere within +-3 voxels in the plane
    const interior = (g, u, v) => {
      const L = a.labelAt(g[0], g[1], g[2]);
      for (const [i, j] of [[-3, 0], [3, 0], [0, -3], [0, 3], [-2, -2], [2, 2], [-2, 2], [2, -2]]) {
        if (a.labelAt(g[0] + i * u[0] + j * v[0], g[1] + i * u[1] + j * v[1], g[2] + i * u[2] + j * v[2]) !== L) return false;
      }
      return g.every((c) => c > 3 && c < 253);
    };
    const exp = (g) => g.map((c) => Math.round(Math.min(1, Math.max(0, c / 256)) * 255));
    const r = a.canvas.getBoundingClientRect();
    const covered = (x, y) => ['map-panel', 'side', 'tooltip'].some((id) => {
      const el = document.getElementById(id); if (!el || el.hidden) return false;
      const b = el.getBoundingClientRect(); return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
    });
    for (let i = 0; i < 3000 && out.plane.length < 30; i++) {
      const x = r.left + r.width * (0.2 + 0.6 * Math.random()), y = r.top + r.height * (0.1 + 0.8 * Math.random());
      if (covered(x, y)) continue;
      const p = a.readPixel(x, y);
      if (p.pick.id !== -1 || !interior(p.pick.grid, [1, 0, 0], [0, 1, 0])) continue;
      // keep clear of the plane outline and the drag handle
      const hp = a.handle.position; if (Math.hypot(p.pick.grid[0] - hp.x, p.pick.grid[1] - hp.y) < 30) continue;
      if (p.pick.grid.slice(0, 2).some((c) => c < 6 || c > 250)) continue;
      out.plane.push({ got: p.rgba.slice(0, 3), exp: exp(p.pick.grid), g: p.pick.grid.map((c) => +c.toFixed(1)) });
    }
    const hr = a.map.host.getBoundingClientRect(), I = a.map.inner;
    for (let i = 0; i < 3000 && out.map.length < 30; i++) {
      const x = hr.left + I.x + I.w * (0.03 + 0.94 * Math.random()), y = hr.top + I.y + I.h * (0.03 + 0.94 * Math.random());
      const hit = a.mapGridAt(x, y);
      if (!hit) continue;
      const g = hit.g.toArray();
      if (!interior(g, [1, 0, 0], [0, 1, 0])) continue;
      const p = a.readPixel(x, y);
      out.map.push({ got: p.rgba.slice(0, 3), exp: exp(g), g: g.map((c) => +c.toFixed(1)) });
    }
    a.decor.visible = true;
    return out;
  });
  for (const [what, arr] of Object.entries(sliceTc)) {
    const err = arr.reduce((m, t) => Math.max(m, ...t.got.map((v, i) => Math.abs(v - t.exp[i]))), 0);
    if (arr.length < 10) fail(`true-colour ${what}: only ${arr.length} samples`);
    else if (err > 1) fail(`true-colour ${what} max channel error ${err} (${JSON.stringify(arr.filter((t) => t.got.some((v, i) => Math.abs(v - t.exp[i]) > 1)).slice(0, 3))})`);
    else ok(`true-colour ${what === 'plane' ? '3D slice plane' : '2D map'}: ${arr.length} samples, max channel error ${err}`);
  }
  await page.evaluate(() => window.__cc.app.setSliderValue(128));

  // --- explode
  await page.locator('#explode').fill('0.6');
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(SHOTS, `${tag}-02-exploded.png`) });
  const ex = await page.evaluate(() => window.__cc.app.explode);
  ex > 0.55 ? ok(`explode = ${ex.toFixed(2)}`) : fail(`explode did not animate (${ex})`);

  // --- hover tooltip on a blob
  const hoverPt = await page.evaluate(() => {
    const a = window.__cc.app, r = a.canvas.getBoundingClientRect();
    for (let i = 0; i < 300; i++) {
      const x = r.left + r.width * (0.3 + 0.4 * Math.random()), y = r.top + r.height * (0.2 + 0.6 * Math.random());
      if (a.pick(x, y).id > 0) return { x, y };
    }
    return null;
  });
  if (hoverPt) {
    await page.mouse.move(hoverPt.x, hoverPt.y);
    await page.waitForTimeout(250);
    const tt = await page.locator('#tooltip').isVisible();
    tt ? ok('tooltip on blob hover') : fail('no tooltip on blob hover');
    await page.screenshot({ path: join(SHOTS, `${tag}-03-hover.png`) });
    // click -> solo
    await page.mouse.click(hoverPt.x, hoverPt.y);
    await page.waitForTimeout(300);
    const vis = await page.evaluate(() => window.__cc.app.nameVisible.filter(Boolean).length);
    vis === 1 ? ok('click solo') : fail(`click solo -> ${vis} visible`);
    await page.screenshot({ path: join(SHOTS, `${tag}-04-solo.png`) });
    await page.keyboard.press('Escape');
  } else fail('no blob found to hover');

  // --- collapse explode, slice orientations
  await page.evaluate(() => window.__cc.app.setExplode(0, false));
  await page.mouse.move(5, 5);
  for (const [key, o] of [['1', 'r'], ['2', 'g'], ['4', 'gray'], ['5', 'hues'], ['6', 'free'], ['3', 'b']]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
    const cur = await page.evaluate(() => window.__cc.app.slice.orientation);
    cur === o ? ok(`orientation ${o}`) : fail(`orientation ${o} -> ${cur}`);
  }
  await page.waitForFunction(() => !window.__cc.app.map.pendingLabels, null, { timeout: 5000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS, `${tag}-05-slice-b.png`) });

  // --- drag the plane in 3D: find a pixel that picks the plane (or handle) and drag it
  const planePt = await page.evaluate(() => {
    const a = window.__cc.app, r = a.canvas.getBoundingClientRect();
    for (let i = 0; i < 2000; i++) {
      const x = r.left + r.width * (0.2 + 0.5 * Math.random()), y = r.top + r.height * (0.1 + 0.8 * Math.random());
      const pk = a.pick(x, y);
      if (pk.id === -1 || pk.id === -2) {
        // screen-space direction of the plane normal at the grab point, so the drag moves along it
        const P = pk.grid.clone().addScalar(-128), Q = P.clone().addScaledVector(a.slice.normal, 40);
        P.project(a.camera); Q.project(a.camera);
        let dx = (Q.x - P.x) * r.width / 2, dy = -(Q.y - P.y) * r.height / 2;
        const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
        return { x, y, id: pk.id, dx: -dx, dy: -dy };
      }
    }
    return null;
  });
  if (planePt) {
    const before = await page.evaluate(() => window.__cc.app.slice.sliderValue);
    await page.mouse.move(planePt.x, planePt.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(planePt.x + i * 7 * planePt.dx, planePt.y + i * 7 * planePt.dy); await page.waitForTimeout(16); }
    const mid = await page.evaluate(() => ({ v: window.__cc.app.slice.sliderValue, pending: window.__cc.app.map.pendingLabels }));
    await page.mouse.up();
    const t0 = Date.now();
    await page.waitForFunction(() => !window.__cc.app.map.pendingLabels, null, { timeout: 5000 });
    const lag = Date.now() - t0;
    const after = await page.evaluate(() => window.__cc.app.slice.sliderValue);
    after !== before ? ok(`plane drag: B ${before} -> ${mid.v} -> ${after} (labels settled ${lag} ms after release)`) : fail(`plane drag did not move slice (${before})`);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${tag}-06-dragged.png`) });
  } else fail('could not find the slice plane on screen');

  // --- labels exist in 2D
  const labels = await page.evaluate(() => window.__cc.app.map.labels.map((l) => ({ t: l.lines.join(' '), s: +l.size.toFixed(1), a: +l.angle.toFixed(2) })));
  labels.length > 0 ? ok(`2D labels: ${labels.length} (${labels.slice(0, 6).map((l) => l.t).join(', ')})`) : fail('no 2D labels');

  // --- grey (across the gray diagonal), hues (along it) + free
  await page.keyboard.press('4');
  await page.waitForFunction(() => !window.__cc.app.map.pendingLabels, null, { timeout: 5000 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, `${tag}-07-gray.png`) });
  await huesChecks(page, tag);
  await page.keyboard.press('6');
  await page.evaluate(() => window.__cc.app.setAngles(30, 20));
  await page.waitForFunction(() => !window.__cc.app.map.pendingLabels, null, { timeout: 5000 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, `${tag}-08-free.png`) });
  // back to a full B slice for the map checks below
  await page.keyboard.press('3');
  await page.evaluate(() => window.__cc.app.setSliderValue(128));
  await page.waitForFunction(() => !window.__cc.app.map.pendingLabels, null, { timeout: 5000 });
  await page.waitForTimeout(150);

  // --- 2D map hover: tooltip with name/hex
  const mb = await page.locator('#map-host').boundingBox();
  await page.mouse.move(mb.x + mb.width * 0.75, mb.y + mb.height * 0.3);
  await page.waitForTimeout(200);
  const mapTip = await page.locator('#tooltip').isVisible() ? await page.locator('#tooltip').innerText() : '';
  /#[0-9a-f]{6}/.test(mapTip) ? ok(`2D map hover tooltip: ${mapTip.split('\n')[0]}`) : fail('no tooltip on 2D map hover');
  await page.screenshot({ path: join(SHOTS, `${tag}-09c-map-hover.png`) });
  // wheel zoom into the map
  await page.mouse.move(mb.x + mb.width * 0.55, mb.y + mb.height * 0.5);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(30); }
  const zoom = await page.evaluate(() => window.__cc.app.map.zoom);
  zoom > 2 ? ok(`map zoom ${zoom.toFixed(2)}x`) : fail(`map zoom did not change (${zoom})`);
  await page.waitForTimeout(200);
  await page.locator('#map-panel').screenshot({ path: join(SHOTS, `${tag}-09d-map-zoom.png`) });
  await page.locator('#map-host').dblclick();
  await page.mouse.move(5, 5);

  // --- PNG export
  const dl = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.keyboard.press('d')]).then(([d]) => d).catch(() => null);
  if (dl) { const p = join(SHOTS, `${tag}-10-export.png`); await dl.saveAs(p); ok(`PNG export -> ${p}`); } else fail('PNG download did not happen');

  // --- exploded + cut (caps)
  await page.keyboard.press('3');
  await page.evaluate(() => { const a = window.__cc.app; a.setSliderValue(150); a.setExplode(0.8, false); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${tag}-11-exploded-cut.png`) });
  await page.evaluate(() => window.__cc.app.setExplode(0, false));

  // --- level switch (all levels)
  for (const id of info.levels.filter((l) => l !== info.level)) {
    await page.selectOption('#level', id);
    await page.waitForFunction((lid) => window.__cc.app.level?.info.id === lid && document.getElementById('loading').classList.contains('done'), id, { timeout: 120000 });
    await page.waitForFunction(() => !window.__cc.app.map.pendingLabels, null, { timeout: 10000 });
    await page.waitForTimeout(300);
    const n = await page.evaluate(() => ({ names: window.__cc.app.level.meta.names.length, tris: window.__cc.app.blobs.triangles }));
    ok(`level switch -> ${id} (${n.names} names, ${n.tris} tris)`);
    await page.screenshot({ path: join(SHOTS, `${tag}-12-level-${id}.png`) });
  }

  if (BENCH) {
    for (const id of info.levels) {
      await page.selectOption('#level', id);
      await page.waitForFunction((lid) => window.__cc.app.level?.info.id === lid && document.getElementById('loading').classList.contains('done'), id, { timeout: 120000 });
      for (const ex of [0, 0.8]) {
        const b = await page.evaluate(async (e) => { window.__cc.app.setExplode(e, false); return window.__cc.app.benchmark(180); }, ex);
        console.log(`  bench ${id} explode=${ex}: ${b.fps.toFixed(1)} fps, cpu ${b.avgCpuMs.toFixed(2)} ms/frame, ${b.triangles} tris, ${b.drawCalls} calls`);
      }
    }
  }

  // small-width layout
  await page.setViewportSize({ width: 480, height: 860 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${tag}-13-narrow.png`) });

  const relevant = errors.filter((e) => !/favicon/.test(e));
  relevant.length ? fail(`console errors:\n    ${relevant.slice(0, 10).join('\n    ')}`) : ok('no console errors');
  await page.close();
}

const server = await startServer();
let browser;
try {
  browser = await chromium.launch({
    headless: !HEADED,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });
  if (only !== 'real') {
    if (existsSync(join(WEB, DEV ? 'public' : 'dist', 'fake-assets', 'levels.json'))) await run(browser, 'fake-assets');
    else console.log('\n(fake assets not present - skipped; run `npm run fake-assets` and build with CC_FAKE=1)');
  }
  if (only !== 'fake') {
    if (existsSync(join(WEB, DEV ? 'public' : 'dist', 'assets', 'levels.json'))) await run(browser, 'assets');
    else console.log('\n(real assets not present - skipped)');
  }
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  await browser?.close();
  server.kill();
}
console.log(failures ? `\n${failures} failure(s)` : '\nall smoke checks passed');
process.exit(failures ? 1 : 0);
