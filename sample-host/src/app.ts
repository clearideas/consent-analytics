// The reference collector: the collector library (../../server) mounted in a Hono app, with
// the development endpoints the playground and the end-to-end tests use.
//
// All collector behavior (contract, CORS, validation, rules, storage) comes from the library;
// this file only maps the sample host's configuration onto it.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Context as HonoContext } from 'hono'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

import { toFetchHandler } from '../../server/src/http/fetch.ts'
import type {
  CollectorStore,
  Geo,
  GeoResolver,
  MemoryStore,
  Site,
  SiteSource,
  StoredConsent,
  StoredEvent,
} from '../../server/src/index.ts'
import {
  balancedDataPolicy,
  chainGeo,
  createCollector,
  defineSite,
  fixedGeo,
  memoryStore,
  strictDataPolicy,
  trustedHeaderGeo,
} from '../../server/src/index.ts'
import { SPEC_VERSION } from '../../server/src/protocol/index.ts'
import type { ConsentMode, HostConfig } from './config.ts'

/** A store the development endpoints can read, reset and watch. */
export interface DevStore extends CollectorStore {
  listEvents(options?: { siteKey?: string; limit?: number }): Promise<StoredEvent[]>
  listConsents(options?: { siteKey?: string; limit?: number }): Promise<StoredConsent[]>
  clear(): void | Promise<void>
}

export type StoreChange =
  { type: 'event'; data: DevEvent } | { type: 'consent'; data: StoredConsent } | { type: 'reset' }

/** A stored event as the playground shows it (with flat consent fields, as before). */
export type DevEvent = StoredEvent & { consentRequired: boolean; consentGranted: boolean }
const devEvent = (event: StoredEvent): DevEvent => ({
  ...event,
  consentRequired: event.consent.required,
  consentGranted: event.consent.granted,
})

export interface AppOptions {
  config: HostConfig
  /** Default: in memory. */
  store?: DevStore
  /** Shown by /_dev/state, e.g. "SQLite (./data/analytics.db)". Default "memory". */
  storeLabel?: string
  now?: () => Date
}

const version = (packageJson: string) => {
  try {
    return (JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: string }).version
  } catch {
    return undefined
  }
}
const root = join(import.meta.dirname, '..', '..')
const VERSIONS = {
  library: version(join(root, 'package.json')),
  server: version(join(root, 'server', 'package.json')),
  spec: SPEC_VERSION,
}

