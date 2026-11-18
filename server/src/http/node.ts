// node:http adapter and a standalone server.
//
//   http.createServer(toNodeHandler(collector)).listen(8787)
//
// The handler also works as Connect/Express-style middleware: with a `next` callback,
// requests for other paths are passed on.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { Collector } from '../core/collector.ts'
import type { CollectorRequest, CollectorResponse } from '../core/http.ts'
import { collectBody, headerReader } from '../core/http.ts'
import { networkMatcher } from './cidr.ts'
import { normalizeBasePath } from './fetch.ts'

/**
 * Which proxies to trust for the client IP (X-Forwarded-For):
 * - `false` (default): the socket address; X-Forwarded-For is ignored.
 * - a number N: trust N proxies in front of the server (the address N hops from the right).
 * - a list of networks (`['10.0.0.0/8', '2001:db8::/32', '127.0.0.1']`): the right-most address
 *   that is not one of your proxies. Robust when the number of proxies varies.
 * - `true`: the left-most X-Forwarded-For address. Only if every path to the server sets it.
 */
export type TrustProxy = boolean | number | readonly string[]

export interface NodeHandlerOptions {
  /** Path prefix the collector is mounted under (not needed under Express `app.use(path)`). */
  basePath?: string
  trustProxy?: TrustProxy
}

export type NodeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (error?: unknown) => void,
) => void

/** The client's IP address according to `trustProxy`. */
const matchers = new WeakMap<readonly string[], (ip: string) => boolean>()

export function clientIpFrom(
  req: IncomingMessage,
  trustProxy: TrustProxy = false,
): string | undefined {
  const remote = req.socket?.remoteAddress
  if (trustProxy === false || trustProxy === 0) return unmap(remote)
  const header = req.headers['x-forwarded-for']
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
  const chain = remote ? [...forwarded, remote] : forwarded
  if (trustProxy === true) return unmap(chain[0])
  if (Array.isArray(trustProxy)) {
    let trusted = matchers.get(trustProxy)
    if (!trusted) matchers.set(trustProxy, (trusted = networkMatcher(trustProxy)))
    for (let i = chain.length - 1; i >= 0; i--) {
      const address = unmap(chain[i])
      if (address && !trusted(address)) return address
    }
    return unmap(chain[0])
  }
  return unmap(chain[Math.max(chain.length - 1 - (trustProxy as number), 0)])
}

function unmap(address: string | undefined): string | undefined {
  return address?.startsWith('::ffff:') && address.includes('.') ? address.slice(7) : address
}

export function toNodeHandler(collector: Collector, options: NodeHandlerOptions = {}): NodeHandler {
  if (Array.isArray(options.trustProxy)) networkMatcher(options.trustProxy) // invalid ranges fail now
  const basePath = normalizeBasePath(options.basePath)
  const paths = new Set(collector.paths)
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://collector.invalid')
    let path = url.pathname
    if (basePath) {
      if (path !== basePath && !path.startsWith(`${basePath}/`)) return notFound(res, next)
      path = path.slice(basePath.length) || '/'
    }
    // Under a framework, let other paths through to the application.
    if (next && !paths.has(path)) return next()
    // Hold the body until the collector reads it (see the Express middleware).
    if (!req.readableEnded) req.pause()

    const request: CollectorRequest = {
      method: (req.method ?? 'GET').toUpperCase(),
      path,
      query: url.searchParams,
      headers: headerReader(req.headers),
      clientIp: clientIpFrom(req, options.trustProxy),
      raw: req,
      // Keep the socket open if we stop reading early, so the 413 can still be sent.
      readBody: limit => collectBody(req.iterator({ destroyOnReturn: false }), limit),
    }
    collector.handle(request).then(
      response => writeResponse(res, response),
      error => {
        if (next) return next(error)
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal error')
      },
    )
  }
}

function notFound(res: ServerResponse, next?: (error?: unknown) => void) {
  if (next) return next()
  res.writeHead(404).end()
}

export function writeResponse(res: ServerResponse, response: CollectorResponse): void {
  const headers: Record<string, string> = { ...response.headers }
  // The rest of an oversized body was not read: close the connection after answering.
  if (response.status === 413) headers.Connection = 'close'
  if (response.body !== undefined)
    headers['Content-Length'] = String(Buffer.byteLength(response.body))
  res.writeHead(response.status, headers)
  res.end(response.body)
}

// --- standalone server ----------------------------------------------------------------

export interface CollectorServerOptions extends NodeHandlerOptions {
  port?: number
  host?: string
  /** Time allowed to receive request headers. Default 10 s. */
  headersTimeoutMs?: number
  /** Time allowed for a whole request. Default 30 s. */
  requestTimeoutMs?: number
  /** Idle keep-alive connections are closed after this. Default 5 s. */
  keepAliveTimeoutMs?: number
  /** On close(), how long in-flight requests may finish before connections are cut. Default 10 s. */
  shutdownTimeoutMs?: number
  /**
   * Extra routes by exact path (e.g. `/metrics`, `/readyz`), answered before the collector.
   * They share the server's timeouts and graceful shutdown.
   */
  routes?: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>
}

export interface CollectorServer {
  server: Server
  /** Start listening; resolves with the bound address. */
  listen(): Promise<{ host: string; port: number; url: string }>
  /** Stop accepting connections, let in-flight requests finish, then close the collector. */
  close(): Promise<void>
}

export function createCollectorServer(
  collector: Collector,
  options: CollectorServerOptions = {},
): CollectorServer {
  const handler = toNodeHandler(collector, options)
  let inFlight = 0
  let drained: (() => void) | undefined
  const server = createServer((req, res) => {
    inFlight++
    res.on('close', () => {
      inFlight--
      if (inFlight === 0) drained?.()
    })
    const route = options.routes?.[new URL(req.url ?? '/', 'http://collector.invalid').pathname]
    if (route) {
      Promise.resolve()
        .then(() => route(req, res))
        .catch(() => {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Internal error')
        })
      return
    }
    handler(req, res)
  })
  server.headersTimeout = options.headersTimeoutMs ?? 10_000
  server.requestTimeout = options.requestTimeoutMs ?? 30_000
  server.keepAliveTimeout = options.keepAliveTimeoutMs ?? 5_000

  let closing: Promise<void> | undefined
  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port ?? 8787, options.host ?? '0.0.0.0', () => {
          server.off('error', reject)
          const address = server.address() as AddressInfo
          const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
          resolve({
            host: address.address,
            port: address.port,
            url: `http://${host}:${address.port}`,
          })
        })
      })
    },
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>(resolve => server.close(() => resolve()))
        server.closeIdleConnections()
        if (inFlight > 0) {
          await Promise.race([
            new Promise<void>(resolve => (drained = resolve)),
            new Promise<void>(resolve =>
              setTimeout(resolve, options.shutdownTimeoutMs ?? 10_000).unref(),
            ),
          ])
        }
        server.closeAllConnections()
        await stopped
        await collector.close()
      })()
      return closing
    },
  }
}
