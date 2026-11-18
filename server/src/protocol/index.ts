// The v1 contract (spec/openapi.yaml) as code: limits, patterns, schema validation, and the
// lists that describe what `limited` events may contain. Everything schema-related is
// generated from the spec (src/protocol/generated), so it cannot drift from the contract.
import { LIMITED_TRACKING, type SchemaName } from './generated/spec.ts'
import { validators } from './generated/validators.ts'

export {
  CATALOG_PROPERTIES,
  EVENT_CATALOG,
  LIMITED_TRACKING,
  SCHEMA_NAMES,
  type SchemaName,
  SPEC_VERSION,
  type StandardEventName,
} from './generated/spec.ts'
export type * from './generated/types.ts'

/** Maximum `POST /v1/events` body size in bytes (the `sendBeacon` limit). */
export const EVENTS_MAX_BYTES = 65_536
/** Maximum `POST /v1/consent` body size in bytes. */
export const CONSENT_MAX_BYTES = 4_096
/** Public site identifier (SiteKey). */
export const SITE_KEY_PATTERN = /^[A-Za-z0-9._-]{3,64}$/

/** A validation problem, reported to clients in `rejected[].errors` and problem details. */
export interface FieldError {
  /** JSON Pointer to the offending value, relative to the validated document. */
  path: string
  message: string
}

/**
 * Validate `data` against a schema of the spec. Returns an empty array when valid.
 * All errors are reported (not only the first).
 */
export function validate(schema: SchemaName, data: unknown): FieldError[] {
  const validator = validators[schema]
  if (!validator) throw new Error(`Unknown schema: ${schema}`)
  if (validator(data)) return []
  return (validator.errors ?? []).map(error => ({
    path: error.instancePath || '/',
    message:
      error.keyword === 'additionalProperties'
        ? `unexpected property "${String(error.params.additionalProperty)}"`
        : (error.message ?? 'invalid'),
  }))
}

const LIMITED_EVENTS: ReadonlySet<string> = new Set(LIMITED_TRACKING.events)
const LIMITED_FIELDS: ReadonlySet<string> = new Set(LIMITED_TRACKING.fields)

/** Whether an event name may be sent in a `limited` event. */
export function isLimitedEventName(name: string): boolean {
  return (LIMITED_EVENTS as ReadonlySet<string>).has(name)
}

/** Whether a top-level props key may be present in a `limited` event. */
export function isLimitedField(key: string): boolean {
  return (LIMITED_FIELDS as ReadonlySet<string>).has(key)
}
