// Express (5 and 4) and Connect-style middleware. Express itself is not imported.
//
//   app.set('trust proxy', 1)
//   app.use(optionalAuth)                       // must not reject anonymous visitors
//   app.use('/analytics', collectorMiddleware(collector, {
//     identify: req => req.user ? { userId: req.user.id, accountId: req.user.accountId } : null,
//   }))
//
// Mount it before body parsers if you can. If `express.json()` or `express.text()` already
// read the body, the middleware uses the parsed body (size limits still apply). Responses
// replace CORS headers set by an earlier `cors()` middleware, so its settings (e.g.
// credentials) never leak into collector responses.
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Collector } from '../core/collector.ts'
import type { CollectorRequest } from '../core/http.ts'
import { BodyTooLargeError, collectBody, headerReader } from '../core/http.ts'
import type { Logger } from '../core/logger.ts'
import { consoleLogger } from '../core/logger.ts'
import { clientIpFrom, writeResponse } from './node.ts'

/** The parts of an Express request the middleware uses (IncomingMessage plus extras). */
export type ExpressLikeRequest = IncomingMessage & {
  /** Client IP, as Express computes it from its `trust proxy` setting. */
  ip?: string
  /** Set by body parsers. */
  body?: unknown
  /** body-parser marks requests whose body it consumed. */
  _body?: boolean
}

export interface ExpressMiddlewareOptions<Req extends ExpressLikeRequest = ExpressLikeRequest> {
  /**
   * The signed-in visitor, from your own authentication (e.g. `req.user` set by your auth
   * middleware from a validated cookie). Return null for anonymous visitors. Used only for
   * sites with `credentials: true`.
   */
  identify?: (req: Req) => unknown
  /** For the one-time warning when an earlier middleware consumed the body unusably. */
  logger?: Logger
}

export type ExpressMiddleware<Req extends ExpressLikeRequest = ExpressLikeRequest> = (
  req: Req,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void

// CORS headers an earlier cors() middleware may have set; the collector decides its own.
const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
]

class BodyUnavailableError extends Error {}

export function collectorMiddleware<Req extends ExpressLikeRequest = ExpressLikeRequest>(
  collector: Collector,
  options: ExpressMiddlewareOptions<Req> = {},
): ExpressMiddleware<Req> {
  const paths = new Set(collector.paths)
  const logger = options.logger ?? consoleLogger()
  let warnedConsumed = false

  const readBody = async (req: Req, limit: number): Promise<Uint8Array> => {
    if (!req._body && !req.readableEnded) {
      return collectBody(req.iterator({ destroyOnReturn: false }), limit)
    }
    // An earlier body parser read the stream: use what it parsed.
    const body = req.body
    let bytes: Uint8Array | undefined
    if (typeof body === 'string') bytes = Buffer.from(body, 'utf8')
    else if (body instanceof Uint8Array) bytes = body
    else if (body && typeof body === 'object') bytes = Buffer.from(JSON.stringify(body), 'utf8')
    if (!bytes) {
      if (!warnedConsumed) {
        warnedConsumed = true
        logger.warn(
          { path: req.url },
          'collectorMiddleware: the request body was consumed by an earlier middleware and is not available; mount the collector before body parsers',
        )
      }
      throw new BodyUnavailableError('request body unavailable')
    }
    if (bytes.byteLength > limit) throw new BodyTooLargeError(limit)
    return bytes
  }

  return (req, res, next) => {
    // Express strips the mount path from req.url.
    const url = new URL(req.url ?? '/', 'http://collector.invalid')
    if (!paths.has(url.pathname)) return next()
    // Hold the body until the collector reads it: an earlier middleware may have switched the
    // stream to flowing mode (e.g. old `cors` versions call req.resume()), which would drop data
    // while the collector awaits anything before reading.
    if (!req._body && !req.readableEnded) req.pause()

    const request: CollectorRequest = {
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      headers: headerReader(req.headers),
      clientIp: req.ip ?? clientIpFrom(req),
      raw: req,
      readBody: limit => readBody(req, limit),
      ...(options.identify ? { identify: () => options.identify!(req) } : {}),
    }
    collector.handle(request).then(response => {
      if (res.headersSent) return
      for (const header of CORS_HEADERS) res.removeHeader(header)
      writeResponse(res, response)
    }, next)
  }
}
