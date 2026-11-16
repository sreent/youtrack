import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

const api = process.env.A4A_API ?? 'http://localhost:3000';
// Ocean, where it really is: in node_modules when pinned, or a checkout beside this repo while
// a4a's needs are being drawn there (`link:`). The dev server may serve its fonts from either.
const ocean = dirname(dirname(realpathSync(createRequire(import.meta.url).resolve('@sreent/ocean/tokens.css'))));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), ocean] },
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/mcp': { target: api, changeOrigin: false },
    },
  },
  build: {
    // Ocean's rule: nothing inline, nothing from outside; Vite emits files only.
    assetsInlineLimit: 0,
    sourcemap: true,
  },
});
