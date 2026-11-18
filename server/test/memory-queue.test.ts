import { expect, it } from 'vitest'

import { memoryQueue } from '../src/index.ts'
import { runQueueConformance } from './support/queue-conformance.ts'

runQueueConformance('memoryQueue', async () => {
  const queue = memoryQueue({ visibilityTimeoutMs: 500 })
  return {
    queue,
    visibilityTimeoutMs: 500,
    deadLetters: async () => queue.deadLetters.map(d => d.body),
    cleanup: () => queue.close!(),
  }
})

it('memoryQueue: size, dead-letter details, and no sends after close', async () => {
  const queue = memoryQueue()
  await queue.send(['a', 'b'])
  expect(queue.size()).toBe(2)
  const [a] = await queue.receive({ max: 1, waitMs: 0 })
  await queue.deadLetter(a!, 'because')
  expect(queue.deadLetters).toEqual([{ body: 'a', reason: 'because', attempts: 1 }])
  expect(queue.size()).toBe(1)
  await queue.close!()
  await expect(queue.send(['c'])).rejects.toThrow(/closed/)
  expect(await queue.receive({ max: 10, waitMs: 1_000 })).toHaveLength(1) // still drains
})
