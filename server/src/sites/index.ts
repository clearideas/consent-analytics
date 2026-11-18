// Sites: each website allowed to send data, identified by its public site key.
// A SiteSource answers "which site is this key?" and "does any site allow this origin?".
// Sources can be static (config), or backed by a database (adapters, later phases).
import type { Cache } from '../cache/index.ts'
import { SITE_KEY_PATTERN } from '../protocol/index.ts'

const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/

export type ConsentMode = 'geo' | 'always' | 'never'
export type TrackingWithoutConsent = 'limited' | 'none'

export interface Site {
  /** Public identifier the browser sends (`siteKey`). Not a secret. */
  siteKey: string
  name?: string
  /** Exact browser origins allowed to use this key, e.g. `https://www.example.com`. */
  allowedOrigins: readonly string[]
  /** Change it when the consent policy or banner changes materially; visitors are asked again. */
  policyVersion: string
  /** `geo`: consent required by visitor region (default). `always` / `never`: regardless of region. */
  consentMode: ConsentMode
  /** What browsers may send without statistics consent where consent is required. */
  trackingWithoutConsent: TrackingWithoutConsent
  /** Accept only these event names, and/or never these (dropped and reported as rejected). */
  eventNames?: { allow?: readonly string[]; deny?: readonly string[] }
  /**
   * Credentialed requests (spec: *Credentialed requests*): browsers send cookies (the
   * library's `credentials: 'include'`), responses allow credentials for this site's origins,
   * and signed-in visitors can be identified (collector `identify`). Default false: cookies
   * are ignored, even those `sendBeacon` attaches.
   */
  credentials?: boolean
}

/** A site as written in configuration: only `siteKey` and `allowedOrigins` are required. */
export interface SiteInput {
  siteKey: string
  name?: string
  allowedOrigins: readonly string[]
  policyVersion?: string | number
  consentMode?: ConsentMode
  trackingWithoutConsent?: TrackingWithoutConsent
  eventNames?: { allow?: readonly string[]; deny?: readonly string[] }
  credentials?: boolean
}

export interface SiteSource {
  getSite(siteKey: string): Site | null | Promise<Site | null>
  /** Whether any site allows this origin (CORS). */
  isOriginAllowed(origin: string): boolean | Promise<boolean>
  /**
   * Whether the origin belongs to a site with credentialed requests (responses then carry
   * `Access-Control-Allow-Credentials: true`). Absent: never.
   */
  isCredentialedOrigin?(origin: string): boolean | Promise<boolean>
}

export class SiteConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SiteConfigError'
  }
}

/** Validate and normalize a site definition. Throws SiteConfigError with the offending field. */
export function defineSite(input: SiteInput, where = 'site'): Site {
  if (!input || typeof input !== 'object') throw new SiteConfigError(`${where} must be an object`)
  if (typeof input.siteKey !== 'string' || !SITE_KEY_PATTERN.test(input.siteKey)) {
    throw new SiteConfigError(`${where}.siteKey must match ${SITE_KEY_PATTERN}`)
  }
  if (!Array.isArray(input.allowedOrigins) || input.allowedOrigins.length === 0) {
    throw new SiteConfigError(`${where}.allowedOrigins must be a non-empty array`)
  }
  for (const origin of input.allowedOrigins) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new SiteConfigError(`${where}.allowedOrigins: "${origin}" is not a URL`)
    }
    if (parsed.origin !== origin) {
      throw new SiteConfigError(
        `${where}.allowedOrigins: "${origin}" must be an exact origin like "${parsed.origin}"`,
      )
    }
  }
  const consentMode = input.consentMode ?? 'geo'
  if (!['geo', 'always', 'never'].includes(consentMode)) {
    throw new SiteConfigError(`${where}.consentMode must be geo, always or never`)
  }
  const trackingWithoutConsent = input.trackingWithoutConsent ?? 'limited'
  if (!['limited', 'none'].includes(trackingWithoutConsent)) {
    throw new SiteConfigError(`${where}.trackingWithoutConsent must be limited or none`)
  }
  const policyVersion = String(input.policyVersion ?? '1')
  if (policyVersion.length < 1 || policyVersion.length > 64) {
    throw new SiteConfigError(`${where}.policyVersion must be 1 to 64 characters`)
  }
  let eventNames: Site['eventNames']
  if (input.eventNames !== undefined) {
    eventNames = {}
    for (const list of ['allow', 'deny'] as const) {
      const names = input.eventNames?.[list]
      if (names === undefined) continue
      if (
        !Array.isArray(names) ||
        names.some(name => typeof name !== 'string' || !EVENT_NAME.test(name))
      ) {
        throw new SiteConfigError(
          `${where}.eventNames.${list} must be an array of event names (${EVENT_NAME})`,
        )
      }
      eventNames[list] = [...names]
    }
  }
  if (input.credentials !== undefined && typeof input.credentials !== 'boolean') {
    throw new SiteConfigError(`${where}.credentials must be true or false`)
  }
  return {
    siteKey: input.siteKey,
    ...(input.name !== undefined ? { name: String(input.name) } : {}),
    allowedOrigins: [...input.allowedOrigins],
    policyVersion,
    consentMode,
    trackingWithoutConsent,
    ...(eventNames ? { eventNames } : {}),
    ...(input.credentials ? { credentials: true } : {}),
  }
}

