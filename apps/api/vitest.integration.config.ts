import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one PostgreSQL database and coordinate through
    // it, so they run in a single worker and manage their own isolation.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ['./test/integration/setup.ts'],
  },
});
