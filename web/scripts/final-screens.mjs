// Steps for scripts/shot.mjs: the final screenshot set (build/screens/final-*.png).
//   nix develop -c npm --prefix web run dev -- --port 5288 &
//   nix develop -c node web/scripts/shot.mjs web/scripts/final-screens.mjs
import { fileURLToPath } from 'node:url';

const settle = async (page, extra = 150) => {
  await page.waitForTimeout(120);
  await page.waitForFunction(() => !window.__cc.app.map.pendingLabels, null, { timeout: 10000 });
  await page.waitForTimeout(extra);
};
const level = async (page, id) => {
  await page.selectOption('#level', id);
  await page.waitForFunction((lid) => window.__cc.app.level?.info.id === lid && document.getElementById('loading').classList.contains('done'), id, { timeout: 60000 });
  await settle(page, 300);
};

export default async (page, shot) => {
  await level(page, 'standard');
  await page.evaluate(() => { const a = window.__cc.app; a.resetCamera(); a.setOrientation('b'); a.setSliderValue(128); });
  await settle(page, 400);
  await shot('final-01-default');

  // exploded, whole blobs (no cut, no plane)
  await page.evaluate(() => { const a = window.__cc.app; a.setClip(false); a.setShowSlice(false); a.setMapVisible(false); a.setExplode(0.7, false); });
  await settle(page, 500);
  await shot('final-02-exploded');

  // hover tooltip on a big blob in the exploded view
  const pt = await page.evaluate(() => {
    const a = window.__cc.app, r = a.canvas.getBoundingClientRect();
    let best = null;
    for (let i = 0; i < 600; i++) {
      const x = r.left + r.width * (0.35 + 0.4 * Math.random()), y = r.top + r.height * (0.25 + 0.5 * Math.random());
      const p = a.pick(x, y);
      if (p.id > 0 && a.level.meta.components[p.id - 1].nameIndex === 3) { best = { x, y }; break; }
    }
    return best;
  });
  if (pt) { await page.mouse.move(pt.x, pt.y); await page.waitForTimeout(400); await shot('final-07-hover'); await page.mouse.move(5, 5); }

  // slicing with clip (R slice, exploded a little, plane visible)
  await page.evaluate(() => { const a = window.__cc.app; a.setExplode(0, false); a.resetCamera(); a.setShowSlice(true); a.setClip(true); a.setMapVisible(true); a.setOrientation('r'); a.setSliderValue(170); });
  await settle(page, 400);
  await shot('final-03-slice-clip');

  // exploded + cut: true-colour caps
  await page.evaluate(() => { const a = window.__cc.app; a.setOrientation('b'); a.setSliderValue(140); a.setExplode(0.75, false); });
  await settle(page, 500);
  await shot('final-03b-exploded-cut');
  await page.evaluate(() => window.__cc.app.setExplode(0, false));

  // 2D map at a mid slice, enlarged panel
  await page.evaluate(() => { const a = window.__cc.app; a.setOrientation('g'); a.setSliderValue(128); const p = document.getElementById('map-panel'); p.style.width = '820px'; p.style.height = '860px'; a.layoutMap(); });
  await settle(page, 400);
  await shot('final-04-map-mid');
  await shot('final-04b-map-mid-panel', { locator: '#map-panel' });

  // grey: across the gray diagonal; hues: along it
  await page.evaluate(() => { const a = window.__cc.app; const p = document.getElementById('map-panel'); p.style.width = ''; p.style.height = ''; a.layoutMap(); a.setOrientation('gray'); a.setSliderValue(383); });
  await settle(page, 400);
  await shot('final-05-gray');
  await page.evaluate(() => { const a = window.__cc.app; a.setOrientation('hues'); a.setSliderValue(30); });
  await settle(page, 400);
  await shot('final-05b-hues');

  // detailed level: exploded with labels, and its map export
  await level(page, 'detailed');
  await page.evaluate(() => { const a = window.__cc.app; a.setOrientation('b'); a.setSliderValue(128); a.setClip(false); a.setShowSlice(false); a.setExplode(0.8, false); });
  await settle(page, 500);
  await shot('final-06-detailed');
  await page.evaluate(() => { const a = window.__cc.app; a.setExplode(0, false); a.setShowSlice(true); a.setClip(true); });
  await settle(page, 400);
  const dl = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.keyboard.press('d')]).then(([d]) => d).catch(() => null);
  if (dl) { await dl.saveAs(fileURLToPath(new URL('../../build/screens/final-09-detailed-export.png', import.meta.url))); console.log('saved export'); }
  await page.evaluate(() => window.__cc.app.resetCamera());

  // narrow layout
  await level(page, 'standard');
  await page.setViewportSize({ width: 430, height: 900 });
  await settle(page, 600);
  await shot('final-10-narrow');
};