/** Sites from configuration. Lookups are O(1) by key and by origin. */
export function staticSites(
  inputs: readonly SiteInput[],
): Required<SiteSource> & { sites: readonly Site[] } {
  if (!Array.isArray(inputs)) throw new SiteConfigError('sites must be an array')
  const sites = inputs.map((input, index) => defineSite(input, `sites[${index}]`))
  const byKey = new Map<string, Site>()
  const origins = new Set<string>()
  const credentialedOrigins = new Set<string>()
  for (const site of sites) {
    if (byKey.has(site.siteKey)) throw new SiteConfigError(`Duplicate siteKey "${site.siteKey}"`)
    byKey.set(site.siteKey, site)
    for (const origin of site.allowedOrigins) {
      origins.add(origin)
      if (site.credentials) credentialedOrigins.add(origin)
    }
  }
  return {
    sites,
    getSite: siteKey => byKey.get(siteKey) ?? null,
    isOriginAllowed: origin => origins.has(origin),
    isCredentialedOrigin: origin => credentialedOrigins.has(origin),
  }
}

/** Sources in order: the first that knows a site wins; an origin is allowed if any allows it. */
export function chainSites(...sources: SiteSource[]): Required<SiteSource> {
  return {
    async getSite(siteKey) {
      for (const source of sources) {
        const site = await source.getSite(siteKey)
        if (site) return site
      }
      return null
    },
    async isOriginAllowed(origin) {
      for (const source of sources) if (await source.isOriginAllowed(origin)) return true
      return false
    },
    async isCredentialedOrigin(origin) {
      for (const source of sources) if (await source.isCredentialedOrigin?.(origin)) return true
      return false
    },
  }
}

export interface CachedSitesOptions {
  /** How long answers are reused. Default 60 s: changes (e.g. policyVersion) take up to this long. */
  ttlMs?: number
  /** How long "unknown site" / "origin not allowed" answers are reused. Default 10 s. */
  negativeTtlMs?: number
  /** Most entries kept (oldest dropped first). Default 10 000. */
  maxEntries?: number
  /**
   * A second-level cache shared between instances (e.g. `redisCache`): a miss in memory asks
   * it before the source. Failures of the shared cache are ignored.
   */
  shared?: Cache
  /** Key prefix in the shared cache. Default "ca:sites:". */
  sharedPrefix?: string
  clock?: () => number
}

export interface CachedSites extends Required<SiteSource> {
  /** Forget one site (and all origin answers), or everything. */
  invalidate(siteKey?: string): void
}

/**
 * Cache a (database-backed) site source in memory. Concurrent lookups of the same key share
 * one request; failures are not cached.
 */
export function cachedSites(source: SiteSource, options: CachedSitesOptions = {}): CachedSites {
  const ttlMs = options.ttlMs ?? 60_000
  const negativeTtlMs = options.negativeTtlMs ?? 10_000
  const maxEntries = options.maxEntries ?? 10_000
  const now = options.clock ?? Date.now
  const entries = new Map<string, { value: unknown; expires: number }>()
  const pending = new Map<string, Promise<unknown>>()

  const shared = options.shared
  const sharedPrefix = options.sharedPrefix ?? 'ca:sites:'

  const cached = async <T>(
    key: string,
    load: () => T | Promise<T>,
    positive: (value: T) => boolean,
  ): Promise<T> => {
    const entry = entries.get(key)
    if (entry && entry.expires > now()) return entry.value as T
    const inFlight = pending.get(key)
    if (inFlight) return inFlight as Promise<T>
    const loadShared = async (): Promise<T> => {
      if (!shared) return load()
      try {
        const hit = await shared.get(sharedPrefix + key)
        if (hit !== undefined) return JSON.parse(hit) as T
      } catch {
        // the shared cache is an optimisation: fall through to the source
      }
      const value = await load()
      shared
        .set(sharedPrefix + key, JSON.stringify(value), positive(value) ? ttlMs : negativeTtlMs)
        .catch(() => {})
      return value
    }
    const promise = (async () => {
      try {
        const value = await loadShared()
        entries.delete(key)
        entries.set(key, { value, expires: now() + (positive(value) ? ttlMs : negativeTtlMs) })
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value!)
        return value
      } finally {
        pending.delete(key)
      }
    })()
    pending.set(key, promise)
    return promise
  }

  return {
    getSite: siteKey =>
      cached(
        `site:${siteKey}`,
        () => source.getSite(siteKey),
        site => site !== null,
      ),
    isOriginAllowed: origin =>
      cached(`origin:${origin}`, () => source.isOriginAllowed(origin), Boolean),
    isCredentialedOrigin: origin =>
      cached(
        `credentials:${origin}`,
        async () => (await source.isCredentialedOrigin?.(origin)) === true,
        Boolean,
      ),
    invalidate(siteKey) {
      if (siteKey === undefined) {
        entries.clear()
        return
      }
      entries.delete(`site:${siteKey}`)
      for (const key of [...entries.keys()]) if (!key.startsWith('site:')) entries.delete(key)
    },
  }
}
