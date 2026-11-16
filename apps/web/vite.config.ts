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

/**
 * The app's chunk, its chunks and its styles, fetched from the page's start (D49). main.tsx runs the
 * app only once its person's catalog is in, but the browser needn't wait for the catalog to start
 * downloading the app: the two come side by side, and the app runs from what's already here.
 */
function fetchAppEarly(): Plugin {
  return {
    name: 'a4a-fetch-app-early',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        const app = bundle && Object.values(bundle).find((c) => c.type === 'chunk' && c.facadeModuleId?.endsWith('/src/root.tsx'));
        if (!bundle || !app) throw new Error('a4a-fetch-app-early: the build has no chunk for src/root.tsx');
        const scripts = new Set<string>();
        const styles = new Set<string>();
        const visit = (fileName: string) => {
          const chunk = bundle[fileName];
          // The entry is the page's own script, already on its way, with what it imports.
          if (!chunk || chunk.type !== 'chunk' || chunk.isEntry || scripts.has(fileName)) return;
          scripts.add(fileName);
          for (const css of chunk.viteMetadata?.importedCss ?? []) styles.add(css);
          for (const imported of chunk.imports) visit(imported);
        };
        visit(app.fileName);
        return [
          ...[...styles].map((f) => ({ tag: 'link', attrs: { rel: 'stylesheet', crossorigin: true, href: `/${f}` }, injectTo: 'head' as const })),
          ...[...scripts].map((f) => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: `/${f}` }, injectTo: 'head' as const })),
        ];
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker(), fetchAppEarly()],
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
