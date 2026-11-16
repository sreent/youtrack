import { defineConfig } from 'tsup';

export default defineConfig({
  // The workflow sandbox's worker thread (D40) is an entry of its own: dist/sandbox-worker.js, beside index.js.
  entry: { index: 'src/index.ts', 'seed-cli': 'src/db/seed-cli.ts', 'files-to-s3': 'src/attachments/copy-cli.ts', 'sandbox-worker': 'src/workflow/sandbox-worker.mjs' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The contract package is TypeScript source; bundle it. Everything else stays in node_modules.
  noExternal: [/^@a4a\//],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
