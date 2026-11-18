// Ready-made data policies. They are starting points: review them (and the laws behind them,
// which change) for your own deployment. Each returns an editable policy document.
import type { DataPolicyDocument } from './data-policy.ts'
import { BUILT_IN_REGION_SETS } from './regions.ts'

export interface PresetOptions {
  /** Where consent is required. Default: the EEA (EU, Iceland, Liechtenstein, Norway), UK, Switzerland. */
  consentCountries?: Iterable<string>
  /**
   * Consent countries where browsers may send nothing without consent
   * (`trackingWithoutConsent: none`). Countries not in `consentCountries` are ignored.
   */
  noTrackingWithoutConsentCountries?: Iterable<string>
}

/**
 * US states with comprehensive consumer privacy laws (opt-out regimes, Global Privacy Control
 * signals). The list changes as states legislate: review it.
 */
export const US_PRIVACY_STATES: readonly string[] = [
  'US-CA',
  'US-CO',
  'US-CT',
  'US-DE',
  'US-IA',
  'US-IN',
  'US-KY',
  'US-MD',
  'US-MN',
  'US-MT',
  'US-NE',
  'US-NH',
  'US-NJ',
  'US-OR',
  'US-RI',
  'US-TN',
  'US-TX',
  'US-UT',
  'US-VA',
]

const DEFAULT_CONSENT_REGIONS = ['@EEA', 'GB', 'CH']

const upper = (values: Iterable<string>) => [...values].map(value => value.trim().toUpperCase())

type Profiles = DataPolicyDocument['profiles']

/** Profiles and rules for the consent region, plus a no-tracking variant where configured. */
function consentRegions(
  options: PresetOptions,
  consentProfile: string,
  profiles: Profiles,
): { regionSets: Record<string, string[]>; rules: DataPolicyDocument['rules'] } {
  const consent = options.consentCountries
    ? upper(options.consentCountries)
    : DEFAULT_CONSENT_REGIONS
  const regionSets: Record<string, string[]> = { consent }
  const rules: DataPolicyDocument['rules'] = [{ match: 'unknown', profile: consentProfile }]
  if (options.noTrackingWithoutConsentCountries) {
    const expandedConsent = new Set(
      consent.flatMap(region =>
        region.startsWith('@') ? (BUILT_IN_REGION_SETS[region.slice(1)] ?? []) : [region],
      ),
    )
    const strict = upper(options.noTrackingWithoutConsentCountries).filter(c =>
      expandedConsent.has(c),
    )
    if (strict.length) {
      const name = `${consentProfile}-no-tracking`
      profiles[name] = {
        ...profiles[consentProfile]!,
        consent: { required: true, withoutConsent: 'none' },
      }
      regionSets['no-tracking'] = strict
      rules.push({ match: '@no-tracking', profile: name })
    }
  }
  rules.push({ match: '@consent', profile: consentProfile })
  return { regionSets, rules }
}

/**
 * Consent where required by region; nothing stored beyond what the browser sends; no expiry.
 * (The behavior of the reference collector.)
 */
export function strictDataPolicy(options: PresetOptions = {}): DataPolicyDocument {
  const profiles: Profiles = {
    consent: { description: 'Consent required', consent: { required: true } },
    'no-consent': { description: 'Consent not required', consent: { required: false } },
  }
  const { regionSets, rules } = consentRegions(options, 'consent', profiles)
  return {
    version: 1,
    description: 'strict preset',
    regionSets,
    profiles,
    rules: [...rules, { match: '*', profile: 'no-consent' }],
  }
}

/** Everything the collector can derive, for full events. */
const EVERYTHING = {
  ip: 'full',
  geo: 'coords',
  network: 'org',
  userAgent: 'raw',
  language: true,
  privacyFlags: true,
  gpc: true,
  identity: true,
} as const

/**
 * Everything useful with consent (or where none is required), the minimum without it.
 *
 * - Consent regions (and unknown regions): consent required; with it, everything is stored;
 *   events 25 months (CNIL guidance for audience measurement), IP and raw user agent 30 days.
 * - US privacy states: no consent required; everything, except that a Global Privacy Control
 *   signal drops the IP address and the network owner; events 36 months, IP 180 days.
 * - Everywhere else: no consent required; everything; events 36 months, IP 180 days.
 * - Consent records: 5 years everywhere.
 */
export function balancedDataPolicy(
  options: PresetOptions & { usPrivacyStates?: Iterable<string> } = {},
): DataPolicyDocument {
  const limitedMinimum = {
    geo: 'country',
    userAgent: 'device-type',
    language: true,
    gpc: true,
  } as const
  const limitedOutside = {
    geo: 'region',
    network: 'asn',
    userAgent: 'parsed',
    language: true,
    gpc: true,
  } as const
  const longRetention = { events: '36mo', ip: '180d', rawUserAgent: '180d', consents: '5y' }
  const profiles: Profiles = {
    gdpr: {
      description: 'Consent required: everything with consent, the minimum without',
      consent: { required: true },
      collect: { full: { ...EVERYTHING }, limited: { ...limitedMinimum } },
      retention: { events: '25mo', ip: '30d', rawUserAgent: '30d', consents: '5y' },
    },
    'us-privacy': {
      description: 'US state privacy laws: opt-out, Global Privacy Control honoured',
      consent: { required: false },
      collect: {
        full: { ...EVERYTHING },
        limited: { ...limitedOutside },
        onGlobalPrivacyControl: { ip: 'none', network: 'asn' },
      },
      retention: { ...longRetention },
    },
    open: {
      description: 'No consent required',
      consent: { required: false },
      collect: { full: { ...EVERYTHING }, limited: { ...limitedOutside } },
      retention: { ...longRetention },
    },
  }
  const { regionSets, rules } = consentRegions(options, 'gdpr', profiles)
  regionSets['us-privacy'] = options.usPrivacyStates
    ? upper(options.usPrivacyStates)
    : [...US_PRIVACY_STATES]
  return {
    version: 1,
    description: 'balanced preset',
    regionSets,
    profiles,
    rules: [
      ...rules,
      { match: '@us-privacy', profile: 'us-privacy' },
      { match: '*', profile: 'open' },
    ],
  }
}
