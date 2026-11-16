import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'seed-cli': 'src/db/seed-cli.ts', 'files-to-s3': 'src/attachments/copy-cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The contract package is TypeScript source; bundle it. Ocean's Teams cards and tokens are JSON the
  // chat reads (D42): bundled too, so they're the ones it was built with. Everything else stays in node_modules.
  noExternal: [/^@a4a\//, /^@sreent\/ocean\//],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
