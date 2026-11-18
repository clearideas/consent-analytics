// The collector: the HTTP contract of spec/openapi.yaml (v1), independent of any framework.
// Transport adapters (node:http, fetch, Express) turn requests into CollectorRequest and
// write back the CollectorResponse.
//
//   route ► CORS ► media type ► body limit ► JSON ► site ► origin ► schema
//         ► geo ► data policy profile ► rules ► normalize ► enrich ► deliver ► response
//
// Delivery (per endpoint): direct to the store, buffered in process, or through a queue to a
// worker (src/delivery).
import { createHash, createHmac, randomUUID } from 'node:crypto'

import type { IngestMessage } from '../delivery/messages.ts'
import { MESSAGE_VERSION } from '../delivery/messages.ts'
import { createIngestProcessor } from '../delivery/processor.ts'
import type { DeliveryOptions, DeliveryStats } from '../delivery/sinks.ts'
import { createSink } from '../delivery/sinks.ts'
import { collectServerInfo, ipHasher, requestFacts } from '../enrich/index.ts'
import type { Geo, GeoResolver } from '../geo/index.ts'
import { normalizeGeo } from '../geo/index.ts'
import type { IdentityOptions, ResolvedIdentity } from '../identity/index.ts'
import { identityConfig, sanitizeIdentity } from '../identity/index.ts'
import { normalizeEvent } from '../normalize/index.ts'
import type { DataPolicy, DataPolicyDocument, Profile } from '../policy/index.ts'
import {
  addDuration,
  balancedDataPolicy,
  compileDataPolicy,
  contextPolicy,
} from '../policy/index.ts'
import type {
  ConsentRecordRequest,
  Event,
  EventBatch,
  FieldError,
  SchemaName,
} from '../protocol/index.ts'
import {
  CONSENT_MAX_BYTES,
  EVENTS_MAX_BYTES,
  SITE_KEY_PATTERN,
  validate,
} from '../protocol/index.ts'
import type { RateLimiter, RateLimitRule } from '../ratelimit/index.ts'
import type { RulesOptions } from '../rules/index.ts'
import { annotateConsent, createRules } from '../rules/index.ts'
import type { Site, SiteInput, SiteSource } from '../sites/index.ts'
import { staticSites } from '../sites/index.ts'
import type { CollectorStore, StoredConsent, StoredEvent } from '../storage/types.ts'
import type { CollectorRequest, CollectorResponse } from './http.ts'
import { BodyTooLargeError } from './http.ts'
import type { Logger } from './logger.ts'
import { consoleLogger, errorFields, silentLogger } from './logger.ts'
import { consentRecordId } from './record-id.ts'

export interface CollectorHooks {
  /** A dependency (store, site source) failed, or an unexpected error occurred. */
  onError?(error: unknown, context: { operation: string; requestId: string }): void
}

