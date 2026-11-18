// The Express middleware in real Express 5 and 4 apps: body parsers and cors() mounted
// before it, trust proxy, fall-through, errors, and identity from an auth middleware.
import cors from 'cors'
import express5 from 'express'
import express4 from 'express4'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExpressLikeRequest } from '../src/http/express.ts'
import { collectorMiddleware } from '../src/http/express.ts'
import type { Collector, CollectorOptions, GeoRequest } from '../src/index.ts'
import {
  createCollector,
  EVENTS_MAX_BYTES,
  fixedGeo,
  memoryStore,
  strictDataPolicy,
} from '../src/index.ts'
import { listen, rawRequest } from './support/transports.ts'

const ORIGIN = 'https://www.example.com'
const IDENTIFIED_ORIGIN = 'https://app.example.com'
const SITES = [
  { siteKey: 'public-site', allowedOrigins: [ORIGIN] },
  { siteKey: 'app-site', allowedOrigins: [IDENTIFIED_ORIGIN], credentials: true },
]

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

let seq = 0
const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: `event-${String(++seq).padStart(10, '0')}`,
  name: 'page_view',
  occurredAt: '2026-11-10T12:00:00.000Z',
  sessionId: 'session-0000001',
  trackingCategory: 'full',
  consent: { required: false, granted: false },
  props: { path: '/', userId: 'client-claimed' },
  ...overrides,
})
const batch = (siteKey: string, ...events: unknown[]) =>
  JSON.stringify({ v: 1, siteKey, sentAt: '2026-11-10T12:00:01.000Z', events })
const consentRecord = (siteKey: string) =>
  JSON.stringify({
    v: 1,
    siteKey,
    consentId: 'consent-0000001',
    decision: 'granted',
    policyVersion: '1',
    decidedAt: '2026-11-10T12:00:00.000Z',
    source: 'banner',
  })

function collector(overrides: Partial<CollectorOptions> = {}) {
  const store = memoryStore()
  return {
    store,
    collector: createCollector({
      sites: SITES,
      store,
      geo: fixedGeo({ country: 'US' }),
      logger: false,
      ...overrides,
    }),
  }
}

async function serve(app: Parameters<typeof listen>[0]) {
  const server = await listen(app)
  closers.push(server.close)
  return server.url
}

const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  rawRequest(url, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'text/plain;charset=UTF-8', ...headers },
    body,
  })

