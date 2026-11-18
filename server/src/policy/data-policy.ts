// Data policies: which profile applies to a visitor's region, and what that profile allows.
// A policy document is JSON (schemas/data-policy.schema.json); compileDataPolicy validates it,
// enforces the contract's fixed rules, and returns a fast matcher.
import type { Geo } from '../geo/index.ts'
import type { Duration } from './duration.ts'
import { parseDuration } from './duration.ts'
import { validateDataPolicyDocument } from './generated/data-policy-validator.ts'
import { BUILT_IN_REGION_SETS } from './regions.ts'

export type IpLevel = 'none' | 'truncated' | 'hashed' | 'full'
export type GeoLevel = 'none' | 'country' | 'region' | 'city' | 'coords'
export type NetworkLevel = 'none' | 'asn' | 'org'
export type UserAgentLevel = 'none' | 'device-type' | 'parsed' | 'raw'

/** What is stored with full events (statistics consent given, or not required). */
export interface FullCollection {
  ip: IpLevel
  geo: GeoLevel
  network: NetworkLevel
  userAgent: UserAgentLevel
  language: boolean
  privacyFlags: boolean
  gpc: boolean
  identity: boolean
  /** Browser-sent props to drop. */
  clientPropsDeny: readonly string[]
}

/** What is stored with limited events. Never an IP address or identity. */
export interface LimitedCollection {
  geo: 'none' | 'country' | 'region'
  network: 'none' | 'asn'
  userAgent: 'none' | 'device-type' | 'parsed'
  language: boolean
  gpc: boolean
}

export interface Profile {
  name: string
  description?: string
  consent: { required: boolean; withoutConsent: 'limited' | 'none' }
  collect: {
    full: FullCollection
    limited: LimitedCollection
    /** Full collection when the browser sends Sec-GPC: 1 (already merged over `full`). */
    fullWithGlobalPrivacyControl: FullCollection
  }
  retention: { events?: Duration; ip?: Duration; rawUserAgent?: Duration; consents?: Duration }
}

export interface DataPolicy {
  readonly profiles: ReadonlyMap<string, Profile>
  /** The profile for a visitor's location (null: region unknown). */
  select(geo: Geo | null): Profile
  /** Whether any profile stores hashed IP addresses (needs a hash secret). */
  readonly usesHashedIp: boolean
}

// --- document types (schemas/data-policy.schema.json) -----------------------------------

type FullCollectionDocument = Partial<Omit<FullCollection, 'clientPropsDeny'>> & {
  clientProps?: { deny?: string[] }
}

export interface DataPolicyDocument {
  $schema?: string
  version: 1
  description?: string
  regionSets?: Record<string, string[]>
  profiles: Record<
    string,
    {
      description?: string
      consent: { required: boolean; withoutConsent?: 'limited' | 'none' }
      collect?: {
        full?: FullCollectionDocument
        limited?: Partial<LimitedCollection>
        onGlobalPrivacyControl?: FullCollectionDocument
      }
      retention?: { events?: string; ip?: string; rawUserAgent?: string; consents?: string }
    }
  >
  rules: Array<{ match: string | string[]; profile: string }>
}

export class DataPolicyError extends Error {
  readonly problems: readonly string[]

  constructor(problems: string[]) {
    super(`Invalid data policy:\n  - ${problems.join('\n  - ')}`)
    this.name = 'DataPolicyError'
    this.problems = problems
  }
}

const NO_FULL_COLLECTION: FullCollection = {
  ip: 'none',
  geo: 'none',
  network: 'none',
  userAgent: 'none',
  language: false,
  privacyFlags: false,
  gpc: false,
  identity: false,
  clientPropsDeny: [],
}

const NO_LIMITED_COLLECTION: LimitedCollection = {
  geo: 'none',
  network: 'none',
  userAgent: 'none',
  language: false,
  gpc: false,
}

function fullCollection(
  base: FullCollection,
  doc: FullCollectionDocument | undefined,
): FullCollection {
  if (!doc) return base
  const { clientProps, ...levels } = doc
  return {
    ...base,
    ...levels,
    clientPropsDeny: clientProps?.deny ? [...clientProps.deny] : base.clientPropsDeny,
  }
}

interface Matcher {
  profile: Profile
  unknown: boolean
  any: boolean
  countries: ReadonlySet<string>
  subdivisions: ReadonlySet<string>
}

