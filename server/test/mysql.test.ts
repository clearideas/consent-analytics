// The MySQL store against a real MySQL (see test/support/services.ts).
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { migrateMysql, mysqlMigrations, mysqlStore } from '../src/stores/mysql.ts'
import { runStoreConformance, storedEvent } from './support/store-conformance.ts'

const url = inject('mysqlUrl')
let pool: mysql.Pool
let tables = 0
const prefixes: string[] = []

async function fresh() {
  const prefix = `t${process.pid}_${++tables}_`
  prefixes.push(prefix)
  await migrateMysql(pool, { prefix })
  return mysqlStore({ db: pool, prefix })
}

describe.skipIf(!url)('MySQL', () => {
  beforeAll(async () => {
    const admin = await mysql.createConnection(url)
    await admin.query('CREATE DATABASE IF NOT EXISTS ca_test')
    await admin.end()
    // Deliberately not timezone 'Z': the store must not depend on the connection's time zone.
    pool = mysql.createPool({ uri: url.replace(/\/mysql$/, '/ca_test'), connectionLimit: 10 })
  })
  afterAll(async () => {
    for (const prefix of prefixes) {
      await pool.query(
        `DROP TABLE IF EXISTS ${prefix}events, ${prefix}consents, ${prefix}identities, ${prefix}schema_migrations`,
      )
    }
    await pool.end()
  })

  runStoreConformance('mysqlStore', async () => {
    const store = await fresh()
    return { store, reader: store }
  })

  it('migrations run once', async () => {
    const prefix = `t${process.pid}_migrations_`
    prefixes.push(prefix)
    expect(await migrateMysql(pool, { prefix })).toEqual(['001_initial'])
    expect(await migrateMysql(pool, { prefix })).toEqual([])
    expect(mysqlMigrations(prefix)[0]!.statements).toHaveLength(3)
  })

  it('counts retries per event', async () => {
    const store = await fresh()
    await store.insertEvents([storedEvent()])
    await store.insertEvents([storedEvent(), storedEvent()])
    const [rows] = await pool.query(`SELECT duplicates FROM ${prefixes.at(-1)}events`)
    expect((rows as Array<{ duplicates: number }>)[0]!.duplicates).toBe(2)
  })
})
