// Conformance tests every IngestQueue adapter must pass (memory now; Redis Streams and SQS
// later; your own adapters too). The worker relies on exactly these behaviors.
import { describe, expect, it } from 'vitest'

import type { IngestQueue, ReceivedMessage } from '../../src/index.ts'

export interface QueueUnderTest {
  queue: IngestQueue
  /** Visibility timeout the queue was created with (received, unacked messages reappear after it). */
  visibilityTimeoutMs: number
  /** Messages dead-lettered so far (bodies), for inspection. */
  deadLetters(): Promise<string[]>
  /**
   * Whether an ack with an outdated receipt is guaranteed to be ignored. SQS documents that it
   * may still delete the message; the worker does not rely on it (it acks only what it holds).
   */
  staleReceiptsIgnored?: boolean
  cleanup?(): Promise<void>
}

const drain = async (queue: IngestQueue, expected: number, waitMs = 2_000) => {
  const received: ReceivedMessage[] = []
  const deadline = Date.now() + waitMs
  while (received.length < expected && Date.now() < deadline) {
    received.push(...(await queue.receive({ max: 10, waitMs: 200 })))
  }
  return received
}

export function runQueueConformance(name: string, create: () => Promise<QueueUnderTest>) {
  describe(`${name}: queue conformance`, { timeout: 20_000 }, () => {
    const withQueue = (test: (subject: QueueUnderTest) => Promise<void>) => async () => {
      const subject = await create()
      try {
        await test(subject)
      } finally {
        await subject.cleanup?.()
      }
    }

    it(
      'delivers what was sent, with the first delivery counted as attempt 1',
      withQueue(async ({ queue }) => {
        await queue.send(['a', 'b'])
        await queue.send(['c'])
        const received = await drain(queue, 3)
        expect(received.map(m => m.body).sort()).toEqual(['a', 'b', 'c'])
        expect(received.every(m => m.attempts === 1)).toBe(true)
        await queue.ack(received)
        expect(await queue.receive({ max: 10, waitMs: 100 })).toEqual([])
      }),
    )

    it(
      'respects max, and carries large and unicode bodies intact',
      withQueue(async ({ queue }) => {
        const big = JSON.stringify({ pad: 'x'.repeat(200_000), text: 'Zürich 😀 "quotes" \\ \n' })
        await queue.send([big, '1', '2', '3'])
        const first = await queue.receive({ max: 2, waitMs: 1_000 })
        expect(first.length).toBeLessThanOrEqual(2)
        const all = [...first, ...(await drain(queue, 4 - first.length))]
        expect(all.map(m => m.body).sort()).toEqual(['1', '2', '3', big].sort())
        await queue.ack(all)
      }),
    )

    it(
      'a received message that is not acked is delivered again, with attempts increased',
      withQueue(async ({ queue, visibilityTimeoutMs }) => {
        await queue.send(['lost-worker'])
        const [first] = await drain(queue, 1)
        expect(first!.attempts).toBe(1)
        // Invisible while "in flight"...
        expect(
          await queue.receive({ max: 10, waitMs: Math.min(100, visibilityTimeoutMs / 4) }),
        ).toEqual([])
        // ...and back after the visibility timeout, as if the worker had crashed.
        const [again] = await drain(queue, 1, visibilityTimeoutMs + 3_000)
        expect(again).toMatchObject({ body: 'lost-worker', attempts: 2 })
        await queue.ack([again!])
      }),
    )

    it(
      'retry makes a message visible again after the delay; a stale receipt no longer acks it',
      withQueue(async ({ queue, staleReceiptsIgnored = true }) => {
        await queue.send(['retry-me'])
        const [first] = await drain(queue, 1)
        await queue.retry(first!, 300)
        expect(await queue.receive({ max: 10, waitMs: 100 })).toEqual([])
        const [second] = await drain(queue, 1, 3_000)
        expect(second).toMatchObject({ body: 'retry-me', attempts: 2 })
        if (staleReceiptsIgnored) await queue.ack([first!]) // stale: must not remove the message
        await queue.retry(second!, 0)
        const [third] = await drain(queue, 1)
        expect(third).toMatchObject({ body: 'retry-me', attempts: 3 })
        await queue.ack([third!])
      }),
    )

    it(
      'deadLetter removes the message for good and keeps it for inspection',
      withQueue(async ({ queue, deadLetters }) => {
        await queue.send(['poison', 'fine'])
        const received = await drain(queue, 2)
        await queue.deadLetter(
          received.find(m => m.body === 'poison')!,
          'cannot be written',
        )
        await queue.ack(received.filter(m => m.body === 'fine'))
        expect(await queue.receive({ max: 10, waitMs: 200 })).toEqual([])
        expect(await deadLetters()).toEqual(['poison'])
      }),
    )

    it(
      'long polling returns as soon as a message arrives; an abort ends the wait',
      withQueue(async ({ queue }) => {
        const started = Date.now()
        const waiting = queue.receive({ max: 10, waitMs: 10_000 })
        setTimeout(() => void queue.send(['late']), 150)
        const received = await waiting
        expect(received.map(m => m.body)).toEqual(['late'])
        expect(Date.now() - started).toBeLessThan(5_000)
        await queue.ack(received)

        const controller = new AbortController()
        const aborted = queue.receive({ max: 10, waitMs: 10_000, signal: controller.signal })
        setTimeout(() => controller.abort(), 100)
        const abortStarted = Date.now()
        expect(await aborted).toEqual([])
        expect(Date.now() - abortStarted).toBeLessThan(5_000)
      }),
    )

    it(
      'concurrent consumers never get the same message at the same time',
      withQueue(async ({ queue }) => {
        const bodies = Array.from({ length: 30 }, (_, i) => `m${i}`)
        await queue.send(bodies)
        const consumer = async () => {
          const mine: string[] = []
          for (let i = 0; i < 20; i++) {
            const received = await queue.receive({ max: 3, waitMs: 100 })
            mine.push(...received.map(m => m.body))
            await queue.ack(received)
          }
          return mine
        }
        const results = await Promise.all([consumer(), consumer(), consumer()])
        const all = results.flat()
        expect(all.sort()).toEqual([...bodies].sort())
        expect(new Set(all).size).toBe(all.length)
      }),
    )
  })
}
