import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // PGlite instances are memory-hungry; keep file-level parallelism modest.
    maxWorkers: 4,
  },
});
