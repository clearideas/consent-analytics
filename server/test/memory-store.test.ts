import { expect, it } from 'vitest'

import { memoryStore } from '../src/index.ts'
import { runStoreConformance, storedEvent } from './support/store-conformance.ts'

runStoreConformance('memoryStore', async () => {
  const store = memoryStore()
  return { store, reader: store }
})

it('memoryStore.clear() removes everything, including duplicate tracking', async () => {
  const store = memoryStore()
  await store.insertEvents([storedEvent()])
  store.clear()
  expect(await store.listEvents()).toEqual([])
  expect(await store.insertEvents([storedEvent()])).toEqual({ inserted: 1, duplicates: 0 })
})
