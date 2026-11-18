// An in-process buffer with a background flusher: respond now, write shortly after.
// Used by `buffered` delivery (to the store) and by queued delivery with `ack: 'fast'` (to
// the queue). Items are lost if the process crashes; close() flushes what it can.
import type { Logger } from '../core/logger.ts'
import { errorFields } from '../core/logger.ts'

export interface BufferStats {
  /** Items waiting (including those being written). */
  buffered: number
  /** Items written since start. */
  written: number
  /** Flushes that failed (and were retried). */
  failedFlushes: number
  /** Items given up on (at close, or permanently failing). */
  lost: number
}

export interface BackgroundWriterOptions<T> {
  name: string
  /**
   * Write a batch. Resolve with the items that still need writing (retried after a backoff),
   * or throw to retry the whole batch.
   */
  flush(items: T[]): Promise<T[]>
  /** Largest batch per flush. */
  maxBatch: number
  /** Write at least this often while items wait (a full batch is written at once). */
  flushIntervalMs: number
  /** Capacity; offer() returns false when full. */
  maxItems: number
  logger: Logger
  onError?(error: unknown): void
  /** Backoff after a failed flush: doubles from base to max. */
  retryBaseMs?: number
  retryMaxMs?: number
}

export interface BackgroundWriter<T> {
  /** Add an item; false if the buffer is full (the caller decides what to do). */
  offer(item: T): boolean
  stats(): BufferStats
  /** Stop accepting items and flush until empty or the deadline; returns how many were lost. */
  close(deadlineMs: number): Promise<number>
}

export function backgroundWriter<T>(options: BackgroundWriterOptions<T>): BackgroundWriter<T> {
  const retryBaseMs = options.retryBaseMs ?? 500
  const retryMaxMs = options.retryMaxMs ?? 30_000
  const queue: T[] = []
  const stats: BufferStats = { buffered: 0, written: 0, failedFlushes: 0, lost: 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing: Promise<void> | undefined
  let backoff = 0
  let closed = false

  const schedule = (delay: number) => {
    if (timer || flushing || !queue.length) return
    timer = setTimeout(() => {
      timer = undefined
      void runFlush()
    }, delay)
    timer.unref?.()
  }

  const runFlush = (): Promise<void> => {
    if (flushing) return flushing
    flushing = (async () => {
      const batch = queue.slice(0, options.maxBatch)
      let remaining: T[]
      try {
        remaining = await options.flush(batch)
      } catch (error) {
        remaining = batch
        options.logger.error(
          { ...errorFields(error), buffer: options.name, items: batch.length },
          'buffered write failed; retrying',
        )
        options.onError?.(error)
      }
      // The batch is at the head of the queue: replace it by what is left, in order.
      queue.splice(0, batch.length, ...remaining)
      stats.written += batch.length - remaining.length
      stats.buffered = queue.length
      if (remaining.length) {
        stats.failedFlushes++
        backoff = Math.min(backoff ? backoff * 2 : retryBaseMs, retryMaxMs)
      } else {
        backoff = 0
      }
    })().finally(() => {
      flushing = undefined
      if (!closed)
        schedule(backoff || (queue.length >= options.maxBatch ? 0 : options.flushIntervalMs))
    })
    return flushing
  }

  return {
    offer(item) {
      if (closed || queue.length >= options.maxItems) return false
      queue.push(item)
      stats.buffered = queue.length
      if (queue.length >= options.maxBatch && !backoff && timer) {
        clearTimeout(timer)
        timer = undefined
      }
      schedule(
        queue.length >= options.maxBatch && !backoff ? 0 : backoff || options.flushIntervalMs,
      )
      return true
    },

    stats: () => ({ ...stats }),

    async close(deadlineMs) {
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      const deadline = Date.now() + deadlineMs
      while (queue.length && Date.now() < deadline) {
        await Promise.race([
          runFlush(),
          new Promise(resolve => setTimeout(resolve, Math.max(deadline - Date.now(), 0))),
        ])
        if (queue.length && backoff) {
          await new Promise(resolve =>
            setTimeout(resolve, Math.min(backoff, Math.max(deadline - Date.now(), 0))),
          )
        }
      }
      if (flushing) await Promise.race([flushing, new Promise(resolve => setTimeout(resolve, 0))])
      const lost = queue.length
      if (lost) {
        stats.lost += lost
        options.logger.error(
          { buffer: options.name, items: lost },
          'buffer closed with unwritten items; they are lost',
        )
      }
      queue.length = 0
      stats.buffered = 0
      return lost
    },
  }
}
