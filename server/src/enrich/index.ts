// What the collector itself knows about a request (IP, location, network, user agent,
// language, Global Privacy Control), reduced to the levels a data-policy profile allows.
import type { HeaderReader } from '../core/http.ts'
import type { Geo } from '../geo/index.ts'
import type { FullCollection, LimitedCollection } from '../policy/data-policy.ts'
import { truncateIp } from './ip.ts'
import type { ParsedUserAgent } from './user-agent.ts'
import { parseUserAgent } from './user-agent.ts'

export { ipHasher, truncateIp } from './ip.ts'
export type { ClientHints, DeviceType, ParsedUserAgent } from './user-agent.ts'
export { parseUserAgent } from './user-agent.ts'

/** Server-derived data stored with an event (only what the profile allows). */
export interface ServerInfo {
  ip?: string
  ipForm?: 'full' | 'truncated' | 'hashed'
  geo?: Omit<Geo, 'asn' | 'org' | 'privacy'>
  network?: { asn?: string; org?: string }
  userAgent?: Partial<ParsedUserAgent> & { raw?: string }
  /** Primary language from Accept-Language, e.g. "de-DE". */
  language?: string
  /** The browser sent a Global Privacy Control signal (Sec-GPC: 1). */
  gpc?: boolean
  privacy?: Geo['privacy']
}

/** The request facts enrichment works from. */
export interface RequestFacts {
  clientIp?: string
  userAgent?: string
  acceptLanguage?: string
  gpc: boolean
  hints: { mobile?: string | null; platform?: string | null }
}

export function requestFacts(headers: HeaderReader, clientIp: string | undefined): RequestFacts {
  return {
    ...(clientIp ? { clientIp } : {}),
    ...(headers.get('user-agent') ? { userAgent: headers.get('user-agent')! } : {}),
    ...(headers.get('accept-language') ? { acceptLanguage: headers.get('accept-language')! } : {}),
    gpc: headers.get('sec-gpc')?.trim() === '1',
    hints: { mobile: headers.get('sec-ch-ua-mobile'), platform: headers.get('sec-ch-ua-platform') },
  }
}

const LANGUAGE_TAG = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/

/** The most preferred language in an Accept-Language header, e.g. "de-DE", or undefined. */
export function primaryLanguage(header: string | undefined): string | undefined {
  if (!header) return undefined
  let best: { tag: string; q: number } | undefined
  for (const part of header.slice(0, 512).split(',')) {
    const [tag, ...params] = part.trim().split(';')
    if (!tag || !LANGUAGE_TAG.test(tag)) continue
    const qParam = params.map(p => p.trim()).find(p => p.startsWith('q='))
    const q = qParam ? Number(qParam.slice(2)) : 1
    if (!Number.isFinite(q) || q <= 0) continue
    if (!best || q > best.q) best = { tag, q }
  }
  if (!best) return undefined
  const [language, ...rest] = best.tag.split('-')
  return [language!.toLowerCase(), ...rest.map(s => (s.length === 2 ? s.toUpperCase() : s))].join(
    '-',
  )
}

type Collection = FullCollection | LimitedCollection

export interface EnrichOptions {
  /**
   * The events this is for. For `limited` events an IP address (in any form) and privacy
   * flags are never included, whatever the collection says (spec MUST).
   */
  category: 'full' | 'limited'
  /** Required when the collection level is `hashed`. */
  hashIp?: (ip: string, at: Date) => string
  receivedAt: Date
}

/** Build the stored server info for one collection level. Undefined when nothing is collected. */
export function collectServerInfo(
  facts: RequestFacts,
  geo: Geo | null,
  collection: Collection,
  options: EnrichOptions,
): ServerInfo | undefined {
  const info: ServerInfo = {}

  const full = options.category === 'full' ? (collection as FullCollection) : undefined

  // IP address: full events only.
  if (full && facts.clientIp && full.ip !== 'none') {
    if (full.ip === 'full') {
      info.ip = facts.clientIp
      info.ipForm = 'full'
    } else if (full.ip === 'truncated') {
      const truncated = truncateIp(facts.clientIp)
      if (truncated) {
        info.ip = truncated
        info.ipForm = 'truncated'
      }
    } else if (options.hashIp) {
      info.ip = options.hashIp(facts.clientIp, options.receivedAt)
      info.ipForm = 'hashed'
    }
  }

  if (geo?.country && collection.geo !== 'none') {
    const level = collection.geo
    const g: NonNullable<ServerInfo['geo']> = { country: geo.country }
    if (geo.continent) g.continent = geo.continent
    if (level === 'region' || level === 'city' || level === 'coords') {
      if (geo.region) g.region = geo.region
      if (geo.regionCode) g.regionCode = geo.regionCode
    }
    if (level === 'city' || level === 'coords') {
      if (geo.city) g.city = geo.city
      if (geo.postalCode) g.postalCode = geo.postalCode
      if (geo.timezone) g.timezone = geo.timezone
    }
    if (level === 'coords' && geo.latitude !== undefined && geo.longitude !== undefined) {
      g.latitude = geo.latitude
      g.longitude = geo.longitude
    }
    info.geo = g
  }

  if (geo && collection.network !== 'none') {
    const network: NonNullable<ServerInfo['network']> = {}
    if (geo.asn) network.asn = geo.asn
    if (collection.network === 'org' && geo.org) network.org = geo.org
    if (Object.keys(network).length) info.network = network
  }

  if (facts.userAgent && collection.userAgent !== 'none') {
    const parsed = parseUserAgent(facts.userAgent, facts.hints)
    info.userAgent =
      collection.userAgent === 'device-type'
        ? { device: parsed.device }
        : collection.userAgent === 'parsed'
          ? parsed
          : { ...parsed, raw: facts.userAgent.slice(0, 512) }
  }

  if (collection.language) {
    const language = primaryLanguage(facts.acceptLanguage)
    if (language) info.language = language
  }
  if (collection.gpc) info.gpc = facts.gpc
  if (full?.privacyFlags && geo?.privacy) {
    info.privacy = { ...geo.privacy }
  }

  return Object.keys(info).length ? info : undefined
}
