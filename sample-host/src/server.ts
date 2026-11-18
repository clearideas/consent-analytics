// Start the collector API, and in DEV_MODE the playground on a second port, so the
// playground is a cross-origin client exactly like a real website.
import { serve } from '@hono/node-server'

import { memoryStore } from '../../server/src/index.ts'
import { sqliteStore } from '../../server/src/stores/sqlite.ts'
import type { DevStore } from './app.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createPlaygroundApp } from './playground.ts'

const config = loadConfig()

/** The library's SQLite store (or memory store for ':memory:'), resettable for /_dev/reset. */
function devStore(path: string): DevStore {
  if (path === ':memory:') return memoryStore()
  const store = sqliteStore({ path })
  return {
    ...store,
    clear: () =>
      store.database.exec('DELETE FROM events; DELETE FROM consents; DELETE FROM identities'),
  }
}
const store = devStore(config.databasePath)
const { app } = createApp({
  config,
  store,
  storeLabel: config.databasePath === ':memory:' ? 'memory' : `SQLite (${config.databasePath})`,
})

const api = serve({ fetch: app.fetch, port: config.port }, info => {
  console.log(`Collector API      http://localhost:${info.port}  (spec: spec/openapi.yaml)`)
})

let playground: ReturnType<typeof serve> | undefined

if (config.devMode) {
  playground = serve(
    { fetch: createPlaygroundApp(config).fetch, port: config.playgroundPort },
    info => {
      console.log(`Playground         http://localhost:${info.port}`)
      console.log(
        'DEV_MODE is on: /_dev endpoints and the geo override are enabled. Do not use in production.',
      )
    },
  )
}

const shutdown = () => {
  api.close()
  playground?.close()
  void store.close?.()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
