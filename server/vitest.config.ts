import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Real services (MongoDB, ...) for adapter tests: see test/support/services.ts.
    globalSetup: ['test/support/services.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Generated from the spec; its equivalence with Ajv is tested instead.
      exclude: ['src/protocol/generated/**', 'src/policy/generated/**'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
})
