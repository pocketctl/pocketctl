import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `tsc` emits test files under dist/. Running both source and generated
    // copies duplicates PostgreSQL integration suites against one destructive
    // test database and makes the release gate race itself.
    exclude: ['dist/**', 'node_modules/**'],
  },
})
