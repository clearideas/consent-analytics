// Ways to reach a collector in tests. The contract suite runs through each one, so every
// adapter is held to the same behavior.
import type { Server } from 'node:http'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'

import express5 from 'express'
import express4 from 'express4'

import { collectorMiddleware } from '../../src/http/express.ts'
import { toFetchHandler } from '../../src/http/fetch.ts'
import { createCollectorServer } from '../../src/http/node.ts'
import type { Collector } from '../../src/index.ts'

export interface TestResponse {
  status: number
  headers: Headers
  text: string
}

export interface RequestInit {
  method: string
  /** Exact headers to send (nothing is added except Content-Length for bodies). */
  headers?: Record<string, string>
  body?: string | Uint8Array
}

export interface Connection {
  request(path: string, init: RequestInit): Promise<TestResponse>
  close(): Promise<void>
}

export interface Transport {
  name: string
  connect(collector: Collector): Promise<Connection>
  /**
   * Middleware passes paths that are not the collector's to the application (which decides
   * its own 404s); standalone transports answer them with a problem-details 404.
   */
  passesUnknownPaths?: boolean
}

async function fromResponse(response: Response): Promise<TestResponse> {
  return { status: response.status, headers: response.headers, text: await response.text() }
}

const fetchTransport = (basePath = ''): Transport => ({
  name: basePath ? `fetch handler under ${basePath}` : 'fetch handler',
  async connect(collector) {
    const handle = toFetchHandler(collector, { basePath })
    return {
      request: async (path, init) =>
        fromResponse(
          await handle(
            new Request(`http://collector.test${basePath}${path}`, {
              method: init.method,
              headers: init.headers,
              body: init.body,
            }),
          ),
        ),
      close: () => collector.close(),
    }
  },
})

/** Send a raw HTTP/1.1 request with exactly these headers. */
export function rawRequest(url: string, init: RequestInit): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const body = typeof init.body === 'string' ? Buffer.from(init.body) : init.body
    const req = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: init.method,
        headers: {
          ...init.headers,
          ...(body ? { 'Content-Length': String(body.byteLength) } : {}),
        },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const headers = new Headers()
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(', ') : value)
          }
          resolve({
            status: res.statusCode!,
            headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    // A server may answer (413) and close before the whole body is written.
    req.on('error', error =>
      (error as NodeJS.ErrnoException).code === 'EPIPE' ? undefined : reject(error),
    )
    req.end(body)
  })
}

const nodeTransport = (basePath = ''): Transport => ({
  name: basePath ? `node:http server under ${basePath}` : 'node:http server',
  async connect(collector) {
    const server = createCollectorServer(collector, { port: 0, host: '127.0.0.1', basePath })
    const { url } = await server.listen()
    return {
      request: (path, init) => rawRequest(`${url}${basePath}${path}`, init),
      close: () => server.close(),
    }
  },
})

/** Listen on a free port; returns the base URL and a close function. */
export async function listen(handler: Parameters<typeof createServer>[1]) {
  const server: Server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** An Express app with the collector mounted under /analytics, as the docs recommend. */
const expressTransport = (name: string, express: typeof express5): Transport => ({
  name,
  passesUnknownPaths: true,
  async connect(collector) {
    const app = express()
    app.use('/analytics', collectorMiddleware(collector))
    app.use(express.json())
    app.get('/', (_req, res) => {
      res.send('the application')
    })
    const server = await listen(app)
    return {
      request: (path, init) => rawRequest(`${server.url}/analytics${path}`, init),
      close: async () => {
        await server.close()
        await collector.close()
      },
    }
  },
})

export const TRANSPORTS: Transport[] = [
  fetchTransport(),
  nodeTransport(),
  nodeTransport('/analytics'),
  expressTransport('Express 5 under /analytics', express5),
  expressTransport('Express 4 under /analytics', express4),
]