export function createApp(options: AppOptions) {
  const { config } = options
  const inner: DevStore = options.store ?? (memoryStore() as MemoryStore)
  const changes = new EventEmitter()

  // Report what was stored to the live stream (/_dev/stream).
  const store: DevStore = {
    ...inner,
    async insertEvents(events) {
      const result = await inner.insertEvents(events)
      for (const event of events)
        changes.emit('change', { type: 'event', data: devEvent(event) } satisfies StoreChange)
      return result
    },
    async insertConsent(record) {
      const result = await inner.insertConsent(record)
      if (!result.duplicate)
        changes.emit('change', { type: 'consent', data: record } satisfies StoreChange)
      return result
    },
    listEvents: options => inner.listEvents(options),
    listConsents: options => inner.listConsents(options),
    clear: () => inner.clear(),
  }

  // Sites: changeable by /_dev/policy.
  const sites = new Map<string, Site>(config.sites.map(site => [site.siteKey, defineSite(site)]))
  const anySiteAllows = (origin: string) =>
    [...sites.values()].some(site => site.allowedOrigins.includes(origin))
  const siteSource: SiteSource = {
    getSite: siteKey => sites.get(siteKey) ?? null,
    isOriginAllowed: anySiteAllows,
  }

  // Geo: the development override, then trusted CDN headers, then the default country.
  let geoOverride: Geo | null = null
  const resolvers: GeoResolver[] = [() => geoOverride]
  resolvers.push(
    trustedHeaderGeo(config.trustedGeoHeaders, {
      // e.g. cf-ipcontinent: read as the continent, never as a country
      continentHeaders: config.trustedGeoHeaders.filter(h => h.includes('continent')),
    }),
  )
  if (config.defaultCountry) resolvers.push(fixedGeo({ country: config.defaultCountry }))

  const collector = createCollector({
    sites: siteSource,
    store,
    geo: chainGeo(...resolvers),
    // By default the reference collector stores what the browser sends, nothing more
    // (strict); `balanced` adds the server-side enrichment (for the playground's analytics).
    dataPolicy: (config.dataPolicy === 'balanced' ? balancedDataPolicy : strictDataPolicy)({
      consentCountries: [...config.consentCountries],
      ...(config.noTrackingWithoutConsentCountries?.size
        ? { noTrackingWithoutConsentCountries: [...config.noTrackingWithoutConsentCountries] }
        : {}),
    }),
    contextTtlSeconds: config.contextTtlSeconds,
    ...(options.now ? { clock: options.now } : {}),
    logger: false,
  })
  // The client IP is the socket address when served by @hono/node-server (the sample host is
  // not meant to run behind a proxy). The data policy decides whether it is stored.
  const clientIps = new WeakMap<Request, string>()
  const handle = toFetchHandler(collector, { getClientIp: request => clientIps.get(request) })

  const app = new Hono()
  app.all('/v1/*', c => {
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
    const ip = env?.incoming?.socket?.remoteAddress
    if (ip) clientIps.set(c.req.raw, ip)
    return handle(c.req.raw)
  })

  const problem = (c: HonoContext, status: 403 | 404, title: string) =>
    c.body(JSON.stringify({ type: 'about:blank', title, status }), status, {
      'Content-Type': 'application/problem+json',
    })

  if (config.devMode) {
    // The playground (another origin) calls these: CORS for the configured sites' origins.
    app.use('/_dev/*', async (c, next) => {
      const origin = c.req.header('Origin')
      const allowed = origin !== undefined && anySiteAllows(origin)
      if (c.req.method === 'OPTIONS') {
        if (!allowed) return problem(c, 403, 'Origin not allowed')
        return c.body(null, 204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        })
      }
      await next()
      c.res.headers.append('Vary', 'Origin')
      if (allowed) c.res.headers.set('Access-Control-Allow-Origin', origin)
      return undefined
    })
    // Development-only endpoints for the playground and end-to-end tests.
    // Not part of the contract. Never enable DEV_MODE in production.
    app.get('/_dev/events', async c =>
      c.json(
        (
          await store.listEvents({
            siteKey: c.req.query('siteKey'),
            limit: Number(c.req.query('limit') ?? 500),
          })
        ).map(devEvent),
      ),
    )
    app.get('/_dev/consents', async c =>
      c.json(await store.listConsents({ siteKey: c.req.query('siteKey') })),
    )
    app.get('/_dev/state', c =>
      c.json({
        geoOverride,
        sites: [...sites.values()].map(
          ({ siteKey, policyVersion, consentMode, trackingWithoutConsent }) => ({
            siteKey,
            policyVersion,
            consentMode,
            trackingWithoutConsent,
          }),
        ),
      }),
    )
    // What this collector is and how it is configured (the playground's environment card).
    app.get('/_dev/info', c =>
      c.json({
        versions: VERSIONS,
        dataPolicy: config.dataPolicy ?? 'strict',
        store: options.storeLabel ?? 'memory',
        trustedGeoHeaders: config.trustedGeoHeaders,
        defaultCountry: config.defaultCountry ?? null,
        consentCountries: [...config.consentCountries],
        noTrackingWithoutConsentCountries: [...(config.noTrackingWithoutConsentCountries ?? [])],
        contextTtlSeconds: config.contextTtlSeconds,
      }),
    )
    app.post('/_dev/geo', async c => {
      const body = (await c.req.json().catch(() => ({}))) as Geo
      geoOverride = body.country
        ? {
            country: body.country.toUpperCase(),
            ...(body.continent ? { continent: body.continent } : {}),
          }
        : null
      return c.json({ geoOverride })
    })
    app.post('/_dev/policy', async c => {
      const body = (await c.req.json().catch(() => ({}))) as {
        siteKey?: string
        policyVersion?: string
        consentMode?: ConsentMode
        trackingWithoutConsent?: 'limited' | 'none'
      }
      const site = sites.get(body.siteKey ?? '')
      if (!site) return problem(c, 404, 'Unknown site key')
      const updated = defineSite({
        ...site,
        ...(body.policyVersion ? { policyVersion: String(body.policyVersion) } : {}),
        ...(body.consentMode && ['geo', 'always', 'never'].includes(body.consentMode)
          ? { consentMode: body.consentMode }
          : {}),
        ...(body.trackingWithoutConsent === 'limited' || body.trackingWithoutConsent === 'none'
          ? { trackingWithoutConsent: body.trackingWithoutConsent }
          : {}),
      })
      sites.set(updated.siteKey, updated)
      return c.json({
        siteKey: updated.siteKey,
        policyVersion: updated.policyVersion,
        consentMode: updated.consentMode,
      })
    })
    app.post('/_dev/reset', async c => {
      await store.clear()
      geoOverride = null
      for (const original of config.sites) sites.set(original.siteKey, defineSite(original))
      changes.emit('change', { type: 'reset' } satisfies StoreChange)
      return c.json({ ok: true })
    })
    app.get('/_dev/stream', c =>
      streamSSE(c, async stream => {
        const onChange = (change: StoreChange) => {
          void stream.writeSSE({
            event: change.type,
            data: JSON.stringify('data' in change ? change.data : {}),
          })
        }
        changes.on('change', onChange)
        stream.onAbort(() => {
          changes.off('change', onChange)
        })
        await stream.writeSSE({ event: 'ready', data: '{}' })
        while (!stream.aborted) {
          await stream.sleep(15_000)
          if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '{}' })
        }
      }),
    )
  }

  app.notFound(c => problem(c, 404, 'Not found'))

  return { app, store, collector }
}
