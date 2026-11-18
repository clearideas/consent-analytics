// Data policies: validation (schema and fixed rules), region matching, presets, the consent
// policy sent to browsers, and retention durations.
import { describe, expect, it } from 'vitest'

import type { DataPolicyDocument, Geo } from '../src/index.ts'
import {
  addDuration,
  balancedDataPolicy,
  compileDataPolicy,
  contextPolicy,
  DataPolicyError,
  defineSite,
  EEA_COUNTRIES,
  EU_COUNTRIES,
  parseDuration,
  strictDataPolicy,
  US_PRIVACY_STATES,
} from '../src/index.ts'

const minimal = (): DataPolicyDocument => ({
  version: 1,
  profiles: { consent: { consent: { required: true } }, open: { consent: { required: false } } },
  rules: [
    { match: 'unknown', profile: 'consent' },
    { match: '*', profile: 'open' },
  ],
})

function problems(document: unknown): string[] {
  try {
    compileDataPolicy(document)
  } catch (error) {
    expect(error).toBeInstanceOf(DataPolicyError)
    return [...(error as DataPolicyError).problems]
  }
  throw new Error('expected the policy to be rejected')
}

describe('compileDataPolicy: validation', () => {
  it('accepts a minimal policy and fills defaults (nothing collected, no retention)', () => {
    const profile = compileDataPolicy(minimal()).select({ country: 'US' })
    expect(profile).toEqual({
      name: 'open',
      consent: { required: false, withoutConsent: 'limited' },
      collect: {
        full: {
          ip: 'none',
          geo: 'none',
          network: 'none',
          userAgent: 'none',
          language: false,
          privacyFlags: false,
          gpc: false,
          identity: false,
          clientPropsDeny: [],
        },
        limited: { geo: 'none', network: 'none', userAgent: 'none', language: false, gpc: false },
        fullWithGlobalPrivacyControl: expect.objectContaining({ ip: 'none' }),
      },
      retention: {},
    })
  })

  it('reports schema violations with their location', () => {
    expect(problems({ version: 2, profiles: {}, rules: [], extra: 1 })).toEqual(
      expect.arrayContaining([
        '/version: must be equal to constant',
        '/profiles: must NOT have fewer than 1 properties',
        '/rules: must NOT have fewer than 1 items',
        '(document): unexpected property "extra"',
      ]),
    )
    const limitedWithIp = minimal()
    ;(limitedWithIp.profiles.open as any).collect = { limited: { ip: 'full' } }
    expect(problems(limitedWithIp)).toEqual([
      '/profiles/open/collect/limited: unexpected property "ip"',
    ])
    const badRegion = minimal()
    badRegion.rules.unshift({ match: 'de', profile: 'consent' })
    expect(problems(badRegion).join()).toMatch(/^\/rules\/0\/match/)
    const badDuration = minimal()
    badDuration.profiles.open!.retention = { events: '2 years' }
    expect(problems(badDuration).join()).toMatch(/retention\/events/)
  })

  it('requires a catch-all rule and existing profiles', () => {
    const noCatchAll = minimal()
    noCatchAll.rules = [
      { match: 'unknown', profile: 'consent' },
      { match: 'US', profile: 'open' },
    ]
    expect(problems(noCatchAll)).toEqual([
      '/rules: a catch-all rule ({ "match": "*" }) is required',
    ])
    const missing = minimal()
    missing.rules.push({ match: 'FR', profile: 'nope' })
    expect(problems(missing)).toEqual(['/rules/2/profile: unknown profile "nope"'])
  })

  it('enforces the contract: an unknown region must require consent', () => {
    const catchAllFirst = minimal()
    catchAllFirst.rules = [{ match: '*', profile: 'open' }]
    expect(problems(catchAllFirst)[0]).toMatch(
      /region is unknown get profile "open", which must require consent/,
    )
    // An explicit "unknown" rule that does not require consent is rejected too.
    const unknownOpen = minimal()
    unknownOpen.rules = [
      { match: ['unknown', 'US'], profile: 'open' },
      { match: '*', profile: 'consent' },
    ]
    expect(problems(unknownOpen)[0]).toMatch(/must require consent/)
  })

  it('"withoutConsent: none" only where consent is required', () => {
    const policy = minimal()
    policy.profiles.open!.consent.withoutConsent = 'none'
    expect(problems(policy)).toEqual([
      '/profiles/open/consent: withoutConsent "none" applies only where consent is required',
    ])
  })

  it('region sets: unknown names, cycles and built-in names are rejected', () => {
    const policy = minimal()
    policy.regionSets = { a: ['@b'], b: ['@a'], EU: ['FR'] }
    policy.rules.unshift({ match: ['@a', '@missing'], profile: 'consent' })
    expect(problems(policy)).toEqual(
      expect.arrayContaining([
        '/regionSets/EU: "EU" is a built-in set',
        expect.stringMatching(/circular reference \(@a -> @b -> @a\)/),
        '/rules: unknown region set "@missing"',
      ]),
    )
  })

  it('collects every problem at once', () => {
    const policy = minimal()
    policy.rules = [{ match: 'FR', profile: 'nope' }]
    policy.profiles.open!.consent.withoutConsent = 'none'
    expect(problems(policy)).toHaveLength(3)
  })
})

