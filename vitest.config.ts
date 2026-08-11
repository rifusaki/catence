import { defineConfig } from 'vitest/config';

/**
 * Several integration tests create and migrate real DuckDB stores. The default
 * five-second per-test timeout is too tight under parallel local I/O, while a
 * 15-second bound still catches stuck provider or database operations quickly.
 */
export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
});
