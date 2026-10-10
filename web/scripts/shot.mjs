#!/usr/bin/env node
// Dev helper: open the app against a running dev server, run a JS steps file, take screenshots.
// Usage: node scripts/shot.mjs <steps.mjs> [--port=5288] [--w=1600] [--h=1000] [--dpr=1] [--scheme=dark|light] [--q=<query>]
// The steps file default-exports `async (page, shot) => {}`; shot(name, opts?) writes build/screens/<name>.png.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(resolve(here, '..', '..'), 'build', 'screens');
mkdirSync(SHOTS, { recursive: true });
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const steps = (await import(pathToFileURL(resolve(argv[0])).href)).default;
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +opt('w', 1600), height: +opt('h', 1000) }, deviceScaleFactor: +opt('dpr', 1), colorScheme: opt('scheme', 'dark') });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const query = opt('q', '');
await page.goto(`http://localhost:${opt('port', 5288)}/?${query}`);
await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 120000 });
await page.waitForTimeout(300);
const shot = async (name, o = {}) => { const p = join(SHOTS, `${name}.png`); await (o.locator ? page.locator(o.locator) : page).screenshot({ path: p, ...(o.clip ? { clip: o.clip } : {}) }); console.log('shot', p); };
try { await steps(page, shot); } catch (e) { console.error(e); }
if (errors.length) console.log('console errors:', errors.slice(0, 10));
await browser.close();
