import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/chat/unit/**/*.test.ts', 'tests/pglite.test.mjs'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One worker per core; each test file uses its own disposable PGlite.
    maxWorkers: Math.max(2, availableParallelism()),
  },
});
