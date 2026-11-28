/**
 * Makes the golden record's inputs (see golden.ts): the engine's tests, run with the recorder in the
 * engine's place, and the demo's plans, built through the service on a seeded PGlite database.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const recorder = fileURLToPath(new URL('./recorder.ts', import.meta.url));

export default defineConfig({
  root,
  // Only what the engine's tests import as the engine; the recorder itself, and the services, reach the real one.
  resolve: { alias: [{ find: /^\.\.\/\.\.\/src\/planning$/, replacement: recorder }] },
  test: {
    include: ['test/planning/{absences,costs,resources,schedule,what-if}.test.ts', 'test/planning/golden/demo.record.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    maxWorkers: 2,
  },
});