export interface CollectorOptions {
  /** Site definitions, or a SiteSource (e.g. a database-backed one). */
  sites: SiteSource | readonly SiteInput[]
  /** Where events and consent records are written. Optional only if both endpoints are queued. */
  store?: CollectorStore
  /**
   * How each endpoint's data reaches the store. Default `{ mode: 'direct' }` for both.
   * See DeliveryOptions: direct, buffered (in process), queued (with a worker).
   */
  delivery?: { events?: DeliveryOptions; consent?: DeliveryOptions }
  /** On close(), how long buffered data may take to be written. Default 10 s. */
  flushTimeoutMs?: number
  /** Visitor location. Default: unknown, so consent is required everywhere. */
  geo?: GeoResolver
  /**
   * Per-region profiles: consent requirement, what is stored, retention. A policy document
   * (see schemas/data-policy.schema.json, `balancedDataPolicy()`, `strictDataPolicy()`) or a
   * compiled one. Default: `balancedDataPolicy()`.
   */
  dataPolicy?: DataPolicyDocument | DataPolicy
  /** Event rules: `{ preset: 'standard' | 'strict' | 'off', custom, ... }`. Default standard. */
  rules?: RulesOptions
  /** Secret for hashed IP addresses (profiles with `ip: "hashed"`); at least 16 characters. */
  hashSecret?: string
  /**
   * The signed-in visitor, from your authentication, for sites with `credentials: true`.
   * Adapters can supply it per request instead (Express middleware option `identify`).
   */
  identify?: (request: CollectorRequest) => unknown
  /** Which identity keys and traits are stored. Default keys: userId, accountId. */
  identity?: IdentityOptions
  /**
   * Rate limits (429 with Retry-After). `perIp` is checked before the body is read; `perSite`
   * once the site is known. Use a Redis limiter to share limits between instances. If the
   * limiter fails, requests are allowed (`onError: 'allow'`, default) or refused with 503.
   */
  rateLimit?: {
    limiter: RateLimiter
    perIp?: RateLimitRule
    perSite?: RateLimitRule
    onError?: 'allow' | 'reject'
  }
  /** How long browsers may cache `GET /v1/context` (0 to 86400). Default 3600. */
  contextTtlSeconds?: number
  /** `Retry-After` sent with 503 responses. Default 5. */
  retryAfterSeconds?: number
  /** Clock (tests). */
  clock?: () => Date
  /** Your logger (pino-compatible), or false for none. Default: warnings and errors on stderr. */
  logger?: Logger | false
  hooks?: CollectorHooks
}

export interface Collector {
  handle(request: CollectorRequest): Promise<CollectorResponse>
  /** Paths the collector answers (relative to where it is mounted). */
  readonly paths: readonly string[]
  /** Write what is buffered (up to flushTimeoutMs), then close the store. Adapters call this on shutdown. */
  close(): Promise<void>
  /** Delivery state per endpoint (buffered, written, lost, ...). */
  stats(): { events: DeliveryStats; consent: DeliveryStats }
}

