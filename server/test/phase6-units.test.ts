// IPinfo, trusted proxy networks, and rate limiting (in memory).
import type { IncomingMessage } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import { geoFromIpinfo, ipinfoGeo, isNonPublicIp } from '../src/geo/ipinfo.ts'
import { networkMatcher, parseCidr } from '../src/http/cidr.ts'
import { toFetchHandler } from '../src/http/fetch.ts'
import { clientIpFrom, toNodeHandler } from '../src/http/node.ts'
import {
  createCollector,
  headerReader,
  memoryCache,
  memoryRateLimiter,
  memoryStore,
} from '../src/index.ts'

const request = (clientIp?: string) => ({ headers: headerReader({}), clientIp })

describe('IPinfo responses', () => {
  it('classic format (ipinfo.io/{ip}/json)', () => {
    expect(
      geoFromIpinfo({
        ip: '8.8.8.8',
        city: 'Mountain View',
        region: 'California',
        country: 'US',
        loc: '37.4056,-122.0775',
        org: 'AS15169 Google LLC',
        postal: '94043',
        timezone: 'America/Los_Angeles',
        privacy: { vpn: false, proxy: false, tor: false, relay: false, hosting: true, service: '' },
      }),
    ).toEqual({
      country: 'US',
      region: 'California',
      regionCode: 'US-CA',
      city: 'Mountain View',
      postalCode: '94043',
      latitude: 37.4056,
      longitude: -122.0775,
      timezone: 'America/Los_Angeles',
      asn: 'AS15169',
      org: 'Google LLC',
      privacy: { vpn: false, proxy: false, tor: false, relay: false, hosting: true },
    })
  })

  it('newer format (api.ipinfo.io lite and lookup)', () => {
    expect(
      geoFromIpinfo({
        ip: '81.2.69.142',
        asn: 'AS20712',
        as_name: 'Andrews & Arnold Ltd',
        country_code: 'GB',
        country: 'United Kingdom',
        continent_code: 'EU',
      }),
    ).toEqual({ country: 'GB', continent: 'EU', asn: 'AS20712', org: 'Andrews & Arnold Ltd' })
    expect(
      geoFromIpinfo({
        ip: '1.2.3.4',
        geo: {
          city: 'Toronto',
          region: 'Ontario',
          region_code: 'ON',
          country_code: 'CA',
          continent_code: 'NA',
          latitude: 43.7,
          longitude: -79.4,
          timezone: 'America/Toronto',
          postal_code: 'M5A',
        },
        as: { asn: 'AS812', name: 'Rogers' },
        is_hosting: false,
        is_anonymous: true,
      }),
    ).toEqual({
      country: 'CA',
      continent: 'NA',
      region: 'Ontario',
      regionCode: 'CA-ON',
      city: 'Toronto',
      postalCode: 'M5A',
      latitude: 43.7,
      longitude: -79.4,
      timezone: 'America/Toronto',
      asn: 'AS812',
      org: 'Rogers',
      privacy: { hosting: false, vpn: true },
    })
  })

  it('bogons, missing countries and region names without codes', () => {
    expect(geoFromIpinfo({ ip: '10.0.0.1', bogon: true })).toBeNull()
    expect(geoFromIpinfo({ ip: '1.2.3.4' })).toBeNull()
    expect(geoFromIpinfo({ country: 'DE', region: 'Berlin' })).toEqual({
      country: 'DE',
      region: 'Berlin',
    })
  })
})

