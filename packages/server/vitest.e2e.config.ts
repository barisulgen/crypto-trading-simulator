import { defineConfig } from 'vitest/config';

// End-to-end scenarios: the real server, spawned from its entry point, against a local fake
// Binance. Each scenario file runs in parallel with its own fake, server and database.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
