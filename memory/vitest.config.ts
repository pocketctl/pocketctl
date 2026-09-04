import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `tsc` emits test files under dist/; exclude them so the suite never
    // runs duplicate PostgreSQL integration passes against one database.
    // fixtures/** holds synthetic parser corpus files (including *.test.ts
    // sources) that are DATA, never suites.
    exclude: ['dist/**', 'node_modules/**', 'fixtures/**'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
})
