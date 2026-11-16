import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'seed-cli': 'src/db/seed-cli.ts' },
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
