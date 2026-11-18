// IPinfo (https://ipinfo.io) as a geo resolver, with the global fetch (no SDK).
//
//   geo: chainGeo(trustedHeaderGeo(['cloudfront-viewer-country']), ipinfoGeo({ token, cache: redisCache(redis) }))
//
// - Both IPinfo response formats are understood: the classic one (ipinfo.io/{ip}: `region`,
//   `loc`, `org: "AS15169 Google LLC"`, `privacy`) and the newer one (api.ipinfo.io/lite and
//   /lookup: `country_code`, `region_code`, `latitude`, `asn`/`as`, `is_*` flags). Fields your
//   plan does not return are simply absent.
// - US and Canadian region names become ISO 3166-2 codes (`US-CA`), so data policies can match
//   states and provinces.
// - Private and reserved addresses are never looked up. Lookups time out (default 150 ms);
//   a timeout or error means "unknown region" (consent required), never a failed request.
// - Answers are cached in memory, and optionally in a shared cache (e.g. Redis), under an HMAC
//   of the IP address: no raw address is used as a cache key.
import { createHmac, randomBytes } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

import type { Cache } from '../cache/index.ts'
import { memoryCache } from '../cache/index.ts'
import type { Logger } from '../core/logger.ts'
import { errorFields } from '../core/logger.ts'
import type { Geo, GeoResolver } from './index.ts'
import { normalizeGeo } from './index.ts'

export interface IpinfoOptions {
  token: string
  /**
   * Request URL for an IP. Default: the classic endpoint `https://ipinfo.io/{ip}/json`.
   * For the newer API, e.g. `ip => \`https://api.ipinfo.io/lookup/${ip}\``.
   */
  url?: (ip: string) => string
  /** Default 150 ms. */
  timeoutMs?: number
  /** Shared cache (e.g. redisCache) in addition to the in-memory one. */
  cache?: Cache
  /** How long answers are kept. Default 24 h (unknown answers: 10 min). */
  ttlMs?: number
  /** Secret for cache keys (HMAC of the IP). Default: random per process (set one to share a cache). */
  cacheKeySecret?: string
  fetch?: typeof fetch
  logger?: Logger
}

const US_STATES: Record<string, string> = {
  Alabama: 'AL',
  Alaska: 'AK',
  Arizona: 'AZ',
  Arkansas: 'AR',
  California: 'CA',
  Colorado: 'CO',
  Connecticut: 'CT',
  Delaware: 'DE',
  'District of Columbia': 'DC',
  Florida: 'FL',
  Georgia: 'GA',
  Hawaii: 'HI',
  Idaho: 'ID',
  Illinois: 'IL',
  Indiana: 'IN',
  Iowa: 'IA',
  Kansas: 'KS',
  Kentucky: 'KY',
  Louisiana: 'LA',
  Maine: 'ME',
  Maryland: 'MD',
  Massachusetts: 'MA',
  Michigan: 'MI',
  Minnesota: 'MN',
  Mississippi: 'MS',
  Missouri: 'MO',
  Montana: 'MT',
  Nebraska: 'NE',
  Nevada: 'NV',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'North Carolina': 'NC',
  'North Dakota': 'ND',
  Ohio: 'OH',
  Oklahoma: 'OK',
  Oregon: 'OR',
  Pennsylvania: 'PA',
  'Rhode Island': 'RI',
  'South Carolina': 'SC',
  'South Dakota': 'SD',
  Tennessee: 'TN',
  Texas: 'TX',
  Utah: 'UT',
  Vermont: 'VT',
  Virginia: 'VA',
  Washington: 'WA',
  'West Virginia': 'WV',
  Wisconsin: 'WI',
  Wyoming: 'WY',
  'Puerto Rico': 'PR',
  Guam: 'GU',
  'U.S. Virgin Islands': 'VI',
  'American Samoa': 'AS',
  'Northern Mariana Islands': 'MP',
}
const CA_PROVINCES: Record<string, string> = {
  Alberta: 'AB',
  'British Columbia': 'BC',
  Manitoba: 'MB',
  'New Brunswick': 'NB',
  'Newfoundland and Labrador': 'NL',
  'Nova Scotia': 'NS',
  Ontario: 'ON',
  'Prince Edward Island': 'PE',
  Quebec: 'QC',
  Québec: 'QC',
  Saskatchewan: 'SK',
  'Northwest Territories': 'NT',
  Nunavut: 'NU',
  Yukon: 'YT',
}

/** Addresses no lookup service knows: private, loopback, link-local, CGNAT, documentation, ... */
export function isNonPublicIp(ip: string): boolean {
  if (isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    )
  }
  if (isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    if (lower.startsWith('::ffff:')) return isNonPublicIp(lower.slice(7))
    return /^(?:f[cd]|fe[89ab]|ff)/.test(lower) || lower.startsWith('2001:db8')
  }
  return true
}