// --- responses ------------------------------------------------------------------------

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff' }

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): CollectorResponse {
  return {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

/** An RFC 9457 problem response, thrown inside handlers. */
class HttpProblem extends Error {
  readonly status: number
  readonly title: string
  readonly detail: string | undefined
  readonly errors: FieldError[] | undefined
  readonly headers: Record<string, string>

  constructor(
    status: number,
    title: string,
    detail?: string,
    errors?: FieldError[],
    headers: Record<string, string> = {},
  ) {
    super(title)
    this.status = status
    this.title = title
    this.detail = detail
    this.errors = errors
    this.headers = headers
  }

  toResponse(): CollectorResponse {
    return {
      status: this.status,
      headers: { ...BASE_HEADERS, 'Content-Type': 'application/problem+json', ...this.headers },
      body: JSON.stringify({
        type: 'about:blank',
        title: this.title,
        status: this.status,
        ...(this.detail ? { detail: this.detail } : {}),
        ...(this.errors?.length ? { errors: this.errors } : {}),
      }),
    }
  }
}

const ACCEPTED_MEDIA_TYPES = new Set(['application/json', 'text/plain'])
const decoder = new TextDecoder('utf-8', { fatal: true })

interface RequestContext {
  request: CollectorRequest
  requestId: string
  origin: string | undefined
}

type Route = { method: 'GET' | 'POST'; handle(context: RequestContext): Promise<CollectorResponse> }

// --- collector ------------------------------------------------------------------------

export function createCollector(options: CollectorOptions): Collector {
  const sites: SiteSource = Array.isArray(options.sites)
    ? staticSites(options.sites)
    : (options.sites as SiteSource)
  const { store } = options
  if (
    store !== undefined &&
    (typeof store?.insertEvents !== 'function' || typeof store.insertConsent !== 'function')
  ) {
    throw new TypeError('createCollector: `store` must implement insertEvents and insertConsent')
  }
  const dataPolicy: DataPolicy =
    options.dataPolicy && 'select' in options.dataPolicy
      ? options.dataPolicy
      : compileDataPolicy(options.dataPolicy ?? balancedDataPolicy())
  if (dataPolicy.usesHashedIp && !options.hashSecret) {
    throw new Error('createCollector: the data policy stores hashed IP addresses; set `hashSecret`')
  }
  const hashIp = options.hashSecret ? ipHasher(options.hashSecret) : undefined
  const applyRules = createRules(options.rules)
  const flushTimeoutMs = options.flushTimeoutMs ?? 10_000
  const identity = identityConfig(options.identity)
  const warnedIdentityNames = new Set<string>()
  const contextTtlSeconds = options.contextTtlSeconds ?? 3600
  if (!Number.isInteger(contextTtlSeconds) || contextTtlSeconds < 0 || contextTtlSeconds > 86_400) {
    throw new RangeError('createCollector: contextTtlSeconds must be an integer from 0 to 86400')
  }
  const retryAfter = String(options.retryAfterSeconds ?? 5)
  const clock = options.clock ?? (() => new Date())
  const logger = options.logger === false ? silentLogger : (options.logger ?? consoleLogger())
  const hooks = options.hooks ?? {}

  /** Call a user hook; a failing hook is logged and never breaks the response. */
  const reportError = (error: unknown, context: { operation: string; requestId: string }) => {
    try {
      hooks.onError?.(error, context)
    } catch (hookError) {
      logger.error(
        { ...errorFields(hookError), requestId: context.requestId },
        'onError hook failed',
      )
    }
  }

  /** Run a dependency call; failures become 503 so clients retry later. */
  const dependency = async <T>(
    context: RequestContext,
    operation: string,
    call: () => T | Promise<T>,
  ): Promise<T> => {
    try {
      return await call()
    } catch (error) {
      logger.error(
        { ...errorFields(error), operation, requestId: context.requestId },
        `${operation} failed`,
      )
      reportError(error, { operation, requestId: context.requestId })
      throw new HttpProblem(503, 'Service unavailable', 'Please retry later.', undefined, {
        'Retry-After': retryAfter,
      })
    }
  }

  const findSite = async (context: RequestContext, siteKey: string): Promise<Site> => {
    const site = await dependency(context, 'sites.getSite', () => sites.getSite(siteKey))
    if (!site) throw new HttpProblem(404, 'Unknown site key')
    await enforceRateLimit(context, `site:${site.siteKey}`, options.rateLimit?.perSite)
    return site
  }

  /** The visitor's location; null when unknown (no resolver, no answer, or a failure). */
  const processor = store
    ? createIngestProcessor({ store, logger, onError: (e, c) => reportError(e, c) })
    : undefined
  const sinkFor = (endpoint: 'events' | 'consent') => {
    try {
      return createSink(options.delivery?.[endpoint] ?? { mode: 'direct' }, {
        processor,
        logger,
        onError: (e, c) => reportError(e, c),
      })
    } catch (error) {
      throw new Error(`createCollector: delivery.${endpoint}: ${(error as Error).message}`)
    }
  }
  const sinks = { events: sinkFor('events'), consent: sinkFor('consent') }

  /** Hand a message to its endpoint's sink; failures become 503 so clients retry. */
  const deliver = (context: RequestContext, message: IngestMessage) => {
    const sink = message.kind === 'events' ? sinks.events : sinks.consent
    return dependency(context, sink.operation(message), () => sink.deliver(message))
  }

  const resolveGeo = async (context: RequestContext): Promise<Geo | null> => {
    if (!options.geo) return null
    try {
      return normalizeGeo(
        await options.geo({ headers: context.request.headers, clientIp: context.request.clientIp }),
      )
    } catch (error) {
      // Fail closed: an unknown region requires consent.
      logger.warn({ ...errorFields(error), requestId: context.requestId }, 'geo lookup failed')
      return null
    }
  }

  /**
   * Rate limit keys never contain a raw IP address: HMAC with hashSecret, or (without one)
   * SHA-256, which is pseudonymous but stable across instances.
   */
  const ipKey = (ip: string) =>
    options.hashSecret
      ? createHmac('sha256', options.hashSecret).update(ip).digest('base64url').slice(0, 22)
      : createHash('sha256').update(`consent-analytics/ip/${ip}`).digest('base64url').slice(0, 22)

  const enforceRateLimit = async (
    context: RequestContext,
    key: string,
    rule: RateLimitRule | undefined,
  ) => {
    const limits = options.rateLimit
    if (!limits || !rule) return
    let result
    try {
      result = await limits.limiter.consume(key, rule.limit, rule.windowMs)
    } catch (error) {
      logger.error({ ...errorFields(error), requestId: context.requestId }, 'rate limiter failed')
      reportError(error, { operation: 'rateLimit.consume', requestId: context.requestId })
      if (limits.onError === 'reject') {
        throw new HttpProblem(503, 'Service unavailable', 'Please retry later.', undefined, {
          'Retry-After': retryAfter,
        })
      }
      return
    }
    if (!result.allowed) {
      throw new HttpProblem(429, 'Too many requests', undefined, undefined, {
        'Retry-After': String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
      })
    }
  }

  /** Retention date `from` plus the profile's duration, if it has one. */
  const retainUntil = (from: Date, duration: Profile['retention']['events']) =>
    duration ? addDuration(from, duration).toISOString() : undefined

  /**
   * The signed-in visitor, for credentialed sites only (otherwise cookies are ignored, even
   * those sendBeacon attaches). A failing `identify` means anonymous, never an error.
   */
  const resolveIdentity = async (
    context: RequestContext,
    site: Site,
  ): Promise<ResolvedIdentity | undefined> => {
    if (!site.credentials) return undefined
    const { request } = context
    const identify =
      request.identify ?? (options.identify ? () => options.identify!(request) : undefined)
    if (!identify) return undefined
    try {
      return sanitizeIdentity(await identify(), identity, logger, warnedIdentityNames)
    } catch (error) {
      logger.warn(
        { ...errorFields(error), requestId: context.requestId },
        'identify failed; treated as anonymous',
      )
      return undefined
    }
  }

  const requireOrigin = (context: RequestContext, site: Site, required: boolean) => {
    const { origin } = context
    if (!origin && !required) return
    if (!origin || !site.allowedOrigins.includes(origin)) {
      throw new HttpProblem(
        403,
        'Origin not allowed',
        `Origin ${origin ?? '(none)'} is not allowed for this site.`,
      )
    }
  }

  /** Shared POST handling: media type, size, JSON, site, origin, schema. */
  const readPost = async <T extends { siteKey: string }>(
    context: RequestContext,
    schema: SchemaName,
    limit: number,
  ): Promise<{ body: T; site: Site }> => {
    const { request } = context
    const mediaType = (request.headers.get('content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase()
    if (!ACCEPTED_MEDIA_TYPES.has(mediaType)) {
      throw new HttpProblem(415, 'Unsupported media type', 'Send application/json or text/plain.')
    }
    const declared = Number(request.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limit)
      throw new HttpProblem(413, 'Payload too large')

    let bytes: Uint8Array
    try {
      bytes = await request.readBody(limit)
    } catch (error) {
      if (error instanceof BodyTooLargeError) throw new HttpProblem(413, 'Payload too large')
      throw new HttpProblem(400, 'Could not read the request body')
    }
    let body: any
    try {
      body = JSON.parse(decoder.decode(bytes))
    } catch {
      throw new HttpProblem(400, 'Malformed JSON')
    }

    const siteKey = body?.siteKey
    if (typeof siteKey !== 'string' || !SITE_KEY_PATTERN.test(siteKey)) {
      throw new HttpProblem(400, 'Invalid request', undefined, [
        { path: '/siteKey', message: 'must be a valid site key' },
      ])
    }
    const site = await findSite(context, siteKey)
    requireOrigin(context, site, true)

    const errors = validate(schema, body)
    if (errors.length) throw new HttpProblem(400, 'Invalid request', undefined, errors)
    return { body: body as T, site }
  }

  const routes: Record<string, Route> = {
    '/v1/health': {
      method: 'GET',
      handle: async () => json(200, { status: 'ok' }, { 'Cache-Control': 'no-store' }),
    },

    '/v1/context': {
      method: 'GET',
      async handle(context) {
        const siteKey = context.request.query.get('siteKey')
        if (!siteKey || !SITE_KEY_PATTERN.test(siteKey)) {
          throw new HttpProblem(400, 'Invalid request', undefined, [
            { path: 'siteKey', message: 'query parameter must be a valid site key' },
          ])
        }
        const site = await findSite(context, siteKey)
        requireOrigin(context, site, false)

        const geo = await resolveGeo(context)
        const policy = contextPolicy(site, dataPolicy.select(geo), !!geo)
        return json(
          200,
          {
            v: 1,
            siteKey,
            policy,
            // The contract allows nothing finer than the country here.
            ...(geo
              ? {
                  geo: {
                    country: geo.country,
                    ...(geo.continent ? { continent: geo.continent } : {}),
                  },
                }
              : {}),
            ttlSeconds: contextTtlSeconds,
          },
          { 'Cache-Control': 'private, no-store' },
        )
      },
    },

    '/v1/events': {
      method: 'POST',
      async handle(context) {
        const { body, site } = await readPost<EventBatch>(context, 'EventBatch', EVENTS_MAX_BYTES)
        const received = clock()
        const receivedAt = received.toISOString()
        const geo = await resolveGeo(context)
        const profile = dataPolicy.select(geo)
        const policy = contextPolicy(site, profile, !!geo)

        // What the server derives from this request, at the profile's levels. Computed once
        // for full and once for limited events (never an IP address or identity for those).
        const facts = requestFacts(context.request.headers, context.request.clientIp)
        const fullCollection = facts.gpc
          ? profile.collect.fullWithGlobalPrivacyControl
          : profile.collect.full
        const server = {
          full: collectServerInfo(facts, geo, fullCollection, {
            category: 'full',
            hashIp,
            receivedAt: received,
          }),
          limited: collectServerInfo(facts, geo, profile.collect.limited, {
            category: 'limited',
            receivedAt: received,
          }),
        }
        const ruleContext = {
          site,
          consentRequired: policy.consentRequired,
          nothingWithoutConsent: policy.trackingWithoutConsent === 'none',
          receivedAt: received,
          sentAt: body.sentAt,
        }
        const eventRetention = retainUntil(received, profile.retention.events)
        const visitor = fullCollection.identity ? await resolveIdentity(context, site) : undefined
        let identified = false

        const valid: StoredEvent[] = []
        const rejected: Array<{ index: number; eventId?: string; errors: FieldError[] }> = []
        body.events.forEach((item, index) => {
          const eventId = (item as { eventId?: unknown }).eventId
          const reject = (errors: FieldError[]) =>
            rejected.push({
              index,
              ...(typeof eventId === 'string' ? { eventId: eventId.slice(0, 64) } : {}),
              errors,
            })
          const errors = validate('Event', item)
          if (errors.length) {
            reject(errors)
            return
          }
          // NUL characters cannot be stored by MongoDB (in keys) or Postgres (anywhere).
          const cleaned = withoutNulCharacters(item as unknown as Event)
          const outcome = applyRules(cleaned.event, ruleContext)
          if (!outcome.keep) {
            reject([outcome.error])
            return
          }
          const { event } = outcome
          const sanitized = [
            ...(cleaned.changed ? ['nul-characters-removed'] : []),
            ...outcome.sanitized,
          ]
          const full = event.trackingCategory === 'full'
          if (full && fullCollection.clientPropsDeny.length) {
            for (const key of fullCollection.clientPropsDeny) {
              if (key in event.props) {
                delete event.props[key]
                if (!sanitized.includes('client-props-denied'))
                  sanitized.push('client-props-denied')
              }
            }
          }
          const serverInfo = full ? server.full : server.limited
          const stored: StoredEvent = {
            siteKey: site.siteKey,
            eventId: event.eventId,
            name: event.name,
            occurredAt: event.occurredAt,
            occurredAtCorrected: outcome.occurredAtCorrected,
            sentAt: body.sentAt,
            receivedAt,
            sessionId: event.sessionId,
            pageViewId: event.pageViewId ?? null,
            trackingCategory: event.trackingCategory,
            consent: { required: event.consent.required, granted: event.consent.granted },
            props: event.props,
            ...normalizeEvent(event.name, event.props),
            origin: context.origin ?? null,
            profile: profile.name,
            ...(serverInfo ? { server: serverInfo } : {}),
            // Identity only with full events (spec MUST).
            ...(full && visitor ? { identity: { ...visitor.identity } } : {}),
            ...(sanitized.length ? { sanitized } : {}),
            ...(eventRetention ? { retainUntil: eventRetention } : {}),
          }
          if (serverInfo?.ip && profile.retention.ip) {
            stored.ipRetainUntil = retainUntil(received, profile.retention.ip)
          }
          if (serverInfo?.userAgent?.raw && profile.retention.rawUserAgent) {
            stored.rawUserAgentRetainUntil = retainUntil(received, profile.retention.rawUserAgent)
          }
          if (full && visitor) identified = true
          valid.push(stored)
        })

        let counts = { inserted: 0, duplicates: 0 }
        if (valid.length) {
          const delivered = await deliver(context, {
            kind: 'events',
            v: MESSAGE_VERSION,
            requestId: context.requestId,
            siteKey: site.siteKey,
            events: valid,
            // Traits, once per identity (secondary: a failure is reported, the batch stands).
            ...(identified && visitor?.traits
              ? {
                  identity: {
                    identity: visitor.identity,
                    traits: visitor.traits,
                    seenAt: receivedAt,
                  },
                }
              : {}),
          })
          // Written before responding: real counts. Otherwise accepted for storage; duplicates
          // are only recognised when written (spec 1.1).
          counts = delivered?.events ?? { inserted: valid.length, duplicates: 0 }
        }
        return json(202, { accepted: counts.inserted, duplicates: counts.duplicates, rejected })
      },
    },

    '/v1/consent': {
      method: 'POST',
      async handle(context) {
        const { body, site } = await readPost<ConsentRecordRequest>(
          context,
          'ConsentRecordRequest',
          CONSENT_MAX_BYTES,
        )
        if (body.policyVersion.includes('\u0000')) {
          // Records are evidence and are not modified; this one could not be stored at all.
          throw new HttpProblem(400, 'Invalid request', undefined, [
            { path: '/policyVersion', message: 'must not contain NUL characters' },
          ])
        }
        const received = clock()
        const profile = dataPolicy.select(await resolveGeo(context))
        const consentRetention = retainUntil(received, profile.retention.consents)
        const visitor = identity.consentRecords ? await resolveIdentity(context, site) : undefined
        const record: StoredConsent = {
          recordId: consentRecordId(site.siteKey, body),
          siteKey: site.siteKey,
          consentId: body.consentId,
          decision: body.decision,
          categories: body.categories
            ? {
                preferences: body.categories.preferences,
                statistics: body.categories.statistics,
                marketing: body.categories.marketing,
              }
            : null,
          policyVersion: body.policyVersion,
          decidedAt: body.decidedAt,
          recordedAt: received.toISOString(),
          source: body.source,
          origin: context.origin ?? null,
          profile: profile.name,
          annotations: annotateConsent(body, site),
          ...(visitor ? { identity: { ...visitor.identity } } : {}),
          ...(consentRetention ? { retainUntil: consentRetention } : {}),
        }
        const delivered = await deliver(context, {
          kind: 'consent',
          v: MESSAGE_VERSION,
          requestId: context.requestId,
          record,
        })
        return json(201, {
          recordId: record.recordId,
          consentId: record.consentId,
          // A retried record written directly returns the original time.
          recordedAt: delivered?.consent?.recordedAt ?? record.recordedAt,
        })
      },
    },
  }

  const isOriginAllowed = async (origin: string | undefined): Promise<boolean> => {
    if (!origin) return false
    try {
      return await sites.isOriginAllowed(origin)
    } catch (error) {
      logger.error(
        { ...errorFields(error), operation: 'sites.isOriginAllowed' },
        'site lookup failed',
      )
      return false
    }
  }

  const isCredentialedOrigin = async (origin: string): Promise<boolean> => {
    try {
      return (await sites.isCredentialedOrigin?.(origin)) === true
    } catch (error) {
      logger.error(
        { ...errorFields(error), operation: 'sites.isCredentialedOrigin' },
        'site lookup failed',
      )
      return false
    }
  }

  /**
   * CORS for allowed origins on every response, errors included. Credentials are allowed only
   * for origins of sites with credentialed requests.
   */
  const withCors = async (response: CollectorResponse, origin: string | undefined) => {
    response.headers.Vary = 'Origin'
    if (origin && (await isOriginAllowed(origin))) {
      response.headers['Access-Control-Allow-Origin'] = origin
      if (await isCredentialedOrigin(origin)) {
        response.headers['Access-Control-Allow-Credentials'] = 'true'
      }
    }
    return response
  }

  return {
    paths: Object.keys(routes),

    async handle(request) {
      const requestId = sanitizeRequestId(request.headers.get('x-request-id')) ?? randomUUID()
      const origin = request.headers.get('origin') ?? undefined
      const context: RequestContext = { request, requestId, origin }
      const route = Object.hasOwn(routes, request.path) ? routes[request.path] : undefined
      let response: CollectorResponse

      if (request.method === 'OPTIONS') {
        if (!route) {
          response = new HttpProblem(404, 'Not found').toResponse()
        } else if (!(await isOriginAllowed(origin))) {
          response = new HttpProblem(403, 'Origin not allowed').toResponse()
        } else {
          response = {
            status: 204,
            headers: {
              'Access-Control-Allow-Methods': 'GET, POST',
              'Access-Control-Allow-Headers': 'Content-Type',
              'Access-Control-Max-Age': '86400',
            },
          }
        }
      } else if (!route) {
        response = new HttpProblem(404, 'Not found').toResponse()
      } else if (route.method !== request.method) {
        response = new HttpProblem(405, 'Method not allowed', undefined, undefined, {
          Allow: `${route.method}, OPTIONS`,
        }).toResponse()
      } else {
        try {
          if (request.clientIp && request.path !== '/v1/health') {
            await enforceRateLimit(
              context,
              `ip:${ipKey(request.clientIp)}`,
              options.rateLimit?.perIp,
            )
          }
          response = await route.handle(context)
        } catch (error) {
          if (error instanceof HttpProblem) {
            response = error.toResponse()
          } else {
            logger.error(
              { ...errorFields(error), requestId, path: request.path },
              'unexpected error',
            )
            reportError(error, { operation: request.path, requestId })
            response = new HttpProblem(500, 'Internal error').toResponse()
          }
        }
      }

      response.headers['X-Request-Id'] = requestId
      logger.debug(
        { requestId, method: request.method, path: request.path, status: response.status },
        'request',
      )
      return withCors(response, origin)
    },

    async close() {
      await Promise.all([sinks.events.close(flushTimeoutMs), sinks.consent.close(flushTimeoutMs)])
      await store?.close?.()
    },

    stats: () => ({ events: sinks.events.stats(), consent: sinks.consent.stats() }),
  }
}

/** Accept a caller-provided request ID only if it is short and printable. */
function sanitizeRequestId(value: string | null): string | undefined {
  return value && /^[\w.:-]{1,128}$/.test(value) ? value : undefined
}

/** A copy of the event with NUL characters removed from prop keys and string values. */
function withoutNulCharacters(event: Event): { event: Event; changed: boolean } {
  let changed = false
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (!value.includes('\u0000')) return value
      changed = true
      return value.replaceAll('\u0000', '')
    }
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        const cleanKey = key.includes('\u0000')
          ? ((changed = true), key.replaceAll('\u0000', ''))
          : key
        out[cleanKey] = clean(item)
      }
      return out
    }
    return value
  }
  const props = clean(event.props) as Event['props']
  return { event: changed ? { ...event, props } : event, changed }
}