describe.each([
  ['Express 5', express5],
  ['Express 4', express4],
] as const)('%s', (_name, express) => {
  describe('body parsers mounted before the collector', () => {
    it('express.text() and express.json(): the parsed body is used', async () => {
      const { collector: c, store } = collector()
      const app = express()
      app.use(express.text())
      app.use(express.json())
      app.use('/analytics', collectorMiddleware(c))
      const url = await serve(app)

      const text = await post(`${url}/analytics/v1/events`, batch('public-site', event()))
      const json = await post(`${url}/analytics/v1/events`, batch('public-site', event()), {
        'Content-Type': 'application/json',
      })
      expect([text.status, json.status]).toEqual([202, 202])
      expect(await store.listEvents()).toHaveLength(2)
    })

    it('express.raw() (a Buffer) works; size limits still apply to parsed bodies', async () => {
      const { collector: c } = collector()
      const app = express()
      app.use(express.raw({ type: '*/*', limit: '1mb' }))
      app.use('/analytics', collectorMiddleware(c))
      const url = await serve(app)

      expect((await post(`${url}/analytics/v1/events`, batch('public-site', event()))).status).toBe(
        202,
      )
      const big = batch('public-site', event({ props: { pad: 'x'.repeat(EVENTS_MAX_BYTES) } }))
      expect((await post(`${url}/analytics/v1/events`, big)).status).toBe(413)
    })

    it('a body consumed without being parsed: 400 and one warning that says what to do', async () => {
      const warn = vi.fn()
      const { collector: c } = collector()
      const app = express()
      app.use((req, _res, next) => {
        req.resume() // drains the stream, leaves no body
        req.on('end', () => next())
      })
      app.use(
        '/analytics',
        collectorMiddleware(c, { logger: { debug() {}, info() {}, warn, error() {} } }),
      )
      const url = await serve(app)

      for (let i = 0; i < 2; i++) {
        expect(
          (await post(`${url}/analytics/v1/events`, batch('public-site', event()))).status,
        ).toBe(400)
      }
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]![1]).toMatch(/mount the collector before body parsers/)
    })
  })

  describe('a global cors() middleware', () => {
    it('never leaks its settings (credentials, wildcard, reflected origins) into collector responses', async () => {
      const { collector: c } = collector()
      const app = express()
      app.use(cors({ origin: true, credentials: true, exposedHeaders: ['X-Secret'] }))
      app.use('/analytics', collectorMiddleware(c))
      app.get('/api/me', (_req, res) => {
        res.json({ ok: true })
      })
      const url = await serve(app)

      const allowed = await post(`${url}/analytics/v1/events`, batch('public-site', event()))
      expect(allowed.status).toBe(202)
      expect(allowed.headers.get('access-control-allow-origin')).toBe(ORIGIN)
      expect(allowed.headers.get('access-control-allow-credentials')).toBeNull()
      expect(allowed.headers.get('access-control-expose-headers')).toBeNull()

      const foreign = await post(`${url}/analytics/v1/events`, batch('public-site', event()), {
        Origin: 'https://evil.example',
      })
      expect(foreign.status).toBe(403)
      expect(foreign.headers.get('access-control-allow-origin')).toBeNull()

      // The application's own routes keep the application's CORS settings.
      const own = await rawRequest(`${url}/api/me`, {
        method: 'GET',
        headers: { Origin: 'https://evil.example' },
      })
      expect(own.headers.get('access-control-allow-credentials')).toBe('true')
    })
  })

  it('a middleware that switches the body stream to flowing mode (old cors versions) loses nothing', async () => {
    const { collector: c, store } = collector()
    const app = express()
    app.use((req, _res, next) => {
      // What cors < 2.5 did around an asynchronous origin check.
      req.pause()
      req.resume()
      next()
    })
    app.use('/analytics', collectorMiddleware(c))
    const url = await serve(app)
    expect((await post(`${url}/analytics/v1/events`, batch('public-site', event()))).status).toBe(
      202,
    )
    expect(await store.listEvents()).toHaveLength(1)
  })

  it('uses req.ip (trust proxy) for the client IP', async () => {
    const seen: GeoRequest[] = []
    const { collector: c } = collector({ geo: request => (seen.push(request), { country: 'US' }) })
    const app = express()
    app.set('trust proxy', 1)
    app.use('/analytics', collectorMiddleware(c))
    const url = await serve(app)
    await rawRequest(`${url}/analytics/v1/context?siteKey=public-site`, {
      method: 'GET',
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    })
    expect(seen[0]!.clientIp).toBe('203.0.113.9')
  })

  it('other paths go on to the application, also when mounted at the root', async () => {
    const { collector: c } = collector()
    const app = express()
    app.use(collectorMiddleware(c))
    app.get('/v1/users', (_req, res) => {
      res.send('users')
    })
    const url = await serve(app)
    expect((await rawRequest(`${url}/v1/users`, { method: 'GET' })).text).toBe('users')
    expect((await rawRequest(`${url}/v1/health`, { method: 'GET' })).status).toBe(200)
  })

  it("an error escaping the collector goes to the application's error handler", async () => {
    const broken: Collector = {
      paths: ['/v1/health'],
      handle: async () => {
        throw new Error('boom')
      },
      close: async () => {},
      stats: () => ({ events: { mode: 'direct' }, consent: { mode: 'direct' } }),
    }
    const app = express()
    app.use(collectorMiddleware(broken))
    app.use((error: Error, _req: unknown, res: any, _next: unknown) => {
      res.status(502).send(error.message)
    })
    const url = await serve(app)
    const response = await rawRequest(`${url}/v1/health`, { method: 'GET' })
    expect([response.status, response.text]).toEqual([502, 'boom'])
  })

  describe('identity from an auth middleware', () => {
    type Req = ExpressLikeRequest & {
      user?: { id: string; account: string; plan: string; email: string }
    }

    /** A stand-in for your auth middleware: validates the cookie, sets req.user, never rejects. */
    const optionalAuth = (req: Req, _res: unknown, next: () => void) => {
      const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      if (sid === 'valid-session')
        req.user = { id: 'u-1', account: 'acct-9', plan: 'pro', email: 'a@b.example' }
      next()
    }

    async function app(
      overrides: Partial<CollectorOptions> = {},
      identify?: (req: Req) => unknown,
    ) {
      const { collector: c, store } = collector({ identity: { traits: ['plan'] }, ...overrides })
      const app = express()
      app.use(optionalAuth)
      app.use(
        '/analytics',
        collectorMiddleware<Req>(c, {
          identify:
            identify ??
            (req =>
              req.user
                ? { userId: req.user.id, accountId: req.user.account, plan: req.user.plan }
                : null),
        }),
      )
      return { url: await serve(app), store }
    }

    const signedIn = { Origin: IDENTIFIED_ORIGIN, Cookie: 'sid=valid-session' }

    it('full events and consent records of a credentialed site carry the identity; traits are kept once', async () => {
      const { url, store } = await app()
      const limited = event({
        trackingCategory: 'limited',
        consent: { required: false, granted: false },
        props: { path: '/' },
      })
      const response = await post(
        `${url}/analytics/v1/events`,
        batch('app-site', event(), limited),
        signedIn,
      )
      expect(response.status).toBe(202)
      expect(response.headers.get('access-control-allow-origin')).toBe(IDENTIFIED_ORIGIN)
      expect(response.headers.get('access-control-allow-credentials')).toBe('true')
      await post(`${url}/analytics/v1/consent`, consentRecord('app-site'), signedIn)

      const [full, anonymous] = await store.listEvents()
      expect(full!.identity).toEqual({ userId: 'u-1', accountId: 'acct-9' })
      expect(full!.props.userId).toBe('client-claimed') // a client-sent prop is never promoted
      expect(anonymous).not.toHaveProperty('identity') // never with limited events
      expect((await store.listConsents())[0]!.identity).toEqual({
        userId: 'u-1',
        accountId: 'acct-9',
      })
      expect(await store.listIdentities()).toEqual([
        {
          siteKey: 'app-site',
          identity: { userId: 'u-1', accountId: 'acct-9' },
          traits: { plan: 'pro' },
          seenAt: expect.any(String),
          firstSeenAt: expect.any(String),
        },
      ])
      expect(JSON.stringify(await store.listEvents())).not.toContain('plan":"pro') // traits not per event
    })

    it('a site without credentialed requests ignores cookies (even when identify would answer)', async () => {
      const { url, store } = await app()
      const response = await post(`${url}/analytics/v1/events`, batch('public-site', event()), {
        Cookie: 'sid=valid-session',
      })
      expect(response.headers.get('access-control-allow-credentials')).toBeNull()
      expect((await store.listEvents())[0]).not.toHaveProperty('identity')
    })

    it('anonymous visitors, a failing identify, and unknown names', async () => {
      const warn = vi.fn()
      const logger = { debug() {}, info() {}, warn, error() {} }
      const anonymous = await app()
      await post(`${anonymous.url}/analytics/v1/events`, batch('app-site', event()), {
        Origin: IDENTIFIED_ORIGIN,
      })
      expect((await anonymous.store.listEvents())[0]).not.toHaveProperty('identity')

      const failing = await app({ logger }, () => {
        throw new Error('session store down')
      })
      expect(
        (await post(`${failing.url}/analytics/v1/events`, batch('app-site', event()), signedIn))
          .status,
      ).toBe(202)
      expect((await failing.store.listEvents())[0]).not.toHaveProperty('identity')
      expect(warn).toHaveBeenCalledWith(expect.anything(), 'identify failed; treated as anonymous')

      const extra = await app({ logger }, req => ({ userId: req.user?.id, email: req.user?.email }))
      for (let i = 0; i < 2; i++)
        await post(`${extra.url}/analytics/v1/events`, batch('app-site', event()), signedIn)
      expect((await extra.store.listEvents())[0]!.identity).toEqual({ userId: 'u-1' })
      expect(JSON.stringify(await extra.store.listEvents())).not.toContain('a@b.example')
      expect(warn.mock.calls.filter(([fields]) => fields?.name === 'email')).toHaveLength(1)
    })

    it('custom identity keys; the profile decides for events, consent records are always linked', async () => {
      const { url, store } = await app(
        { identity: { keys: ['tenantId'] }, dataPolicy: strictDataPolicy() },
        req => (req.user ? { tenantId: req.user.account } : null),
      )
      await post(`${url}/analytics/v1/events`, batch('app-site', event()), signedIn)
      await post(`${url}/analytics/v1/consent`, consentRecord('app-site'), signedIn)
      expect((await store.listEvents())[0]).not.toHaveProperty('identity') // strict: identity not collected
      expect((await store.listConsents())[0]!.identity).toEqual({ tenantId: 'acct-9' })
    })

    it('consent records can be left unlinked', async () => {
      const { url, store } = await app({ identity: { consentRecords: false } })
      await post(`${url}/analytics/v1/consent`, consentRecord('app-site'), signedIn)
      expect((await store.listConsents())[0]).not.toHaveProperty('identity')
    })

    it('a failing traits upsert is reported but the batch is stored', async () => {
      const errors: string[] = []
      const { collector: c, store } = collector({
        identity: { traits: ['plan'] },
        hooks: { onError: (_e, { operation }) => errors.push(operation) },
      })
      store.upsertIdentity = async () => {
        throw new Error('identities table down')
      }
      const application = express()
      application.use(optionalAuth)
      application.use(
        '/analytics',
        collectorMiddleware<Req>(c, {
          identify: req => (req.user ? { userId: req.user.id, plan: req.user.plan } : null),
        }),
      )
      const url = await serve(application)
      expect(
        (await post(`${url}/analytics/v1/events`, batch('app-site', event()), signedIn)).status,
      ).toBe(202)
      expect(await store.listEvents()).toHaveLength(1)
      expect(errors).toEqual(['store.upsertIdentity'])
    })
  })
})

describe('preflight for credentialed sites', () => {
  it('allows credentials only for origins of credentialed sites', async () => {
    const { collector: c } = collector()
    const app = express5()
    app.use(collectorMiddleware(c))
    const url = await serve(app)
    const preflight = (origin: string) =>
      rawRequest(`${url}/v1/events`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      })
    expect(
      (await preflight(IDENTIFIED_ORIGIN)).headers.get('access-control-allow-credentials'),
    ).toBe('true')
    expect((await preflight(ORIGIN)).headers.get('access-control-allow-credentials')).toBeNull()
  })
})
