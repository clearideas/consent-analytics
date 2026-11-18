import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The same real services as the server package (MongoDB, Redis, Postgres, MySQL, moto).
    globalSetup: ['../server/test/support/services.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
