// Transport adapters: what the contract suite cannot see. Streaming body limits without
// Content-Length, client IPs behind proxies, mounting under a path, middleware fall-through,
// and graceful shutdown.
import type { IncomingMessage } from 'node:http'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { toFetchHandler } from '../src/http/fetch.ts'
import { clientIpFrom, createCollectorServer, toNodeHandler } from '../src/http/node.ts'
import type { Collector, GeoRequest } from '../src/index.ts'
import { createCollector, EVENTS_MAX_BYTES, memoryStore } from '../src/index.ts'
import { rawRequest } from './support/transports.ts'

const ORIGIN = 'https://www.example.com'
const SITES = [{ siteKey: 'example-site', allowedOrigins: [ORIGIN] }]

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function collector(overrides: Partial<Parameters<typeof createCollector>[0]> = {}) {
  return createCollector({ sites: SITES, store: memoryStore(), logger: false, ...overrides })
}

async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const batchOfSize = (bytes: number) =>
  JSON.stringify({
    v: 1,
    siteKey: 'example-site',
    sentAt: '2026-11-10T12:00:01.000Z',
    events: [{ pad: 'x'.repeat(bytes) }],
  })

describe('body size limit without Content-Length (streamed bodies)', () => {
  it('fetch handler: stops reading and answers 413', async () => {
    const handle = toFetchHandler(collector())
    const body = new TextEncoder().encode(batchOfSize(1_000_000))
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= body.length) return controller.close()
        controller.enqueue(body.subarray(pulled, pulled + 8192))
        pulled += 8192
      },
    })
    const response = await handle(
      new Request('http://collector.test/v1/events', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    )
    expect(response.status).toBe(413)
    // Reading stopped soon after the limit (allowing for stream read-ahead), not at 1 MB.
    expect(pulled).toBeLessThan(EVENTS_MAX_BYTES * 2)
  })

  it('node handler: a chunked body over the limit gets 413 and the connection is closed', async () => {
    const { url } = await startServer(collector())
    const target = new URL(url)
    const response = await new Promise<{ status: number; connection?: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: target.hostname,
            port: target.port,
            path: '/v1/events',
            method: 'POST',
            headers: {
              Origin: ORIGIN,
              'Content-Type': 'text/plain',
              'Transfer-Encoding': 'chunked',
            },
          },
          res => {
            res.resume()
            resolve({ status: res.statusCode!, connection: res.headers.connection })
          },
        )
        req.on('error', error =>
          (error as NodeJS.ErrnoException).code === 'EPIPE' ? undefined : reject(error),
        )
        const body = Buffer.from(batchOfSize(EVENTS_MAX_BYTES + 10_000))
        for (let i = 0; i < body.length; i += 4096) req.write(body.subarray(i, i + 4096))
        req.end()
      },
    )
    expect(response).toEqual({ status: 413, connection: 'close' })
  })

  it('a declared Content-Length over the limit is refused before reading', async () => {
    const readBody = vi.fn()
    const response = await collector().handle({
      method: 'POST',
      path: '/v1/events',
      query: new URLSearchParams(),
      headers: new Headers({
        Origin: ORIGIN,
        'Content-Type': 'text/plain',
        'Content-Length': '999999',
      }),
      readBody,
    })
    expect(response.status).toBe(413)
    expect(readBody).not.toHaveBeenCalled()
  })

  it('a body that cannot be read (client went away) is a 400, not a crash', async () => {
    const response = await collector().handle({
      method: 'POST',
      path: '/v1/events',
      query: new URLSearchParams(),
      headers: new Headers({ Origin: ORIGIN, 'Content-Type': 'text/plain' }),
      readBody: async () => {
        throw new Error('aborted')
      },
    })
    expect(response.status).toBe(400)
  })
})

async function startServer(
  c: Collector,
  options: Parameters<typeof createCollectorServer>[1] = {},
) {
  const server = createCollectorServer(c, { port: 0, host: '127.0.0.1', ...options })
  const address = await server.listen()
  cleanups.push(() => server.close())
  return { ...address, server }
}

