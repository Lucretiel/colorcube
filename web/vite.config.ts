import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// public/fake-assets/ (generated test data, ~56 MB) is only needed by the smoke test; keep it out of
// production builds unless CC_FAKE=1 (set by `npm test`).
const dropFakeAssets = (): Plugin => ({
  name: 'drop-fake-assets',
  apply: 'build',
  closeBundle() {
    if (process.env.CC_FAKE !== '1') rmSync(fileURLToPath(new URL('./dist/fake-assets', import.meta.url)), { recursive: true, force: true });
  },
});

export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: false },
  build: { outDir: 'dist', assetsDir: 'static', chunkSizeWarningLimit: 1500 }, // assets/ is the data dir
  worker: { format: 'es' },
  plugins: [dropFakeAssets()],
});
