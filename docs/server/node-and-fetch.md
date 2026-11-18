---
title: node:http and Fetch platforms
description: 'Run the collector as its own node:http server, as Connect-style middleware, or with a Fetch API handler on Hono, Next.js, Bun, Deno or Cloudflare Workers.'
---

# node:http and Fetch platforms

## A standalone `node:http` server

```ts
import { createCollectorServer } from '@clearideas/consent-analytics-server/node'

const server = createCollectorServer(collector, {
  port: 8787,
  host: '0.0.0.0',
  trustProxy: 1,
  routes: {
    // Extra routes by exact path, answered before the collector:
    '/readyz': async (req, res) => {
      await store.health?.()
      res.writeHead(200).end('ready')
    },
  },
})
const { url } = await server.listen()
process.on('SIGTERM', () => void server.close())
```

| Option | Default | |
| --- | --- | --- |
| `port`, `host` | `8787`, all interfaces | |
| `basePath` | none | Serve the collector under a path, e.g. `/analytics` |
| `trustProxy` | `false` | Where the client IP comes from: see [below](#client-ip) |
| `headersTimeoutMs` | 10 000 | Time allowed to receive request headers |
| `requestTimeoutMs` | 30 000 | Time allowed for a whole request |
| `keepAliveTimeoutMs` | 5 000 | Idle keep-alive connections are closed after this |
| `shutdownTimeoutMs` | 10 000 | On `close()`, how long in-flight requests may finish |
| `routes` | none | Extra handlers by exact path (health checks, metrics) |

`close()` stops accepting connections, lets in-flight requests finish (up to
`shutdownTimeoutMs`), then calls `collector.close()`, which writes buffered data and closes
the store.

## `node:http` handler, or Connect-style middleware

`toNodeHandler(collector, { basePath?, trustProxy? })` returns `(req, res, next?)`. With
`next`, paths that aren't the collector's are passed on, so it works as middleware in
Connect-style frameworks and in your own `node:http` server:

```ts
import http from 'node:http'
import { toNodeHandler } from '@clearideas/consent-analytics-server/node'

const analytics = toNodeHandler(collector, {
  basePath: '/analytics',
  trustProxy: 1,
})
http
  .createServer((req, res) => analytics(req, res, () => app(req, res)))
  .listen(3000)
```

For Fastify, register it on the raw server, or use the Fetch handler below with
Fastify's request conversion.

## Fetch API handler

`toFetchHandler(collector, { basePath?, getClientIp? })` returns
`(request: Request) => Promise<Response>`:

```ts
import { toFetchHandler } from '@clearideas/consent-analytics-server/fetch'

const handle = toFetchHandler(collector, {
  basePath: '/analytics',
  // The client IP, if your platform provides it
  // (for location lookups and rate limits):
  getClientIp: request => request.headers.get('cf-connecting-ip') ?? undefined,
})
```

Outside `basePath`, it answers `404`. Remember to call `collector.close()` when your
process stops, if it buffers.

### Hono

```ts
import { Hono } from 'hono'

const app = new Hono()
app.all('/analytics/*', c => handle(c.req.raw))
```

### Next.js route handlers

```ts
// app/analytics/[...path]/route.ts
import { collector } from '@/lib/analytics'
import { toFetchHandler } from '@clearideas/consent-analytics-server/fetch'

const handle = toFetchHandler(collector, {
  basePath: '/analytics',
  getClientIp: request =>
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
})
export const GET = handle
export const POST = handle
export const OPTIONS = handle
export const runtime = 'nodejs'
```

Use the Node.js runtime: the collector and its store adapters use Node.js APIs. Keep the
collector in a module, so it's created once per server process.

### Bun, Deno, Cloudflare Workers

The handler uses standard Fetch API objects plus `node:crypto` and `node:net`:

- **Bun** and **Deno** provide these. `Bun.serve({ fetch: handle })`,
  `Deno.serve(handle)`.
- **Cloudflare Workers** need the `nodejs_compat` compatibility flag, and a store that works
  there (an HTTP-based database client, or a queue such as a Workers-compatible one behind
  your own [`IngestQueue`](./custom-adapters.md#queues)). Take the client IP from
  `cf-connecting-ip` and the country from `cf-ipcountry`.

These runtimes are expected to work but aren't tested. Please report what you find.

## Client IP

The client IP is used for location lookups, the data policy's IP settings and per-IP rate
limits. Behind proxies, the socket address is the proxy's, so tell the collector whom to
trust (`trustProxy` in `createCollectorServer` and `toNodeHandler`; Express's own
`trust proxy` for the middleware; `getClientIp` for the Fetch handler):

| `trustProxy` | Client IP |
| --- | --- |
| `false` (default) | The socket address. `X-Forwarded-For` is ignored. |
| a number, e.g. `1` | Skip that many proxies from the right of `X-Forwarded-For` (`1` behind one load balancer). |
| a list of addresses and CIDR ranges, e.g. `['10.0.0.0/8', '2001:db8::/32']` | Hops from these are trusted; the first untrusted one is the client. |
| `true` | The left-most `X-Forwarded-For` address. Only behind a proxy that overwrites the header. |

Invalid ranges fail at startup. Trusting too much lets a client choose its own IP address
(and so its location and rate limit): trust exactly your own proxies.