describe('compileDataPolicy: selection', () => {
  const policy = compileDataPolicy({
    version: 1,
    regionSets: { gdpr: ['@EEA', 'GB'], west: ['US-CA', 'US-OR'], nested: ['@gdpr', 'CH'] },
    profiles: {
      gdpr: { consent: { required: true } },
      swiss: { consent: { required: true } },
      west: { consent: { required: false } },
      us: { consent: { required: false } },
      other: { consent: { required: false } },
    },
    rules: [
      { match: 'unknown', profile: 'gdpr' },
      { match: '@west', profile: 'west' },
      { match: 'US', profile: 'us' },
      { match: 'CH', profile: 'swiss' },
      { match: '@nested', profile: 'gdpr' },
      { match: '*', profile: 'other' },
    ],
  })
  const pick = (geo: Geo | null) => policy.select(geo).name

  it('first matching rule wins: subdivisions, countries, nested sets, catch-all', () => {
    expect(pick(null)).toBe('gdpr')
    expect(pick({ country: 'US', regionCode: 'US-CA' })).toBe('west')
    expect(pick({ country: 'US', regionCode: 'US-NY' })).toBe('us')
    expect(pick({ country: 'US' })).toBe('us')
    expect(pick({ country: 'CH' })).toBe('swiss') // before @nested, which also contains CH
    expect(pick({ country: 'NO' })).toBe('gdpr') // @EEA via @nested
    expect(pick({ country: 'GB' })).toBe('gdpr')
    expect(pick({ country: 'BR' })).toBe('other')
  })

  it('built-in sets', () => {
    expect(EU_COUNTRIES).toHaveLength(27)
    expect(EEA_COUNTRIES).toEqual([...EU_COUNTRIES, 'IS', 'LI', 'NO'])
  })
})

describe('presets', () => {
  it('strict: consent in the EEA, UK, Switzerland and unknown regions; nothing collected; no expiry', () => {
    const policy = compileDataPolicy(strictDataPolicy())
    for (const country of [...EEA_COUNTRIES, 'GB', 'CH']) {
      expect(policy.select({ country }).consent.required, country).toBe(true)
    }
    expect(policy.select(null).consent.required).toBe(true)
    expect(policy.select({ country: 'US' }).consent.required).toBe(false)
    for (const profile of policy.profiles.values()) {
      expect(profile.collect.full).toMatchObject({
        ip: 'none',
        geo: 'none',
        userAgent: 'none',
        identity: false,
      })
      expect(profile.retention).toEqual({})
    }
  })

  it('balanced: profiles by region, everything with consent, retention per region', () => {
    const policy = compileDataPolicy(balancedDataPolicy())
    expect(policy.select({ country: 'DE' }).name).toBe('gdpr')
    expect(policy.select(null).name).toBe('gdpr')
    expect(policy.select({ country: 'US', regionCode: 'US-CA' }).name).toBe('us-privacy')
    expect(policy.select({ country: 'US', regionCode: 'US-NY' }).name).toBe('open')
    expect(policy.select({ country: 'BR' }).name).toBe('open')

    const gdpr = policy.select({ country: 'FR' })
    expect(gdpr.consent.required).toBe(true)
    expect(gdpr.collect.full).toMatchObject({
      ip: 'full',
      geo: 'coords',
      network: 'org',
      userAgent: 'raw',
      identity: true,
    })
    expect(gdpr.collect.limited).toEqual({
      geo: 'country',
      network: 'none',
      userAgent: 'device-type',
      language: true,
      gpc: true,
    })
    expect(gdpr.retention).toEqual({
      events: { amount: 25, unit: 'mo' },
      ip: { amount: 30, unit: 'd' },
      rawUserAgent: { amount: 30, unit: 'd' },
      consents: { amount: 5, unit: 'y' },
    })

    const usPrivacy = policy.select({ country: 'US', regionCode: 'US-CO' })
    expect(usPrivacy.collect.fullWithGlobalPrivacyControl).toMatchObject({
      ip: 'none',
      network: 'asn',
      geo: 'coords',
    })
    expect(policy.select({ country: 'BR' }).collect.fullWithGlobalPrivacyControl.ip).toBe('full')
    expect(US_PRIVACY_STATES).toContain('US-CA')
  })

  it('custom consent countries and no-tracking countries (only where consent is required)', () => {
    const policy = compileDataPolicy(
      balancedDataPolicy({
        consentCountries: ['br', '@EU'],
        noTrackingWithoutConsentCountries: ['de', 'US'],
      }),
    )
    expect(policy.select({ country: 'BR' }).name).toBe('gdpr')
    expect(policy.select({ country: 'GB' }).name).toBe('open')
    const germany = policy.select({ country: 'DE' })
    expect(germany.name).toBe('gdpr-no-tracking')
    expect(germany.consent).toEqual({ required: true, withoutConsent: 'none' })
    expect(germany.collect).toEqual(policy.select({ country: 'FR' }).collect)
    expect(policy.select({ country: 'US' }).consent.withoutConsent).toBe('limited') // not a consent country
  })

  it('presets are plain documents you can edit', () => {
    const document = balancedDataPolicy()
    document.profiles.open!.retention = { events: '12mo' }
    expect(compileDataPolicy(document).select({ country: 'BR' }).retention.events).toEqual({
      amount: 12,
      unit: 'mo',
    })
    expect(() => compileDataPolicy(JSON.parse(JSON.stringify(strictDataPolicy())))).not.toThrow()
  })
})