describe('client IP (trustProxy)', () => {
  const req = (remoteAddress: string | undefined, forwarded?: string | string[]) =>
    ({
      socket: { remoteAddress },
      headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    }) as unknown as IncomingMessage

  it('uses the socket address unless proxies are trusted', () => {
    expect(clientIpFrom(req('10.0.0.1', '1.1.1.1'))).toBe('10.0.0.1')
    expect(clientIpFrom(req('10.0.0.1', '1.1.1.1'), 0)).toBe('10.0.0.1')
    expect(clientIpFrom(req('::ffff:192.0.2.7'))).toBe('192.0.2.7')
    expect(clientIpFrom(req('2001:db8::1'))).toBe('2001:db8::1')
  })

  it('trusts N proxies: the address N hops from the right', () => {
    // client 203.0.113.9 -> CDN 198.51.100.2 -> load balancer 10.0.0.1 -> server
    const behindTwo = req('10.0.0.1', '203.0.113.9, 198.51.100.2')
    expect(clientIpFrom(behindTwo, 1)).toBe('198.51.100.2')
    expect(clientIpFrom(behindTwo, 2)).toBe('203.0.113.9')
    // A client-supplied X-Forwarded-For entry cannot move the result past the trusted hops.
    const spoofed = req('10.0.0.1', '6.6.6.6, 203.0.113.9, 198.51.100.2')
    expect(clientIpFrom(spoofed, 2)).toBe('203.0.113.9')
    // More trusted hops than addresses: the left-most one.
    expect(clientIpFrom(req('10.0.0.1', '203.0.113.9'), 5)).toBe('203.0.113.9')
    expect(clientIpFrom(req('10.0.0.1', ['203.0.113.9', '198.51.100.2']), 1)).toBe('198.51.100.2')
  })

  it('trustProxy: true takes the left-most address', () => {
    expect(clientIpFrom(req('10.0.0.1', '203.0.113.9, 198.51.100.2'), true)).toBe('203.0.113.9')
    expect(clientIpFrom(req('10.0.0.1'), true)).toBe('10.0.0.1')
  })

  it('the geo resolver receives the client IP from the node server', async () => {
    const seen: GeoRequest[] = []
    const { url } = await startServer(
      collector({ geo: request => (seen.push(request), { country: 'US' }) }),
      { trustProxy: 1 },
    )
    const response = await rawRequest(`${url}/v1/context?siteKey=example-site`, {
      method: 'GET',
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    })
    expect(response.status).toBe(200)
    expect(seen[0]!.clientIp).toBe('203.0.113.9')
  })

  it('the fetch handler passes the IP from getClientIp', async () => {
    const seen: GeoRequest[] = []
    const handle = toFetchHandler(collector({ geo: request => (seen.push(request), null) }), {
      getClientIp: () => '192.0.2.1',
    })
    await handle(new Request('http://collector.test/v1/context?siteKey=example-site'))
    expect(seen[0]!.clientIp).toBe('192.0.2.1')
  })
})

describe('mounting', () => {
  it('fetch handler: only answers under its base path', async () => {
    const handle = toFetchHandler(collector(), { basePath: '/analytics/' })
    expect((await handle(new Request('http://x.test/analytics/v1/health'))).status).toBe(200)
    expect((await handle(new Request('http://x.test/v1/health'))).status).toBe(404)
    expect((await handle(new Request('http://x.test/analyticsX/v1/health'))).status).toBe(404)
  })

  it('node handler as middleware: other paths go to next(), collector paths are answered', async () => {
    const handler = toNodeHandler(collector())
    const url = await listen((req, res) =>
      handler(req, res, () => {
        res.writeHead(299).end('app')
      }),
    )
    const app = await rawRequest(`${url}/somewhere/else`, { method: 'GET' })
    expect([app.status, app.text]).toEqual([299, 'app'])
    const health = await rawRequest(`${url}/v1/health`, { method: 'GET' })
    expect(health.status).toBe(200)
  })

  it('node handler under a base path without next(): 404 elsewhere', async () => {
    const url = await listen(toNodeHandler(collector(), { basePath: '/analytics' }))
    expect((await rawRequest(`${url}/v1/health`, { method: 'GET' })).status).toBe(404)
    expect((await rawRequest(`${url}/analytics/v1/health`, { method: 'GET' })).status).toBe(200)
  })

  it('an error escaping the collector goes to next(error), or becomes a 500', async () => {
    const broken: Collector = {
      paths: ['/v1/health'],
      handle: async () => {
        throw new Error('boom')
      },
      close: async () => {},
      stats: () => ({ events: { mode: 'direct' }, consent: { mode: 'direct' } }),
    }
    const errors: unknown[] = []
    const withNext = toNodeHandler(broken)
    const url = await listen((req, res) =>
      withNext(req, res, error => {
        errors.push(error)
        res.writeHead(502).end()
      }),
    )
    expect((await rawRequest(`${url}/v1/health`, { method: 'GET' })).status).toBe(502)
    expect(errors).toHaveLength(1)

    const plainUrl = await listen(toNodeHandler(broken))
    expect((await rawRequest(`${plainUrl}/v1/health`, { method: 'GET' })).status).toBe(500)
  })
})