/** Validate a policy document and compile it. Throws DataPolicyError listing every problem. */
export function compileDataPolicy(document: unknown): DataPolicy {
  if (!validateDataPolicyDocument(document)) {
    throw new DataPolicyError(
      (validateDataPolicyDocument.errors ?? []).map(error => {
        const where = error.instancePath || '(document)'
        if (error.keyword === 'additionalProperties') {
          return `${where}: unexpected property "${String(error.params.additionalProperty)}"`
        }
        return `${where}: ${error.message ?? 'invalid'}`
      }),
    )
  }
  const doc = document as DataPolicyDocument
  const problems: string[] = []

  // Region sets: expand nested references; detect unknown names and cycles.
  const sets = doc.regionSets ?? {}
  for (const name of Object.keys(sets)) {
    if (name in BUILT_IN_REGION_SETS)
      problems.push(`/regionSets/${name}: "${name}" is a built-in set`)
  }
  const expanded = new Map<string, Set<string>>()
  const expand = (name: string, trail: string[]): Set<string> => {
    const cached = expanded.get(name)
    if (cached) return cached
    const builtIn = BUILT_IN_REGION_SETS[name]
    if (builtIn) return new Set(builtIn)
    const members = sets[name]
    if (!members) {
      problems.push(
        `${trail.length ? `/regionSets/${trail.at(-1)}` : '/rules'}: unknown region set "@${name}"`,
      )
      return new Set()
    }
    if (trail.includes(name)) {
      problems.push(
        `/regionSets/${name}: circular reference (${[...trail, name].map(n => `@${n}`).join(' -> ')})`,
      )
      return new Set()
    }
    const regions = new Set<string>()
    for (const member of members) {
      if (member.startsWith('@'))
        for (const r of expand(member.slice(1), [...trail, name])) regions.add(r)
      else regions.add(member)
    }
    expanded.set(name, regions)
    return regions
  }

  // Profiles.
  const profiles = new Map<string, Profile>()
  for (const [name, profile] of Object.entries(doc.profiles)) {
    const withoutConsent = profile.consent.withoutConsent ?? 'limited'
    if (withoutConsent === 'none' && !profile.consent.required) {
      problems.push(
        `/profiles/${name}/consent: withoutConsent "none" applies only where consent is required`,
      )
    }
    const full = fullCollection(NO_FULL_COLLECTION, profile.collect?.full)
    const retention: Profile['retention'] = {}
    for (const [key, value] of Object.entries(profile.retention ?? {})) {
      retention[key as keyof Profile['retention']] = parseDuration(value as string)
    }
    profiles.set(name, {
      name,
      ...(profile.description ? { description: profile.description } : {}),
      consent: { required: profile.consent.required, withoutConsent },
      collect: {
        full,
        limited: { ...NO_LIMITED_COLLECTION, ...profile.collect?.limited },
        fullWithGlobalPrivacyControl: fullCollection(full, profile.collect?.onGlobalPrivacyControl),
      },
      retention,
    })
  }

  // Rules.
  const matchers: Matcher[] = []
  doc.rules.forEach((rule, index) => {
    const profile = profiles.get(rule.profile)
    if (!profile) {
      problems.push(`/rules/${index}/profile: unknown profile "${rule.profile}"`)
      return
    }
    const matcher: Matcher = {
      profile,
      unknown: false,
      any: false,
      countries: new Set(),
      subdivisions: new Set(),
    }
    const add = (region: string) => {
      if (region.includes('-')) (matcher.subdivisions as Set<string>).add(region)
      else (matcher.countries as Set<string>).add(region)
    }
    for (const item of Array.isArray(rule.match) ? rule.match : [rule.match]) {
      if (item === 'unknown') matcher.unknown = true
      else if (item === '*') matcher.any = true
      else if (item.startsWith('@')) for (const region of expand(item.slice(1), [])) add(region)
      else add(item)
    }
    matchers.push(matcher)
  })
  if (
    !doc.rules.some(
      rule => rule.match === '*' || (Array.isArray(rule.match) && rule.match.includes('*')),
    )
  ) {
    problems.push('/rules: a catch-all rule ({ "match": "*" }) is required')
  }

  const select = (geo: Geo | null): Profile | undefined => {
    const country = geo?.country
    const subdivision = geo?.regionCode
    for (const matcher of matchers) {
      if (matcher.any) return matcher.profile
      if (!country) {
        if (matcher.unknown) return matcher.profile
        continue
      }
      if (matcher.countries.has(country)) return matcher.profile
      if (subdivision && matcher.subdivisions.has(subdivision)) return matcher.profile
    }
    return undefined
  }

  // The contract's fixed rule: an unknown region requires consent.
  const unknownProfile = select(null)
  if (unknownProfile && !unknownProfile.consent.required) {
    problems.push(
      `/rules: visitors whose region is unknown get profile "${unknownProfile.name}", which must require consent (add { "match": "unknown", "profile": ... } before the catch-all)`,
    )
  }

  if (problems.length) throw new DataPolicyError(problems)

  return {
    profiles,
    select: geo => select(geo)!,
    usesHashedIp: [...profiles.values()].some(
      p => p.collect.full.ip === 'hashed' || p.collect.fullWithGlobalPrivacyControl.ip === 'hashed',
    ),
  }
}
