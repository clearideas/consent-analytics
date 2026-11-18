// Queues between the API and a worker. An adapter implements this interface for any queue
// product (Redis Streams and SQS are built in as separate modules; BullMQ, RabbitMQ, Kafka,
// Pub/Sub, ... take a few lines with your own client). Bodies are strings.
//
// Semantics expected of every adapter (checked by the queue conformance tests):
// - at-least-once: a received message that is not acked becomes visible again;
// - `attempts` counts deliveries (1 on the first);
// - `retry` makes a message visible again after a delay; `deadLetter` removes it for good,
//   keeping it somewhere it can be inspected.

export interface ReceivedMessage {
  body: string
  /** How many times this message has been delivered, including this time. */
  attempts: number
  /** Adapter data (receipt handle, stream ID, ...). */
  handle: unknown
}

export interface ReceiveOptions {
  max: number
  /** Wait up to this long for a message (long polling). */
  waitMs: number
  signal?: AbortSignal
}

/** What the API needs: send. */
export interface QueueProducer {
  send(bodies: readonly string[]): Promise<void>
  close?(): Promise<void>
}

/** What a worker needs as well. */
export interface IngestQueue extends QueueProducer {
  receive(options: ReceiveOptions): Promise<ReceivedMessage[]>
  ack(messages: readonly ReceivedMessage[]): Promise<void>
  retry(message: ReceivedMessage, delayMs: number): Promise<void>
  deadLetter(message: ReceivedMessage, reason: string): Promise<void>
}

export interface MemoryQueueOptions {
  /** A received message not acked within this time is delivered again. Default 30 s. */
  visibilityTimeoutMs?: number
  clock?: () => number
}

export interface MemoryQueue extends IngestQueue {
  /** Messages not yet acked or dead-lettered. */
  size(): number
  readonly deadLetters: ReadonlyArray<{ body: string; reason: string; attempts: number }>
}

interface Entry {
  id: number
  body: string
  attempts: number
  visibleAt: number
  /** Changes on every delivery; acks and retries must present the current one. */
  receipt: number
}

/**
 * An in-process queue: tests, and single-process deployments that still want API and worker
 * decoupled. Messages are lost if the process stops.
 */
export function memoryQueue(options: MemoryQueueOptions = {}): MemoryQueue {
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? 30_000
  const now = options.clock ?? Date.now
  const entries = new Map<number, Entry>()
  const deadLetters: Array<{ body: string; reason: string; attempts: number }> = []
  const waiters = new Set<() => void>()
  let nextId = 1
  let nextReceipt = 1
  let closed = false

  const wake = () => {
    for (const waiter of [...waiters]) waiter()
  }
  const current = (message: ReceivedMessage) => {
    const { id, receipt } = message.handle as { id: number; receipt: number }
    const entry = entries.get(id)
    return entry && entry.receipt === receipt ? entry : undefined
  }

  return {
    async send(bodies) {
      if (closed) throw new Error('queue is closed')
      for (const body of bodies) {
        entries.set(nextId, { id: nextId, body, attempts: 0, visibleAt: 0, receipt: 0 })
        nextId++
      }
      wake()
    },

    async receive({ max, waitMs, signal }) {
      const deadline = now() + waitMs
      for (;;) {
        const time = now()
        const visible = [...entries.values()].filter(entry => entry.visibleAt <= time).slice(0, max)
        if (visible.length) {
          return visible.map(entry => {
            entry.attempts++
            entry.visibleAt = time + visibilityTimeoutMs
            entry.receipt = nextReceipt++
            return {
              body: entry.body,
              attempts: entry.attempts,
              handle: { id: entry.id, receipt: entry.receipt },
            }
          })
        }
        if (closed || signal?.aborted || time >= deadline) return []
        // Wait for a send, the next message becoming visible, the deadline, or abort.
        const nextVisible = Math.min(
          ...[...entries.values()].map(entry => entry.visibleAt),
          deadline,
        )
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer)
            waiters.delete(done)
            signal?.removeEventListener('abort', done)
            resolve()
          }
          const timer = setTimeout(done, Math.max(nextVisible - now(), 1))
          waiters.add(done)
          signal?.addEventListener('abort', done, { once: true })
        })
      }
    },

    async ack(messages) {
      for (const message of messages) {
        const entry = current(message)
        if (entry) entries.delete(entry.id)
      }
    },

    async retry(message, delayMs) {
      const entry = current(message)
      if (entry) {
        entry.visibleAt = now() + delayMs
        entry.receipt = nextReceipt++ // the old receipt no longer acks it
      }
    },

    async deadLetter(message, reason) {
      const entry = current(message)
      if (!entry) return
      entries.delete(entry.id)
      deadLetters.push({ body: entry.body, reason, attempts: entry.attempts })
    },

    async close() {
      closed = true
      wake()
    },

    size: () => entries.size,
    deadLetters,
  }
}
