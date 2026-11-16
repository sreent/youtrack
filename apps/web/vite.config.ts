import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite';

const api = process.env.A4A_API ?? 'http://localhost:3000';
// Ocean, where it really is: in node_modules when pinned, or a checkout beside this repo while
// a4a's needs are being drawn there (`link:`). The dev server may serve its fonts from either.
const ocean = dirname(dirname(realpathSync(createRequire(import.meta.url).resolve('@sreent/ocean/tokens.css'))));
const here = dirname(fileURLToPath(import.meta.url));

/** Every file under a folder, as a path from it with forward slashes. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'));
}

/**
 * The service worker (docs/architecture.md, D47): sw/service-worker.js, written as /sw.js with this
 * build's id and the files of its app shell (the build's own, and public/'s), which it keeps. A
 * build that changes anything gets a new id, so browsers take it up.
 */
function serviceWorker(): Plugin {
  return {
    name: 'a4a-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const template = readFileSync(join(here, 'sw', 'service-worker.js'), 'utf8');
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html');
      const publicFiles = filesUnder(join(here, 'public'));
      const shell = ['/index.html', ...built, ...publicFiles].map((f) => (f.startsWith('/') ? f : `/${f}`));
      const id = createHash('sha256').update(template).update(shell.sort().join('\n'));
      for (const f of publicFiles) id.update(readFileSync(join(here, 'public', f)));
      const source = `const BUILD = ${JSON.stringify(id.digest('hex').slice(0, 16))};\nconst SHELL = ${JSON.stringify(shell)};\n${template}`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
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
