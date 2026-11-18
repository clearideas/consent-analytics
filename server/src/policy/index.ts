// Consent and data policy. A data policy maps the visitor's region to a profile; the profile
// and the site decide the consent policy sent to browsers (`GET /v1/context`) and what the
// collector stores.
import type { Site, TrackingWithoutConsent } from '../sites/index.ts'
import type { Profile } from './data-policy.ts'

export type {
  DataPolicy,
  DataPolicyDocument,
  FullCollection,
  GeoLevel,
  IpLevel,
  LimitedCollection,
  NetworkLevel,
  Profile,
  UserAgentLevel,
} from './data-policy.ts'
export { compileDataPolicy, DataPolicyError } from './data-policy.ts'
export type { Duration } from './duration.ts'
export { addDuration, parseDuration } from './duration.ts'
export type { PresetOptions } from './presets.ts'
export { balancedDataPolicy, strictDataPolicy, US_PRIVACY_STATES } from './presets.ts'
export { EEA_COUNTRIES, EU_COUNTRIES } from './regions.ts'

/** The consent policy for one visitor, as sent in `GET /v1/context`. */
export interface Policy {
  consentRequired: boolean
  policyVersion: string
  trackingWithoutConsent: TrackingWithoutConsent
  reason: 'region' | 'site' | 'unknown-region'
}

/**
 * The site's `consentMode` (`always`/`never`) overrides the region's profile; a site or a
 * profile can each forbid tracking without consent.
 */
export function contextPolicy(site: Site, profile: Profile, regionKnown: boolean): Policy {
  const trackingWithoutConsent: TrackingWithoutConsent =
    site.trackingWithoutConsent === 'none' || profile.consent.withoutConsent === 'none'
      ? 'none'
      : 'limited'
  const base = { policyVersion: site.policyVersion, trackingWithoutConsent }
  if (site.consentMode === 'always') return { ...base, consentRequired: true, reason: 'site' }
  if (site.consentMode === 'never') return { ...base, consentRequired: false, reason: 'site' }
  if (!regionKnown) return { ...base, consentRequired: true, reason: 'unknown-region' }
  return { ...base, consentRequired: profile.consent.required, reason: 'region' }
}