describe('contextPolicy', () => {
  const policy = compileDataPolicy(strictDataPolicy({ noTrackingWithoutConsentCountries: ['DE'] }))
  const site = (overrides = {}) =>
    defineSite({
      siteKey: 'my-site',
      allowedOrigins: ['https://a.example'],
      policyVersion: '9',
      ...overrides,
    })

  it('region profile, unknown region, site consent modes, no tracking without consent', () => {
    expect(contextPolicy(site(), policy.select({ country: 'FR' }), true)).toEqual({
      consentRequired: true,
      policyVersion: '9',
      trackingWithoutConsent: 'limited',
      reason: 'region',
    })
    expect(
      contextPolicy(site(), policy.select({ country: 'DE' }), true).trackingWithoutConsent,
    ).toBe('none')
    expect(contextPolicy(site(), policy.select({ country: 'US' }), true)).toMatchObject({
      consentRequired: false,
      reason: 'region',
    })
    expect(contextPolicy(site(), policy.select(null), false)).toMatchObject({
      consentRequired: true,
      reason: 'unknown-region',
    })
    expect(
      contextPolicy(site({ consentMode: 'always' }), policy.select({ country: 'US' }), true),
    ).toMatchObject({
      consentRequired: true,
      reason: 'site',
    })
    expect(contextPolicy(site({ consentMode: 'never' }), policy.select(null), false)).toMatchObject(
      {
        consentRequired: false,
        reason: 'site',
      },
    )
    expect(
      contextPolicy(
        site({ trackingWithoutConsent: 'none' }),
        policy.select({ country: 'FR' }),
        true,
      ).trackingWithoutConsent,
    ).toBe('none')
  })
})

describe('durations', () => {
  it('parses d, w, mo, y and rejects anything else', () => {
    expect(parseDuration('30d')).toEqual({ amount: 30, unit: 'd' })
    expect(parseDuration('25mo')).toEqual({ amount: 25, unit: 'mo' })
    for (const bad of ['30', '1.5y', '-1d', '5 y', '12m', ''])
      expect(() => parseDuration(bad)).toThrow()
  })

  it('adds calendar months and years, clamped to the end of the month', () => {
    const at = (iso: string) => new Date(iso)
    expect(addDuration(at('2026-01-31T10:00:00Z'), parseDuration('1mo')).toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    )
    expect(addDuration(at('2027-01-31T10:00:00Z'), parseDuration('13mo')).toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    )
    expect(addDuration(at('2024-02-29T00:00:00Z'), parseDuration('1y')).toISOString()).toBe(
      '2025-02-28T00:00:00.000Z',
    )
    expect(addDuration(at('2026-11-10T12:00:00Z'), parseDuration('25mo')).toISOString()).toBe(
      '2028-12-10T12:00:00.000Z',
    )
    expect(addDuration(at('2026-12-30T00:00:00Z'), parseDuration('2w')).toISOString()).toBe(
      '2027-01-13T00:00:00.000Z',
    )
    expect(addDuration(at('2026-11-10T12:00:00Z'), parseDuration('30d')).toISOString()).toBe(
      '2026-12-10T12:00:00.000Z',
    )
  })
})
