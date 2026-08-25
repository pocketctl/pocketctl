import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `tsc` emits test files under dist/; exclude them so the suite never
    // runs duplicate PostgreSQL integration passes against one database.
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
})
