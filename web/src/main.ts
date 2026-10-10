import 'xkcd-font/static/style.css';
import '@fontsource/patrick-hand/400.css';
import './style.css';
import { App } from './app';
import { assetBase, loadLevels } from './data';
import { UI } from './ui';

function fatal(text: string) {
  // the UI may not exist yet (e.g. no WebGL2), so write to the loading card directly
  document.getElementById('loading-text')!.textContent = text;
  document.getElementById('loading-bar')!.style.width = '100%';
  document.getElementById('loading')!.classList.add('error');
}

async function main() {
  const base = assetBase();
  // start the first request before WebGL init so they overlap
  const levelsP = loadLevels(base);
  levelsP.catch(() => undefined); // awaited below
  let app: App, ui: UI;
  try {
    app = new App(base);
    ui = new UI(app);
  } catch (err) {
    console.error(err);
    fatal(`This page needs WebGL2. Enable hardware acceleration in your browser settings, or try another browser. (${(err as Error).message})`);
    return;
  }
  (window as unknown as { __cc: unknown }).__cc = { app, ui };
  ui.setLoading(0.01, 'Loading levels…');
  let levels;
  try {
    levels = await levelsP;
  } catch (err) {
    fatal(`Could not load ${base}/levels.json — ${(err as Error).message}. ` +
      (base === 'assets' ? 'Run the pipeline, or try ?assets=fake-assets.' : ''));
    console.error(err);
    return;
  }
  app.levels = levels;
  const q = new URLSearchParams(location.search).get('level');
  let saved: string | null = null;
  try { saved = localStorage.getItem('cc.level'); } catch { /* ignore */ }
  const pick = [q, saved, levels.default].find((id) => id && levels.levels.some((l) => l.id === id)) ?? levels.levels[0].id;
  ui.setLevels(levels.levels, pick);
  await ui.loadLevel(levels.levels.find((l) => l.id === pick)!);
  document.body.classList.add('ready');
}

void main();
