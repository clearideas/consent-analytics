// A queue worker: receives ingest messages and writes them to the store. The same for every
// queue product (memory, Redis Streams, SQS, your own adapter).
//
//   const worker = runWorker({ queue, store })
//   process.on('SIGTERM', () => worker.stop())
//
// - Messages are written in batches (events of all received messages in one bulk insert).
// - A message that fails is retried after a growing delay; after `maxAttempts` deliveries,
//   or if it cannot be decoded at all, it is dead-lettered.
// - When every write fails (the store is down), the worker also pauses before receiving more,
//   instead of spinning.
// - stop() finishes the messages in hand; unfinished messages are redelivered by the queue.
// - Redelivery is safe: stores de-duplicate by (siteKey, eventId) and recordId.
import type { Logger } from '../core/logger.ts'
import { consoleLogger, errorFields } from '../core/logger.ts'
import type { CollectorStore } from '../storage/types.ts'
import { createIngestProcessor } from './processor.ts'
import type { IngestQueue, ReceivedMessage } from './queue.ts'

export interface WorkerOptions {
  queue: IngestQueue
  store: CollectorStore
  /** Messages per receive (and per bulk write). Default 10. */
  batchSize?: number
  /** Long-poll wait per receive. Default 20 s. */
  waitMs?: number
  /** Parallel receive loops. Default 1. */
  concurrency?: number
  /** Deliveries before a failing message is dead-lettered. Default 10. */
  maxAttempts?: number
  /** Delay before a failed message is retried: doubles per attempt. Default 1 s to 5 min. */
  retryBaseMs?: number
  retryMaxMs?: number
  /** Pause when all writes of a batch fail (store down). Default 1 s, doubling to 1 min. */
  outageBaseMs?: number
  outageMaxMs?: number
  logger?: Logger | false
  hooks?: {
    onError?(error: unknown, context: { operation: string; requestId: string }): void
    onDeadLetter?(info: { body: string; reason: string; attempts: number }): void
  }
}

export interface WorkerStats {
  received: number
  written: number
  retried: number
  deadLettered: number
}

export interface Worker {
  stats(): WorkerStats
  /** Stop receiving, finish the messages in hand. */
  stop(): Promise<void>
  /** Resolves when the worker has stopped. */
  readonly done: Promise<void>
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

export function runWorker(options: WorkerOptions): Worker {
  const { queue, store } = options
  const logger = options.logger === false ? undefined : (options.logger ?? consoleLogger())
  const log: Logger = logger ?? { debug() {}, info() {}, warn() {}, error() {} }
  const batchSize = options.batchSize ?? 10
  const waitMs = options.waitMs ?? 20_000
  const maxAttempts = options.maxAttempts ?? 10
  const retryBaseMs = options.retryBaseMs ?? 1_000
  const retryMaxMs = options.retryMaxMs ?? 300_000
  const outageBaseMs = options.outageBaseMs ?? 1_000
  const outageMaxMs = options.outageMaxMs ?? 60_000
  const hooks = options.hooks ?? {}
  const processor = createIngestProcessor({ store, logger: log, onError: hooks.onError })
  const stats: WorkerStats = { received: 0, written: 0, retried: 0, deadLettered: 0 }
  const controller = new AbortController()

  const deadLetter = async (message: ReceivedMessage, reason: string) => {
    await queue.deadLetter(message, reason)
    stats.deadLettered++
    log.error({ reason, attempts: message.attempts }, 'message dead-lettered')
    try {
      hooks.onDeadLetter?.({ body: message.body, reason, attempts: message.attempts })
    } catch {
      // a failing hook must not stop the worker
    }
  }

  const loop = async () => {
    let outage = 0
    while (!controller.signal.aborted) {
      let messages: ReceivedMessage[]
      try {
        messages = await queue.receive({ max: batchSize, waitMs, signal: controller.signal })
      } catch (error) {
        log.error({ ...errorFields(error) }, 'queue receive failed')
        outage = Math.min(outage ? outage * 2 : outageBaseMs, outageMaxMs)
        await sleep(outage, controller.signal)
        continue
      }
      if (!messages.length) continue
      stats.received += messages.length

      const outcomes = await processor.process(messages.map(message => message.body))
      const done: ReceivedMessage[] = []
      for (const [index, message] of messages.entries()) {
        const outcome = outcomes[index]!
        try {
          if (outcome.ok) {
            done.push(message)
          } else if (outcome.permanent) {
            await deadLetter(message, `undeliverable: ${(outcome.error as Error).message}`)
          } else if (message.attempts >= maxAttempts) {
            await deadLetter(
              message,
              `failed ${message.attempts} times: ${(outcome.error as Error)?.message ?? outcome.error}`,
            )
          } else {
            const delay = Math.min(retryBaseMs * 2 ** (message.attempts - 1), retryMaxMs)
            await queue.retry(message, delay)
            stats.retried++
          }
        } catch (error) {
          // The queue itself failed: the message will be redelivered after its visibility timeout.
          log.error({ ...errorFields(error) }, 'queue retry/dead-letter failed')
        }
      }
      if (done.length) {
        try {
          await queue.ack(done)
          stats.written += done.length
        } catch (error) {
          log.error(
            { ...errorFields(error), messages: done.length },
            'queue ack failed; messages will be redelivered',
          )
        }
      }

      const allFailed = outcomes.every(outcome => !outcome.ok && !outcome.permanent)
      if (allFailed) {
        outage = Math.min(outage ? outage * 2 : outageBaseMs, outageMaxMs)
        log.warn({ pauseMs: outage }, 'all writes failed; pausing')
        await sleep(outage, controller.signal)
      } else {
        outage = 0
      }
    }
  }

  const loops = Array.from({ length: options.concurrency ?? 1 }, () => loop())
  const done = Promise.all(loops).then(() => undefined)

  return {
    stats: () => ({ ...stats }),
    async stop() {
      controller.abort()
      await done
    },
    done,
  }
}
