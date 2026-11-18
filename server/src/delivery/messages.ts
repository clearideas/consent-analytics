// Ingest messages: what the API hands to the store, directly or through a queue. They carry
// finished records (validated, sanitized, enriched), so whoever writes them (the API itself,
// a background flusher or a worker process) needs no policy or site configuration.
//
// Queues transport messages as strings (JSON). The envelope is versioned: a worker rejects
// versions it does not know instead of guessing.
import type { Identity } from '../identity/index.ts'
import type { StoredConsent, StoredEvent } from '../storage/types.ts'

export const MESSAGE_VERSION = 1

export type IngestMessage =
  | {
      kind: 'events'
      v: typeof MESSAGE_VERSION
      requestId: string
      siteKey: string
      events: StoredEvent[]
      /** Traits of the identified visitor, kept once per identity (store.upsertIdentity). */
      identity?: { identity: Identity; traits: Identity; seenAt: string }
    }
  | {
      kind: 'consent'
      v: typeof MESSAGE_VERSION
      requestId: string
      record: StoredConsent
    }

export function encodeMessage(message: IngestMessage): string {
  return JSON.stringify(message)
}

export class MessageFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MessageFormatError'
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const hasStrings = (value: Record<string, unknown>, keys: readonly string[]) =>
  keys.every(key => typeof value[key] === 'string')

const EVENT_STRINGS = [
  'siteKey',
  'eventId',
  'name',
  'occurredAt',
  'sentAt',
  'receivedAt',
  'sessionId',
] as const
const CONSENT_STRINGS = [
  'recordId',
  'siteKey',
  'consentId',
  'decision',
  'policyVersion',
  'decidedAt',
  'recordedAt',
] as const

/**
 * Parse and check a message. Throws MessageFormatError for anything that is not a message
 * this version can write (a permanent failure: retrying cannot help).
 */
export function decodeMessage(body: string): IngestMessage {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new MessageFormatError('not JSON')
  }
  if (!isObject(value)) throw new MessageFormatError('not an object')
  if (value.v !== MESSAGE_VERSION)
    throw new MessageFormatError(`unsupported message version ${String(value.v)}`)
  if (typeof value.requestId !== 'string') throw new MessageFormatError('missing requestId')

  if (value.kind === 'events') {
    if (typeof value.siteKey !== 'string') throw new MessageFormatError('missing siteKey')
    if (!Array.isArray(value.events)) throw new MessageFormatError('missing events')
    for (const event of value.events) {
      if (
        !isObject(event) ||
        !hasStrings(event, EVENT_STRINGS) ||
        !isObject(event.props) ||
        !isObject(event.consent)
      ) {
        throw new MessageFormatError('malformed event')
      }
      if (event.siteKey !== value.siteKey) throw new MessageFormatError('event of another site')
    }
    if (value.identity !== undefined) {
      const identity = value.identity
      if (
        !isObject(identity) ||
        !isObject(identity.identity) ||
        !isObject(identity.traits) ||
        typeof identity.seenAt !== 'string'
      ) {
        throw new MessageFormatError('malformed identity')
      }
    }
    return value as IngestMessage
  }
  if (value.kind === 'consent') {
    if (!isObject(value.record) || !hasStrings(value.record, CONSENT_STRINGS)) {
      throw new MessageFormatError('malformed consent record')
    }
    return value as IngestMessage
  }
  throw new MessageFormatError(`unknown message kind ${String(value.kind)}`)
}
