import { defineConfig } from 'vitest/config';

/** The AI against a real model: `pnpm test:live`. Not part of `pnpm test`, since it needs a key and costs a little. */
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
