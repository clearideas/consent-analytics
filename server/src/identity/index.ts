// Visitor identity, from your own authentication (never from the request body).
//
// Your `identify` function returns whatever describes the signed-in visitor, e.g.
// `{ userId, accountId, plan }`. The configured `keys` are stored with full events and consent
// records (and indexed by stores); `traits` are kept once per identity (store.upsertIdentity),
// not copied onto every event. Anything else is dropped.
import type { Logger } from '../core/logger.ts'

export type IdentityValue = string | number | boolean
export type Identity = Record<string, IdentityValue>

export interface IdentityOptions {
  /** Identifying keys, stored with events and consent records. Default: userId, accountId. */
  keys?: readonly string[]
  /** Extra attributes kept per identity (not per event). Default: none. */
  traits?: readonly string[]
  /** Longest string value accepted. Default 256. */
  maxValueLength?: number
  /** Link consent records to the identity (proof of which account decided). Default true. */
  consentRecords?: boolean
}

export interface ResolvedIdentity {
  identity: Identity
  traits?: Identity
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export function identityConfig(options: IdentityOptions = {}) {
  const keys = [...(options.keys ?? ['userId', 'accountId'])]
  const traits = [...(options.traits ?? [])]
  for (const name of [...keys, ...traits]) {
    if (!NAME.test(name)) throw new Error(`identity: "${name}" is not a valid key name`)
  }
  if (!keys.length) throw new Error('identity.keys must name at least one key')
  const overlap = keys.filter(key => traits.includes(key))
  if (overlap.length) throw new Error(`identity: "${overlap[0]}" is both a key and a trait`)
  const maxValueLength = options.maxValueLength ?? 256
  return {
    keys,
    traits,
    maxValueLength,
    consentRecords: options.consentRecords !== false,
  }
}

export type IdentityConfig = ReturnType<typeof identityConfig>

/**
 * Split what `identify` returned into stored keys and traits. Invalid values and unknown
 * names are dropped (each unknown name is logged once). No key at all means no identity.
 */
export function sanitizeIdentity(
  value: unknown,
  config: IdentityConfig,
  logger: Logger,
  warned: Set<string>,
): ResolvedIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const valid = (v: unknown): v is IdentityValue =>
    (typeof v === 'string' && v.length > 0 && v.length <= config.maxValueLength) ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    typeof v === 'boolean'
  const identity: Identity = {}
  const traits: Identity = {}
  for (const [name, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue
    const target = config.keys.includes(name)
      ? identity
      : config.traits.includes(name)
        ? traits
        : undefined
    if (!target) {
      if (!warned.has(name)) {
        warned.add(name)
        logger.warn(
          { name },
          'identify returned a name that is neither an identity key nor a trait; it is not stored',
        )
      }
      continue
    }
    if (valid(v)) target[name] = v
  }
  if (!Object.keys(identity).length) return undefined
  return Object.keys(traits).length ? { identity, traits } : { identity }
}