describe('ipinfoGeo', () => {
  const fakeFetch = (body: unknown, status = 200) =>
    vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status }),
    )

  it('looks up public addresses (token in a header, not the URL) and caches the answer', async () => {
    const fetch = fakeFetch({ country: 'FR', city: 'Paris' })
    const geo = ipinfoGeo({ token: 'secret-token', fetch: fetch as typeof globalThis.fetch })
    expect(await geo(request('81.2.69.142'))).toEqual({ country: 'FR', city: 'Paris' })
    expect(await geo(request('81.2.69.142'))).toEqual({ country: 'FR', city: 'Paris' })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://ipinfo.io/81.2.69.142/json')
    expect(String(url)).not.toContain('secret-token')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
  })

  it('never looks up private or reserved addresses', async () => {
    const fetch = fakeFetch({ country: 'US' })
    const geo = ipinfoGeo({ token: 't', fetch: fetch as typeof globalThis.fetch })
    for (const ip of [
      '10.1.2.3',
      '192.168.1.1',
      '127.0.0.1',
      '172.20.0.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      undefined,
    ]) {
      expect(await geo(request(ip))).toBeNull()
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(isNonPublicIp('8.8.8.8')).toBe(false)
    expect(isNonPublicIp('2001:4860:4860::8888')).toBe(false)
  })

  it('errors and timeouts mean unknown (not cached); one warning a minute', async () => {
    const warn = vi.fn()
    const logger = { debug() {}, info() {}, error() {}, warn }
    const failing = ipinfoGeo({
      token: 't',
      fetch: fakeFetch({}, 429) as typeof globalThis.fetch,
      logger,
    })
    expect(await failing(request('81.2.69.142'))).toBeNull()
    expect(await failing(request('81.2.69.142'))).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    const slow = ipinfoGeo({
      token: 't',
      timeoutMs: 20,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
        )) as never,
    })
    expect(await slow(request('81.2.69.142'))).toBeNull()
  })

  it('a shared cache is used across instances; its keys never contain the address', async () => {
    const shared = memoryCache()
    const keys: string[] = []
    const spying = {
      get: shared.get,
      set: (k: string, v: string, t: number) => (keys.push(k), shared.set(k, v, t)),
    }
    const fetch = fakeFetch({ country: 'JP' })
    const options = {
      token: 't',
      fetch: fetch as typeof globalThis.fetch,
      cache: spying,
      cacheKeySecret: 'shared-secret',
    }
    await ipinfoGeo(options)(request('81.2.69.142'))
    expect(await ipinfoGeo(options)(request('81.2.69.142'))).toEqual({ country: 'JP' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(keys.join()).not.toContain('81.2.69')
  })

  it('unknown answers (bogon) are cached too', async () => {
    const fetch = fakeFetch({ bogon: true })
    const geo = ipinfoGeo({ token: 't', fetch: fetch as typeof globalThis.fetch })
    expect(await geo(request('81.2.69.142'))).toBeNull()
    expect(await geo(request('81.2.69.142'))).toBeNull()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('requires a token', () => {
    expect(() => ipinfoGeo({ token: '' })).toThrow(/token/)
  })
})

describe('trusted proxy networks', () => {
  it('CIDR matching for IPv4, IPv6 and IPv4-mapped addresses', () => {
    const trusted = networkMatcher(['10.0.0.0/8', '192.168.1.7', '2001:db8::/32'])
    expect(trusted('10.200.3.4')).toBe(true)
    expect(trusted('11.0.0.1')).toBe(false)
    expect(trusted('192.168.1.7')).toBe(true)
    expect(trusted('192.168.1.8')).toBe(false)
    expect(trusted('2001:db8:1::5')).toBe(true)
    expect(trusted('2001:db9::5')).toBe(false)
    expect(trusted('::ffff:10.1.1.1')).toBe(true)
    expect(trusted('not an ip')).toBe(false)
    for (const bad of ['10.0.0.0/33', 'x/8', '2001:db8::/129'])
      expect(() => parseCidr(bad)).toThrow()
  })

  it('the client is the right-most address that is not a trusted proxy', () => {
    const req = (remote: string, xff?: string) =>
      ({
        socket: { remoteAddress: remote },
        headers: xff ? { 'x-forwarded-for': xff } : {},
      }) as unknown as IncomingMessage
    const proxies = ['10.0.0.0/8', '172.16.0.0/12']
    expect(clientIpFrom(req('10.0.0.5', '203.0.113.9, 172.16.4.4'), proxies)).toBe('203.0.113.9')
    // A client-supplied X-Forwarded-For entry left of the real client is ignored.
    expect(clientIpFrom(req('10.0.0.5', '6.6.6.6, 203.0.113.9'), proxies)).toBe('203.0.113.9')
    // Not behind a trusted proxy: the socket address.
    expect(clientIpFrom(req('198.51.100.1', '6.6.6.6'), proxies)).toBe('198.51.100.1')
    // Only proxies: the left-most.
    expect(clientIpFrom(req('10.0.0.5', '10.0.0.6'), proxies)).toBe('10.0.0.6')
  })

  it('invalid networks fail when the handler is created', () => {
    const collector = createCollector({
      sites: [{ siteKey: 'my-site', allowedOrigins: ['https://a.example'] }],
      store: memoryStore(),
      logger: false,
    })
    expect(() => toNodeHandler(collector, { trustProxy: ['10.0.0.0/99'] })).toThrow(/prefix/)
  })
})

describe('rate limiting (memory)', () => {
  it('fixed windows', async () => {
    let now = 0
    const limiter = memoryRateLimiter({ clock: () => now })
    expect((await limiter.consume('k', 2, 1_000)).allowed).toBe(true)
    expect(await limiter.consume('k', 2, 1_000)).toEqual({
      allowed: true,
      remaining: 0,
      retryAfterMs: 0,
    })
    expect(await limiter.consume('k', 2, 1_000)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1_000,
    })
    now = 1_000
    expect((await limiter.consume('k', 2, 1_000)).allowed).toBe(true)
  })

  it('the collector answers 429 per IP (before reading the body) and per site', async () => {
    const readBody = vi.fn()
    const collector = createCollector({
      sites: [{ siteKey: 'my-site', allowedOrigins: ['https://a.example'] }],
      store: memoryStore(),
      logger: false,
      rateLimit: {
        limiter: memoryRateLimiter(),
        perIp: { limit: 1, windowMs: 60_000 },
        perSite: { limit: 2, windowMs: 60_000 },
      },
    })
    const post = (ip: string) =>
      collector.handle({
        method: 'POST',
        path: '/v1/events',
        query: new URLSearchParams(),
        headers: new Headers({ Origin: 'https://a.example', 'Content-Type': 'text/plain' }),
        clientIp: ip,
        readBody,
      })
    await post('203.0.113.1')
    readBody.mockClear()
    const limited = await post('203.0.113.1')
    expect(limited.status).toBe(429)
    expect(limited.headers['Retry-After']).toBe('60')
    expect(readBody).not.toHaveBeenCalled()

    const handle = toFetchHandler(collector, { getClientIp: () => undefined })
    const context = () => handle(new Request('http://x.test/v1/context?siteKey=my-site'))
    // (The POSTs above never reached the site lookup: their body could not be read.)
    expect([(await context()).status, (await context()).status, (await context()).status]).toEqual([
      200, 200, 429,
    ])
    expect((await handle(new Request('http://x.test/v1/health'))).status).toBe(200) // never limited
  })
})
