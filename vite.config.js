import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

export default defineConfig({
  plugins: [{ name: 'browser-runtime-boundary', enforce: 'pre', resolveId(id) {
    if (id.startsWith('node:')) throw new Error(`Node API ${id} cannot be used by the WebView2 application. Use the system adapter.`);
    return null;
  } }, react()],
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: 'dist', emptyOutDir: true, minify: !process.env.NO_MINIFY },
});