describe('standalone server', () => {
  it('close() lets in-flight requests finish, then closes the collector', async () => {
    let release!: () => void
    const slow = memoryStore()
    const insertEvents = slow.insertEvents
    slow.insertEvents = async events => {
      await new Promise<void>(resolve => (release = resolve))
      return insertEvents(events)
    }
    const closeStore = vi.fn(async () => {})
    slow.close = closeStore
    const { url, server } = createdServer(await startServer(collector({ store: slow })))

    const inFlight = rawRequest(`${url}/v1/events`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        v: 1,
        siteKey: 'example-site',
        sentAt: '2026-11-10T12:00:01.000Z',
        events: [
          {
            eventId: 'event-00000001',
            name: 'page_view',
            occurredAt: '2026-11-10T12:00:00.000Z',
            sessionId: 'session-0000001',
            trackingCategory: 'full',
            consent: { required: false, granted: false },
            props: {},
          },
        ],
      }),
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 10_000 })
    const closed = server.close()
    let closedYet = false
    void closed.then(() => (closedYet = true))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(closedYet).toBe(false) // waiting for the request
    expect(closeStore).not.toHaveBeenCalled()

    release()
    expect((await inFlight).status).toBe(202)
    await closed
    expect(closeStore).toHaveBeenCalledOnce()
    await expect(rawRequest(`${url}/v1/health`, { method: 'GET' })).rejects.toThrow()
  })

  it('close() gives up on requests that outlast shutdownTimeoutMs', async () => {
    const stuck = memoryStore()
    stuck.insertEvents = () => new Promise(() => {})
    const { url, server } = createdServer(
      await startServer(collector({ store: stuck }), { shutdownTimeoutMs: 100 }),
    )
    const pending = rawRequest(`${url}/v1/events`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        v: 1,
        siteKey: 'example-site',
        sentAt: '2026-11-10T12:00:01.000Z',
        events: [
          {
            eventId: 'event-00000001',
            name: 'page_view',
            occurredAt: '2026-11-10T12:00:00.000Z',
            sessionId: 'session-0000001',
            trackingCategory: 'full',
            consent: { required: false, granted: false },
            props: {},
          },
        ],
      }),
    }).catch(error => error)
    await new Promise(resolve => setTimeout(resolve, 50))
    const started = Date.now()
    await server.close()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(await pending).toBeInstanceOf(Error) // connection was cut
  })

  it('applies request timeouts and reports its address', async () => {
    const { server, port, url } = await startServer(collector(), {
      headersTimeoutMs: 1234,
      requestTimeoutMs: 5678,
      keepAliveTimeoutMs: 910,
    })
    expect(server.server.headersTimeout).toBe(1234)
    expect(server.server.requestTimeout).toBe(5678)
    expect(server.server.keepAliveTimeout).toBe(910)
    expect(url).toBe(`http://127.0.0.1:${port}`)
  })

  it('extra routes by exact path are answered before the collector; a failing route is a 500', async () => {
    const { url } = await startServer(collector(), {
      routes: {
        '/readyz': (_req, res) => void res.writeHead(200).end('ready'),
        '/broken': async () => {
          throw new Error('boom')
        },
      },
    })
    expect((await rawRequest(`${url}/readyz`, { method: 'GET' })).text).toBe('ready')
    expect((await rawRequest(`${url}/broken`, { method: 'GET' })).status).toBe(500)
    expect((await rawRequest(`${url}/v1/health`, { method: 'GET' })).status).toBe(200)
  })

  it('listen() rejects when the port is taken', async () => {
    const { port } = await startServer(collector())
    const second = createCollectorServer(collector(), { port, host: '127.0.0.1' })
    await expect(second.listen()).rejects.toThrow(/EADDRINUSE/)
  })
})

/** startServer() result with the server under test. */
function createdServer(started: Awaited<ReturnType<typeof startServer>>) {
  return { url: started.url, server: started.server }
}
