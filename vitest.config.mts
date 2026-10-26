import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/chat/unit/**/*.test.ts', 'tests/pglite.test.mjs'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every core locally; CI's small runners slow down past two.
    maxWorkers: process.env.CI ? 2 : Math.max(2, availableParallelism()),
  },
});
