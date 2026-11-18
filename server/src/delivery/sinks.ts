// Delivery modes, chosen per endpoint:
//
//   direct    write to the store, then respond                      (durable; real counts)
//   buffered  respond, then write from an in-process buffer          (fast; lost on crash)
//   queued    put on a queue; a worker writes                        (durable once sent)
//             ack 'durable': respond after the queue accepted it
//             ack 'fast':    respond at once, send from a buffer    (lost on crash)
import type { Logger } from '../core/logger.ts'
import type { InsertConsentResult, InsertEventsResult } from '../storage/types.ts'
import type { BufferStats } from './buffer.ts'
import { backgroundWriter } from './buffer.ts'
import type { IngestMessage } from './messages.ts'
import { encodeMessage } from './messages.ts'
import type { IngestProcessor } from './processor.ts'
import type { QueueProducer } from './queue.ts'

export interface BufferOptions {
  /** Largest write (messages per flush). Default 100 (buffered) or 10 (queued). */
  maxBatch?: number
  /** Write at least this often while messages wait. Default 250 ms. */
  flushIntervalMs?: number
  /** Capacity in messages. Default 10 000. */
  maxBufferedMessages?: number
}

export type DeliveryOptions =
  | { mode: 'direct' }
  | ({
      mode: 'buffered'
      /** When the buffer is full: write this request directly (default), or answer 503. */
      whenFull?: 'direct' | 'reject'
    } & BufferOptions)
  | ({
      mode: 'queued'
      queue: QueueProducer
      /** `durable` (default): respond once the queue accepted the message. `fast`: respond at once. */
      ack?: 'durable' | 'fast'
      /** With ack 'fast', when the buffer is full: send this request directly (default), or 503. */
      whenFull?: 'durable' | 'reject'
    } & BufferOptions)

export interface DeliveryStats extends Partial<BufferStats> {
  mode: 'direct' | 'buffered' | 'queued'
}

/** Counts are known only when the store was written before responding. */
export interface DeliveryResult {
  events?: InsertEventsResult
  consent?: InsertConsentResult
}

export interface Sink {
  readonly mode: DeliveryOptions['mode']
  /** Name of the dependency for errors and logs (e.g. `store.insertEvents`, `queue.send`). */
  operation(message: IngestMessage): string
  /** Deliver; throws when the message could not be accepted (the collector answers 503). */
  deliver(message: IngestMessage): Promise<DeliveryResult | undefined>
  stats(): DeliveryStats
  close(deadlineMs: number): Promise<void>
}

export class DeliveryRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryRejectedError'
  }
}

const storeOperation = (message: IngestMessage) =>
  message.kind === 'events' ? 'store.insertEvents' : 'store.insertConsent'

function directSink(processor: IngestProcessor): Sink {
  return {
    mode: 'direct',
    operation: storeOperation,
    async deliver(message) {
      const [outcome] = await processor.write([message])
      if (!outcome!.ok) throw outcome!.error
      return { events: outcome!.events, consent: outcome!.consent }
    },
    stats: () => ({ mode: 'direct' }),
    close: async () => {},
  }
}

export interface SinkContext {
  processor?: IngestProcessor
  logger: Logger
  onError?(error: unknown, context: { operation: string; requestId: string }): void
}

export function createSink(options: DeliveryOptions, context: SinkContext): Sink {
  const { processor, logger } = context
  const requireProcessor = () => {
    if (!processor) throw new Error(`delivery mode "${options.mode}" needs a store`)
    return processor
  }

  if (options.mode === 'direct') return directSink(requireProcessor())

  const bufferSettings = {
    flushIntervalMs: options.flushIntervalMs ?? 250,
    maxItems: options.maxBufferedMessages ?? 10_000,
    logger,
    onError: (error: unknown) =>
      context.onError?.(error, { operation: `delivery.${options.mode}`, requestId: '-' }),
  }

  if (options.mode === 'buffered') {
    const write = requireProcessor()
    const direct = directSink(write)
    const writer = backgroundWriter<IngestMessage>({
      name: 'buffered',
      maxBatch: options.maxBatch ?? 100,
      ...bufferSettings,
      async flush(messages) {
        const outcomes = await write.write(messages)
        // Keep what can be retried; report and drop what cannot.
        return messages.filter((message, index) => {
          const outcome = outcomes[index]!
          if (outcome.ok) return false
          if (outcome.permanent) {
            logger.error(
              { requestId: message.requestId },
              'buffered message cannot be written; dropped',
            )
            return false
          }
          return true
        })
      },
    })
    return {
      mode: 'buffered',
      operation: message =>
        options.whenFull === 'reject' ? 'delivery.buffered' : storeOperation(message),
      async deliver(message) {
        if (writer.offer(message)) return undefined
        if (options.whenFull === 'reject')
          throw new DeliveryRejectedError('delivery buffer is full')
        return direct.deliver(message) // backpressure: this request waits for the store
      },
      stats: () => ({ mode: 'buffered', ...writer.stats() }),
      close: async deadlineMs => {
        await writer.close(deadlineMs)
      },
    }
  }

  // queued
  const { queue } = options
  if (!queue || typeof queue.send !== 'function')
    throw new Error('delivery mode "queued" needs a queue')
  if ((options.ack ?? 'durable') === 'durable') {
    return {
      mode: 'queued',
      operation: () => 'queue.send',
      async deliver(message) {
        await queue.send([encodeMessage(message)])
        return undefined
      },
      stats: () => ({ mode: 'queued' }),
      close: async () => {},
    }
  }
  const writer = backgroundWriter<string>({
    name: 'queued',
    maxBatch: options.maxBatch ?? 10,
    ...bufferSettings,
    async flush(bodies) {
      await queue.send(bodies)
      return []
    },
  })
  return {
    mode: 'queued',
    operation: () => (options.whenFull === 'reject' ? 'delivery.queued' : 'queue.send'),
    async deliver(message) {
      const body = encodeMessage(message)
      if (writer.offer(body)) return undefined
      if (options.whenFull === 'reject') throw new DeliveryRejectedError('delivery buffer is full')
      await queue.send([body])
      return undefined
    },
    stats: () => ({ mode: 'queued', ...writer.stats() }),
    close: async deadlineMs => {
      await writer.close(deadlineMs)
    },
  }
}
