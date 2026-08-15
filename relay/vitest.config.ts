import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `tsc` emits test files under dist/. Running both source and generated
    // copies duplicates PostgreSQL integration suites against one destructive
    // test database and makes the release gate race itself.
    exclude: ['dist/**', 'node_modules/**'],
    // The Relay suite imports a large dependency graph and includes bounded
    // 10,000-event backpressure scenarios.  Keep the timeout budget explicit;
    // the normal suite's worker cap belongs to its npm command so dedicated
    // single-worker PostgreSQL gates can still override concurrency cleanly.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
})