type Json = Record<string, unknown>
const str = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined
const num = (value: unknown) => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/** Map an IPinfo response (either format) to a Geo. Exported for tests and custom fetchers. */
export function geoFromIpinfo(data: Json): Geo | null {
  if (!data || data.bogon === true) return null
  const geoPart = (data.geo && typeof data.geo === 'object' ? data.geo : data) as Json
  const country =
    str(geoPart.country_code) ??
    (str(geoPart.country)?.length === 2 ? str(geoPart.country) : undefined)
  if (!country) return null
  const region = str(geoPart.region)
  const regionCodeRaw = str(geoPart.region_code)
  const codes = country === 'US' ? US_STATES : country === 'CA' ? CA_PROVINCES : undefined
  const regionCode = regionCodeRaw
    ? regionCodeRaw.includes('-')
      ? regionCodeRaw
      : `${country}-${regionCodeRaw}`
    : region && codes?.[region]
      ? `${country}-${codes[region]}`
      : undefined

  let latitude = num(geoPart.latitude)
  let longitude = num(geoPart.longitude)
  const loc = str(data.loc)
  if ((latitude === undefined || longitude === undefined) && loc) {
    const [lat, lon] = loc.split(',').map(Number)
    latitude = lat
    longitude = lon
  }

  // Network: "org": "AS15169 Google LLC" (classic), or asn/as_name, or an "as" object.
  const as = (data.as && typeof data.as === 'object' ? data.as : {}) as Json
  const orgMatch = str(data.org)?.match(/^(AS\d+)\s+(.+)$/)
  const asn = str(as.asn) ?? str(data.asn) ?? orgMatch?.[1]
  const org =
    str(as.name) ?? str(data.as_name) ?? orgMatch?.[2] ?? (orgMatch ? undefined : str(data.org))

  const privacyPart = (data.privacy && typeof data.privacy === 'object' ? data.privacy : {}) as Json
  const privacy: NonNullable<Geo['privacy']> = {}
  for (const flag of ['vpn', 'proxy', 'tor', 'relay', 'hosting'] as const) {
    if (typeof privacyPart[flag] === 'boolean') privacy[flag] = privacyPart[flag] as boolean
  }
  if (typeof data.is_hosting === 'boolean') privacy.hosting = data.is_hosting
  if (typeof data.is_anonymous === 'boolean' && privacy.vpn === undefined)
    privacy.vpn = data.is_anonymous

  return normalizeGeo({
    country,
    continent: str(geoPart.continent_code) ?? str((data.continent as Json | undefined)?.code),
    region,
    regionCode,
    city: str(geoPart.city),
    postalCode: str(geoPart.postal_code) ?? str(data.postal),
    latitude,
    longitude,
    timezone: str(geoPart.timezone) ?? str(data.timezone),
    asn,
    org,
    ...(Object.keys(privacy).length ? { privacy } : {}),
  })
}

export function ipinfoGeo(options: IpinfoOptions): GeoResolver {
  if (!options.token) throw new Error('ipinfoGeo: token is required')
  const url = options.url ?? (ip => `https://ipinfo.io/${encodeURIComponent(ip)}/json`)
  const timeoutMs = options.timeoutMs ?? 150
  const ttlMs = options.ttlMs ?? 86_400_000
  const negativeTtlMs = 600_000
  const secret = options.cacheKeySecret ?? randomBytes(32).toString('hex')
  const local = memoryCache({ maxEntries: 50_000 })
  const shared = options.cache
  const doFetch = options.fetch ?? globalThis.fetch
  let lastWarning = 0

  const warn = (fields: Record<string, unknown>, message: string) => {
    // At most one warning a minute: a lookup outage should not flood the logs.
    if (!options.logger || Date.now() - lastWarning < 60_000) return
    lastWarning = Date.now()
    options.logger.warn(fields, message)
  }

  return async ({ clientIp }) => {
    if (!clientIp || isNonPublicIp(clientIp)) return null
    const key = `ipinfo:${createHmac('sha256', secret).update(clientIp).digest('base64url').slice(0, 27)}`
    let cached = await local.get(key)
    if (cached === undefined && shared) {
      cached = await shared.get(key).catch(() => undefined)
      if (cached !== undefined) await local.set(key, cached, cached ? ttlMs : negativeTtlMs)
    }
    // '' is a cached "unknown" answer.
    if (cached !== undefined) return cached ? (JSON.parse(cached) as Geo) : null
    let geo: Geo | null
    try {
      const response = await doFetch(url(clientIp), {
        headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`IPinfo answered ${response.status}`)
      geo = geoFromIpinfo((await response.json()) as Json)
    } catch (error) {
      warn({ ...errorFields(error) }, 'IPinfo lookup failed; region unknown')
      return null // not cached: try again next time
    }
    const value = geo ? JSON.stringify(geo) : ''
    const ttl = geo ? ttlMs : negativeTtlMs
    await local.set(key, value, ttl)
    shared?.set(key, value, ttl).catch(() => {})
    return geo
  }
}
