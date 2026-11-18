// Transport-neutral request and response. Adapters (node:http, fetch, Express) convert to and
// from these; the collector itself never sees a framework object.

/** Case-insensitive header access (a fetch `Headers` object satisfies it). */
export interface HeaderReader {
  get(name: string): string | null
}

export interface CollectorRequest {
  /** Upper-case HTTP method. */
  method: string
  /** Path relative to where the collector is mounted, e.g. `/v1/events`. */
  path: string
  query: URLSearchParams
  headers: HeaderReader
  /** The client's IP address as determined by the adapter (see its `trustProxy` option). */
  clientIp?: string
  /**
   * Read the whole body. Must reject with `BodyTooLargeError` as soon as more than `limit`
   * bytes have arrived (do not rely on Content-Length alone).
   */
  readBody(limit: number): Promise<Uint8Array>
  /** The framework's own request object (Express `req`, `IncomingMessage`, fetch `Request`). */
  raw?: unknown
  /**
   * The signed-in visitor, from your authentication (adapters such as the Express middleware
   * set this from their `identify` option). Used only for sites with `credentials: true`.
   */
  identify?: () => unknown
}

export interface CollectorResponse {
  status: number
  headers: Record<string, string>
  /** Serialized body (JSON), if any. */
  body?: string
}

/** Thrown by `readBody` when the body exceeds the limit. */
export class BodyTooLargeError extends Error {
  readonly limit: number

  constructor(limit: number) {
    super(`Request body exceeds ${limit} bytes`)
    this.name = 'BodyTooLargeError'
    this.limit = limit
  }
}

/** Adapt a plain header object (node:http style: lower-case keys, arrays for repeats). */
export function headerReader(headers: Record<string, string | string[] | undefined>): HeaderReader {
  return {
    get(name) {
      const value = headers[name.toLowerCase()]
      if (value === undefined) return null
      return Array.isArray(value) ? value.join(', ') : value
    },
  }
}

/** Concatenate chunks, failing once more than `limit` bytes have been seen. */
export async function collectBody(
  chunks: AsyncIterable<Uint8Array | string>,
  limit: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let size = 0
  for await (const chunk of chunks) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
    size += bytes.byteLength
    if (size > limit) throw new BodyTooLargeError(limit)
    parts.push(bytes)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    body.set(part, offset)
    offset += part.byteLength
  }
  return body
}
