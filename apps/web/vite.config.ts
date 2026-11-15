import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.A4A_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
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
