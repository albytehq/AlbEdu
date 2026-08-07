import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests hit live Supabase project — long timeouts
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run sequentially (not parallel) — tests share Supabase project state
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    // Only run integration tests by default (unit tests can be added later)
    include: ['tests/integration/**/*.test.js'],
    // Setup files
    setupFiles: ['tests/setup.js'],
    // Reporter for CI
    reporters: process.env.CI ? ['github-actions', 'default'] : ['default'],
  },
});
