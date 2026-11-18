// The SQLite store (node:sqlite).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { sqliteStore } from '../src/stores/sqlite.ts'
import { runStoreConformance, storedEvent } from './support/store-conformance.ts'

runStoreConformance('sqliteStore', async () => {
  const store = sqliteStore({ path: ':memory:' })
  return { store, reader: store, cleanup: () => store.close!() }
})

it('persists in a file across reopening, and runs migrations once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-sqlite-'))
  try {
    const path = join(dir, 'nested', 'analytics.db')
    const first = sqliteStore({ path })
    await first.insertEvents([storedEvent()])
    await first.close!()
    const second = sqliteStore({ path })
    expect(await second.listEvents()).toEqual([storedEvent()])
    expect(await second.insertEvents([storedEvent()])).toEqual({ inserted: 0, duplicates: 1 })
    const migrations = second.database.prepare('SELECT name FROM schema_migrations').all()
    expect(migrations).toEqual([{ name: '001_initial' }])
    await second.close!()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
