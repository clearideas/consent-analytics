// The PostgreSQL store against a real PostgreSQL (see test/support/services.ts).
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { toFetchHandler } from '../src/http/fetch.ts'
import { createCollector, fixedGeo } from '../src/index.ts'
import { migratePostgres, postgresMigrations, postgresStore } from '../src/stores/postgres.ts'
import { runStoreConformance } from './support/store-conformance.ts'

const url = inject('postgresUrl')
let pool: pg.Pool
let tables = 0
const prefixes: string[] = []

async function fresh() {
  const prefix = `t${process.pid}_${++tables}_`
  prefixes.push(prefix)
  await migratePostgres(pool, { prefix })
  return { prefix, store: postgresStore({ db: pool, prefix }) }
}

describe.skipIf(!url)('PostgreSQL', () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 10 })
  })
  afterAll(async () => {
    for (const prefix of prefixes) {
      await pool.query(
        `DROP TABLE IF EXISTS ${prefix}events, ${prefix}consents, ${prefix}identities, ${prefix}schema_migrations`,
      )
    }
    await pool.end()
  })

  runStoreConformance('postgresStore', async () => {
    const { store } = await fresh()
    return { store, reader: store }
  })

  it('migrations are recorded and run once', async () => {
    const prefix = `t${process.pid}_migrations_`
    prefixes.push(prefix)
    expect(await migratePostgres(pool, { prefix })).toEqual(['001_initial'])
    expect(await migratePostgres(pool, { prefix })).toEqual([])
    expect(postgresMigrations(prefix)[0]!.sql).toContain(
      `CREATE TABLE IF NOT EXISTS ${prefix}events`,
    )
    expect(() => postgresMigrations('Bad-Prefix')).toThrow(/Invalid table prefix/)
  })

  it('a collector on PostgreSQL, end to end (NUL characters cleaned, jsonb accepts the rest)', async () => {
    const { store } = await fresh()
    const handle = toFetchHandler(
      createCollector({
        sites: [{ siteKey: 'my-site', allowedOrigins: ['https://www.example.com'] }],
        store,
        geo: fixedGeo({ country: 'US' }),
        logger: false,
      }),
    )
    const response = await handle(
      new Request('http://collector.test/v1/events', {
        method: 'POST',
        headers: { Origin: 'https://www.example.com', 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          v: 1,
          siteKey: 'my-site',
          sentAt: '2026-11-10T12:00:01.000Z',
          events: [
            {
              eventId: 'event-00000001',
              name: 'sign_up',
              occurredAt: '2026-11-10T12:00:00.000Z',
              sessionId: 'session-0000001',
              trackingCategory: 'full',
              consent: { required: false, granted: false },
              props: { plan: 'pro\u0000', unicode: 'Zürich 😀', 'a.b': 1 },
            },
          ],
        }),
      }),
    )
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0, rejected: [] })
    expect((await store.listEvents())[0]).toMatchObject({
      props: { plan: 'pro', unicode: 'Zürich 😀', 'a.b': 1 },
    })
  })
})
