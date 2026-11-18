// Web-standard adapter: (Request) => Response. Works with Hono, Bun, Deno, Cloudflare
// Workers, Next.js route handlers and anything else built on the Fetch API.
//
//   const handle = toFetchHandler(collector, { basePath: '/analytics' })
//   app.all('/analytics/*', c => handle(c.req.raw))            // Hono
//   export const GET = handle, POST = handle, OPTIONS = handle  // Next.js route handler
import type { Collector } from '../core/collector.ts'
import type { CollectorRequest } from '../core/http.ts'
import { BodyTooLargeError, collectBody } from '../core/http.ts'

export interface FetchHandlerOptions {
  /** Path prefix the collector is mounted under, e.g. `/analytics`. Default: none. */
  basePath?: string
  /** The client's IP, if your platform provides it (used for geo lookups). */
  getClientIp?(request: Request): string | undefined
}

export type FetchHandler = (request: Request) => Promise<Response>

export function toFetchHandler(
  collector: Collector,
  options: FetchHandlerOptions = {},
): FetchHandler {
  const basePath = normalizeBasePath(options.basePath)
  return async request => {
    const url = new URL(request.url)
    let path = url.pathname
    if (basePath) {
      if (path !== basePath && !path.startsWith(`${basePath}/`)) {
        return new Response(null, { status: 404 })
      }
      path = path.slice(basePath.length) || '/'
    }
    const collectorRequest: CollectorRequest = {
      method: request.method.toUpperCase(),
      path,
      query: url.searchParams,
      headers: request.headers,
      clientIp: options.getClientIp?.(request),
      raw: request,
      async readBody(limit) {
        if (!request.body) return new Uint8Array()
        try {
          return await collectBody(request.body, limit)
        } catch (error) {
          if (error instanceof BodyTooLargeError) await request.body.cancel().catch(() => {})
          throw error
        }
      },
    }
    const response = await collector.handle(collectorRequest)
    return new Response(response.body ?? null, {
      status: response.status,
      headers: response.headers,
    })
  }
}

export function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath || basePath === '/') return ''
  const trimmed = basePath.replace(/\/+$/, '')
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}
