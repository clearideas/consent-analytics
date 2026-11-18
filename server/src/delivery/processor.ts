// Writing ingest messages to a store: the one write path used by direct delivery, the
// in-process buffer and queue workers.
//
// Events of all messages are written with one bulk insert. If that fails, each message is
// retried on its own, so one bad message cannot hold back the others (and the caller can tell
// an outage, where everything fails, from a poison message, where one does).
import type { Logger } from '../core/logger.ts'
import { errorFields } from '../core/logger.ts'
import type { CollectorStore, InsertConsentResult, InsertEventsResult } from '../storage/types.ts'
import type { IngestMessage } from './messages.ts'
import { decodeMessage, MessageFormatError } from './messages.ts'

export type WriteOutcome =
  | { ok: true; events?: InsertEventsResult; consent?: InsertConsentResult }
  | {
      ok: false
      error: unknown
      /** True when retrying cannot help (e.g. an undecodable message). */
      permanent: boolean
    }

export interface IngestProcessor {
  /** Write messages; one outcome per message, in order. Never throws. */
  write(messages: readonly IngestMessage[]): Promise<WriteOutcome[]>
  /** Decode and write queue message bodies; undecodable bodies fail permanently. */
  process(bodies: readonly string[]): Promise<WriteOutcome[]>
}

export interface IngestProcessorOptions {
  store: CollectorStore
  logger: Logger
  /** Called when a secondary write (identity traits) fails; the message still succeeds. */
  onError?(error: unknown, context: { operation: string; requestId: string }): void
}

export function createIngestProcessor({
  store,
  logger,
  onError,
}: IngestProcessorOptions): IngestProcessor {
  const report = (error: unknown, operation: string, requestId: string) => {
    logger.error({ ...errorFields(error), operation, requestId }, `${operation} failed`)
    try {
      onError?.(error, { operation, requestId })
    } catch {
      // a failing hook must not break writing
    }
  }

  /** Identity traits after the events are stored; a failure is reported, not propagated. */
  const upsertIdentities = async (messages: readonly IngestMessage[]) => {
    if (!store.upsertIdentity) return
    for (const message of messages) {
      if (message.kind !== 'events' || !message.identity) continue
      try {
        await store.upsertIdentity({ siteKey: message.siteKey, ...message.identity })
      } catch (error) {
        report(error, 'store.upsertIdentity', message.requestId)
      }
    }
  }

  const writeEvents = async (messages: Array<Extract<IngestMessage, { kind: 'events' }>>) => {
    const outcomes = new Map<IngestMessage, WriteOutcome>()
    if (!messages.length) return outcomes
    const all = messages.flatMap(message => message.events)
    try {
      const result = await store.insertEvents(all)
      // Counts are per bulk write; attribute them to a single message only when there is one.
      for (const message of messages) {
        outcomes.set(message, messages.length === 1 ? { ok: true, events: result } : { ok: true })
      }
      await upsertIdentities(messages)
      return outcomes
    } catch (error) {
      if (messages.length === 1) {
        outcomes.set(messages[0]!, { ok: false, error, permanent: false })
        return outcomes
      }
    }
    // Isolate: each message on its own.
    for (const message of messages) {
      try {
        outcomes.set(message, { ok: true, events: await store.insertEvents(message.events) })
        await upsertIdentities([message])
      } catch (error) {
        outcomes.set(message, { ok: false, error, permanent: false })
      }
    }
    return outcomes
  }

  const write = async (messages: readonly IngestMessage[]): Promise<WriteOutcome[]> => {
    const events = messages.filter(
      (m): m is Extract<IngestMessage, { kind: 'events' }> => m.kind === 'events',
    )
    const [eventOutcomes, consentOutcomes] = await Promise.all([
      writeEvents(events),
      Promise.all(
        messages.map(async (message): Promise<[IngestMessage, WriteOutcome] | undefined> => {
          if (message.kind !== 'consent') return undefined
          try {
            return [message, { ok: true, consent: await store.insertConsent(message.record) }]
          } catch (error) {
            return [message, { ok: false, error, permanent: false }]
          }
        }),
      ),
    ])
    const consents = new Map(consentOutcomes.filter(entry => entry !== undefined))
    return messages.map(message => eventOutcomes.get(message) ?? consents.get(message)!)
  }

  return {
    write,
    async process(bodies) {
      const decoded = bodies.map(body => {
        try {
          return decodeMessage(body)
        } catch (error) {
          return error instanceof MessageFormatError ? error : new MessageFormatError(String(error))
        }
      })
      const valid = decoded.filter(
        (item): item is IngestMessage => !(item instanceof MessageFormatError),
      )
      const written = await write(valid)
      let next = 0
      return decoded.map(item =>
        item instanceof MessageFormatError
          ? { ok: false, error: item, permanent: true }
          : written[next++]!,
      )
    },
  }
}
