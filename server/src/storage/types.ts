// Storage interface. Adapters (memory here; MongoDB, Postgres, ... in their own modules)
// implement CollectorStore. Every adapter must pass the same conformance tests.
import type { ServerInfo } from '../enrich/index.ts'
import type { Identity } from '../identity/index.ts'
import type { EventProjection } from '../normalize/index.ts'
import type { PropValue } from '../protocol/index.ts'

/**
 * An event as stored. Besides what the browser sent (`props`, untouched except for the
 * sanitizing rules), it carries a typed projection of the props (page, attribution,
 * engagement, ...), what the server derived from the request (`server`, per the data policy),
 * and retention dates.
 */
export interface StoredEvent extends EventProjection {
  siteKey: string
  eventId: string
  name: string
  /** Client time (not trusted). */
  occurredAt: string
  /** occurredAt corrected for client clock skew (receivedAt - sentAt); receivedAt if implausible. */
  occurredAtCorrected: string
  /** Client time the batch was sent (not trusted). */
  sentAt: string
  /** Server time the batch was received. */
  receivedAt: string
  sessionId: string
  pageViewId: string | null
  trackingCategory: 'full' | 'limited'
  consent: { required: boolean; granted: boolean }
  /** Event properties as received. */
  props: Record<string, PropValue>
  /** Browser origin that sent the event. */
  origin: string | null
  /** Data policy profile applied (by the visitor's region). */
  profile: string
  /** What the server derived from the request, at the levels the profile allows. */
  server?: ServerInfo
  /** The signed-in visitor (identity keys), from your authentication. Full events only. */
  identity?: Identity
  /** Repairs applied by the rules (e.g. `limited-props-removed`). */
  sanitized?: string[]
  /** Delete the event after this time (ISO 8601), from the profile's retention. */
  retainUntil?: string
  /** Remove `server.ip` after this time. */
  ipRetainUntil?: string
  /** Remove `server.userAgent.raw` after this time. */
  rawUserAgentRetainUntil?: string
}

export interface StoredConsent {
  /** Deterministic: identical (retried) records share it. */
  recordId: string
  siteKey: string
  consentId: string
  decision: 'granted' | 'denied' | 'partial'
  categories: { preferences: boolean; statistics: boolean; marketing: boolean } | null
  policyVersion: string
  /** Client time of the decision (not trusted). */
  decidedAt: string
  /** Server time the record was stored. */
  recordedAt: string
  source: 'banner' | 'api'
  origin: string | null
  /** Data policy profile applied (by the visitor's region). */
  profile: string
  /** Observations about the record (stored as received), e.g. `policy-version-not-current`. */
  annotations: string[]
  /** The signed-in visitor who decided (identity keys), when known. */
  identity?: Identity
  /** Delete the record after this time (ISO 8601), from the profile's retention. */
  retainUntil?: string
}

/** Traits of an identity, kept once per identity (not on every event). */
export interface StoredIdentity {
  siteKey: string
  /** The identity keys (what events and consent records carry). */
  identity: Identity
  traits: Identity
  /** When these traits were last seen (ISO 8601). */
  seenAt: string
}

export interface InsertEventsResult {
  /** Newly stored events. */
  inserted: number
  /** Events whose (siteKey, eventId) was already stored; not stored again. */
  duplicates: number
}

export interface InsertConsentResult {
  /** True if a record with this recordId already existed (a retry); it was not stored again. */
  duplicate: boolean
  /** `recordedAt` of the stored record (the original one for a duplicate). */
  recordedAt: string
}

/**
 * Where the collector writes. Implementations must be idempotent:
 * - `insertEvents`: `(siteKey, eventId)` is unique; repeats (also within one batch) are
 *   duplicates, not errors.
 * - `insertConsent`: `recordId` is unique; a repeat is a duplicate.
 * Throw on infrastructure failure (the collector answers 503 and clients retry).
 */
export interface CollectorStore {
  insertEvents(events: readonly StoredEvent[]): Promise<InsertEventsResult>
  insertConsent(record: StoredConsent): Promise<InsertConsentResult>
  /**
   * Record an identity's traits (latest values win; keep the first `seenAt` as first seen if
   * you like). Optional: without it, traits are not stored.
   */
  upsertIdentity?(record: StoredIdentity): Promise<void>
  /** Remove expired data (retention). Optional; see PurgeOptions. */
  purge?(options: PurgeOptions): Promise<PurgeResult>
  /** Everything stored about a person (data subject access). Optional. */
  exportSubject?(selector: SubjectSelector): Promise<SubjectData>
  /**
   * Erase a person's data: their events and identity records are deleted; their consent
   * records are kept as evidence but de-identified (identity removed). Optional.
   */
  eraseSubject?(selector: SubjectSelector): Promise<EraseResult>
  /** Resolve when the store is usable; throw otherwise (readiness checks). */
  health?(): Promise<void>
  close?(): Promise<void>
}

/**
 * Retention. Records are removed when their own dates have passed (`retainUntil`,
 * `ipRetainUntil`, `rawUserAgentRetainUntil` on or before `now`). `profiles` applies the
 * current data policy's (possibly shorter) limits to records already stored: anything of that
 * profile received before the cutoff goes too.
 */
export interface PurgeOptions {
  now: Date
  profiles?: ReadonlyArray<{
    profile: string
    eventsBefore?: Date
    ipBefore?: Date
    rawUserAgentBefore?: Date
    consentsBefore?: Date
  }>
}

export interface PurgeResult {
  eventsDeleted: number
  /** Events whose `server.ip` was removed. */
  ipsRemoved: number
  /** Events whose `server.userAgent.raw` was removed. */
  rawUserAgentsRemoved: number
  consentsDeleted: number
}

/**
 * Who a data subject request is about. Records matching any of the given criteria are
 * included (optionally limited to one site). `identity` matches records whose identity has
 * all the given keys and values, e.g. `{ userId: 'u-1' }`.
 */
export interface SubjectSelector {
  siteKey?: string
  identity?: Identity
  /** The browser's consent ID (from its consent records). */
  consentId?: string
  sessionId?: string
}

export interface SubjectData {
  events: StoredEvent[]
  consents: StoredConsent[]
  identities: StoredIdentity[]
}

export interface EraseResult {
  eventsDeleted: number
  consentsDeidentified: number
  identitiesDeleted: number
}

/** Throws unless the selector names at least one person-level criterion. */
export function assertSubjectSelector(selector: SubjectSelector): void {
  const hasIdentity = !!selector.identity && Object.keys(selector.identity).length > 0
  if (!hasIdentity && !selector.consentId && !selector.sessionId) {
    throw new Error('A subject selector needs identity, consentId or sessionId')
  }
}

export interface ListOptions {
  siteKey?: string
  limit?: number
}

/** Optional read access, in insertion order (development tools and tests; not the request path). */
export interface CollectorReader {
  listEvents(options?: ListOptions): Promise<StoredEvent[]>
  listConsents(options?: ListOptions): Promise<StoredConsent[]>
  listIdentities?(options?: ListOptions): Promise<StoredIdentity[]>
}
