// Visitor location. Any source works (CDN country header, IP lookup service, ...); resolvers
// can be chained. When nothing is known the region is unknown, which means consent is
// required (the spec's fail-closed rule).
import type { HeaderReader } from '../core/http.ts'

export interface Geo {
  /** ISO 3166-1 alpha-2, upper case. */
  country?: string
  /** AF, AN, AS, EU, NA, OC or SA. */
  continent?: string
  /** Subdivision name, e.g. "California". */
  region?: string
  /** ISO 3166-2 subdivision code, e.g. "US-CA" (data policies can match it). */
  regionCode?: string
  city?: string
  postalCode?: string
  latitude?: number
  longitude?: number
  /** IANA time zone, e.g. "Europe/Berlin". */
  timezone?: string
  /** Autonomous system, e.g. "AS15169". */
  asn?: string
  /** Network owner (ISP or company). */
  org?: string
  /** What the lookup service knows about the address. */
  privacy?: { vpn?: boolean; proxy?: boolean; tor?: boolean; relay?: boolean; hosting?: boolean }
}

export interface GeoRequest {
  headers: HeaderReader
  clientIp?: string
}

export type GeoResolver = (
  request: GeoRequest,
) => Geo | null | undefined | Promise<Geo | null | undefined>

const COUNTRY = /^[A-Z]{2}$/
const CONTINENTS = new Set(['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA'])
// Placeholder values CDNs use: XX = unknown, T1 = Tor (Cloudflare).
// Codes CDNs and geo databases use for "not a country": unknown, Tor, continents (EU, AP),
// anonymous proxies and satellite providers (A1, A2, O1), user-assigned (ZZ).
const NOT_A_COUNTRY = new Set(['XX', 'T1', 'EU', 'AP', 'A1', 'A2', 'O1', 'ZZ'])

const REGION_CODE = /^([A-Z]{2})-[A-Z0-9]{1,3}$/
const ASN = /^(?:AS)?(\d{1,10})$/i
const PRIVACY_FLAGS = ['vpn', 'proxy', 'tor', 'relay', 'hosting'] as const

const text = (value: unknown, max = 200): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

const coordinate = (value: unknown, limit: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit
    ? value
    : undefined

/**
 * A normalized Geo, or null if `country` is not a real ISO country code. Invalid optional
 * fields are dropped (never trusted as-is): a resolver may wrap any third-party service.
 */
export function normalizeGeo(geo: Geo | null | undefined): Geo | null {
  const country = geo?.country?.trim().toUpperCase()
  if (!country || !COUNTRY.test(country) || NOT_A_COUNTRY.has(country)) return null
  const result: Geo = { country }
  const continent = geo?.continent?.trim().toUpperCase()
  if (continent && CONTINENTS.has(continent)) result.continent = continent

  const region = text(geo?.region)
  if (region) result.region = region
  const regionCode = geo?.regionCode?.trim().toUpperCase()
  if (regionCode && REGION_CODE.exec(regionCode)?.[1] === country) result.regionCode = regionCode
  const city = text(geo?.city)
  if (city) result.city = city
  const postalCode = text(geo?.postalCode, 20)
  if (postalCode) result.postalCode = postalCode
  const latitude = coordinate(geo?.latitude, 90)
  const longitude = coordinate(geo?.longitude, 180)
  if (latitude !== undefined && longitude !== undefined) {
    result.latitude = latitude
    result.longitude = longitude
  }
  const timezone = text(geo?.timezone, 64)
  if (timezone && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) result.timezone = timezone
  const asn = typeof geo?.asn === 'string' ? ASN.exec(geo.asn.trim()) : null
  if (asn) result.asn = `AS${asn[1]}`
  const org = text(geo?.org)
  if (org) result.org = org
  if (geo?.privacy && typeof geo.privacy === 'object') {
    const privacy: NonNullable<Geo['privacy']> = {}
    for (const flag of PRIVACY_FLAGS) {
      if (typeof geo.privacy[flag] === 'boolean') privacy[flag] = geo.privacy[flag]
    }
    if (Object.keys(privacy).length) result.privacy = privacy
  }
  return result
}

/**
 * Country (and optionally continent) from request headers set by your CDN or proxy, e.g.
 * `cf-ipcountry`, `cloudfront-viewer-country`, `x-vercel-ip-country`.
 *
 * Only list headers your proxy overwrites on every request: if clients can reach the
 * collector directly, they can send these headers and pick their own consent policy.
 */
export function trustedHeaderGeo(
  countryHeaders: readonly string[],
  options: { continentHeaders?: readonly string[] } = {},
): GeoResolver {
  const continents = (options.continentHeaders ?? []).map(h => h.toLowerCase())
  // A continent header is never read as a country (`NA` is also Namibia, `AS` American Samoa).
  const countries = countryHeaders.map(h => h.toLowerCase()).filter(h => !continents.includes(h))
  return ({ headers }) => {
    for (const header of countries) {
      const geo = normalizeGeo({ country: headers.get(header) ?? undefined })
      if (!geo) continue
      for (const continentHeader of continents) {
        const withContinent = normalizeGeo({
          country: geo.country,
          continent: headers.get(continentHeader) ?? undefined,
        })
        if (withContinent?.continent) return withContinent
      }
      return geo
    }
    return null
  }
}

/** Always the same location (local development: `DEFAULT_COUNTRY`). */
export function fixedGeo(geo: Geo): GeoResolver {
  const normalized = normalizeGeo(geo)
  if (!normalized) throw new Error(`fixedGeo: "${geo.country}" is not an ISO 3166-1 alpha-2 code`)
  return () => normalized
}

/** Ask each resolver in turn; the first that knows the country wins. */
export function chainGeo(...resolvers: GeoResolver[]): GeoResolver {
  return async request => {
    for (const resolve of resolvers) {
      const geo = normalizeGeo(await resolve(request))
      if (geo) return geo
    }
    return null
  }
}
