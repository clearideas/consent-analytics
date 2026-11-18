// Event rules (sanitize first) and consent annotations.
import { describe, expect, it } from 'vitest'

import type { Event, RuleContext } from '../src/index.ts'
import { annotateConsent, createRules, defineSite, originAndPath } from '../src/index.ts'

const site = defineSite({
  siteKey: 'my-site',
  allowedOrigins: ['https://a.example'],
  policyVersion: '3',
})
const RECEIVED = new Date('2026-11-10T12:00:10.000Z')

const context = (overrides: Partial<RuleContext> = {}): RuleContext => ({
  site,
  consentRequired: true,
  nothingWithoutConsent: false,
  receivedAt: RECEIVED,
  sentAt: '2026-11-10T12:00:05.000Z',
  ...overrides,
})

const event = (overrides: Partial<Event> = {}): Event => ({
  eventId: 'event-00000001',
  name: 'page_view',
  occurredAt: '2026-11-10T12:00:00.000Z',
  sessionId: 'session-0000001',
  trackingCategory: 'full',
  consent: { required: true, granted: true },
  props: {
    url: 'https://a.example/pricing?plan=pro#top',
    path: '/pricing',
    userAgent: 'UA',
    plan: 'pro',
  },
  ...overrides,
})

const limited = (overrides: Partial<Event> = {}) =>
  event({ trackingCategory: 'limited', consent: { required: true, granted: false }, ...overrides })

describe('standard preset (repair, toward the more private reading)', () => {
  const apply = createRules()

  it('keeps a consistent full event untouched, with a skew-corrected time', () => {
    const input = event()
    const result = apply(input, context())
    expect(result).toEqual({
      keep: true,
      event: input,
      sanitized: [],
      // received 5 s after the client's sentAt: occurredAt + 5 s
      occurredAtCorrected: '2026-11-10T12:00:05.000Z',
    })
    expect(result.keep && result.event).not.toBe(input) // never mutates its input
  })

  it('a full event without consent where consent is required becomes limited (and is sanitized)', () => {
    for (const [eventRequired, regionRequired] of [
      [true, false],
      [false, true],
    ]) {
      const result = apply(
        event({ consent: { required: eventRequired!, granted: false } }),
        context({ consentRequired: regionRequired! }),
      )
      expect(result).toMatchObject({
        keep: true,
        event: {
          trackingCategory: 'limited',
          props: { url: 'https://a.example/pricing', path: '/pricing' },
        },
        sanitized: ['downgraded-to-limited', 'limited-props-removed', 'limited-url-reduced'],
      })
    }
  })

  it('a full event without consent where none is required stays full', () => {
    const result = apply(
      event({ consent: { required: false, granted: false } }),
      context({ consentRequired: false }),
    )
    expect(result).toMatchObject({ keep: true, event: { trackingCategory: 'full' }, sanitized: [] })
  })

  it('a limited event claiming consent loses the claim', () => {
    const result = apply(
      limited({ consent: { required: false, granted: true }, props: { path: '/' } }),
      context(),
    )
    expect(result).toMatchObject({
      keep: true,
      event: { trackingCategory: 'limited', consent: { required: false, granted: false } },
      sanitized: ['consent-granted-cleared'],
    })
  })

  it('an explicit refusal where consent is not required is a valid limited event', () => {
    const refusal = limited({ consent: { required: false, granted: false }, props: { path: '/' } })
    expect(apply(refusal, context({ consentRequired: false }))).toMatchObject({
      keep: true,
      sanitized: [],
    })
  })

  it('limited events: only anonymous event names', () => {
    expect(apply(limited({ name: 'sign_up' }), context())).toEqual({
      keep: false,
      error: { path: '/name', message: 'this event is not collected without consent' },
    })
    for (const name of ['page_view', 'page_exit', 'auto_metrics', 'web_vital', 'error']) {
      expect(apply(limited({ name, props: {} }), context()).keep, name).toBe(true)
    }
  })

  it('limited events: allowlisted props, URLs reduced to origin + path, long messages shortened', () => {
    const result = apply(
      limited({
        name: 'error',
        props: {
          message: 'x'.repeat(600),
          url: 'https://a.example/reset?token=SECRET',
          outboundUrl: 'javascript:alert(1)',
          email: 'a@b.example',
          userId: 'u1',
        },
      }),
      context(),
    )
    expect(result).toEqual({
      keep: true,
      event: expect.objectContaining({
        props: { message: 'x'.repeat(500), url: 'https://a.example/reset' },
      }),
      sanitized: [
        'limited-props-removed',
        'limited-url-reduced',
        'limited-url-removed',
        'limited-message-shortened',
      ],
      occurredAtCorrected: expect.any(String),
    })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('nothing without consent where the region (or site) forbids it', () => {
    expect(apply(limited({ props: {} }), context({ nothingWithoutConsent: true }))).toEqual({
      keep: false,
      error: { path: '/', message: 'nothing is collected without consent in this region' },
    })
    // Where consent is not required, "none" does not apply (refusals are still limited events).
    expect(
      apply(
        limited({ props: {} }),
        context({ nothingWithoutConsent: true, consentRequired: false }),
      ).keep,
    ).toBe(true)
  })

  it('site event name allow and deny lists', () => {
    const lists = defineSite({
      siteKey: 'my-site',
      allowedOrigins: ['https://a.example'],
      eventNames: { allow: ['page_view', 'sign_up'], deny: ['sign_up'] },
    })
    expect(apply(event(), context({ site: lists })).keep).toBe(true)
    expect(apply(event({ name: 'sign_up' }), context({ site: lists }))).toMatchObject({
      keep: false,
    })
    expect(apply(event({ name: 'other' }), context({ site: lists }))).toEqual({
      keep: false,
      error: { path: '/name', message: 'event name not accepted for this site' },
    })
  })
})

describe('time correction', () => {
  const apply = createRules()

  it('implausible corrected times are replaced by the receive time (event kept)', () => {
    for (const occurredAt of ['2026-11-01T00:00:00.000Z', '2026-11-10T13:00:00.000Z']) {
      const result = apply(event({ occurredAt }), context())
      expect(result).toMatchObject({
        keep: true,
        event: { occurredAt },
        occurredAtCorrected: RECEIVED.toISOString(),
        sanitized: ['occurred-at-replaced'],
      })
    }
  })

  it('windows are configurable; an unparseable sentAt means no skew correction', () => {
    const lenient = createRules({ maxPastDays: 30 })
    expect(lenient(event({ occurredAt: '2026-11-01T00:00:00.000Z' }), context())).toMatchObject({
      sanitized: [],
    })
    expect(apply(event(), context({ sentAt: 'garbage' }))).toMatchObject({
      occurredAtCorrected: '2026-11-10T12:00:00.000Z',
    })
  })
})

describe('strict preset (drop instead of repair)', () => {
  const apply = createRules({ preset: 'strict' })

  it.each([
    [
      'full without consent',
      event({ consent: { required: true, granted: false } }),
      '/trackingCategory',
    ],
    [
      'limited claiming consent',
      limited({ consent: { required: true, granted: true } }),
      '/consent/granted',
    ],
    ['limited with extra props', limited({ props: { path: '/', plan: 'pro' } }), '/props/plan'],
  ])('%s is dropped', (_name, input, path) => {
    expect(apply(input, context())).toMatchObject({ keep: false, error: { path } })
  })

  it('still repairs URLs and times', () => {
    expect(apply(limited({ props: { url: 'https://a.example/x?q=1' } }), context())).toMatchObject({
      keep: true,
      sanitized: ['limited-url-reduced'],
    })
  })
})

describe('off preset and custom rules', () => {
  it('off applies no rules (times are still corrected)', () => {
    const apply = createRules({ preset: 'off' })
    expect(apply(limited({ name: 'sign_up', props: { email: 'x' } }), context())).toMatchObject({
      keep: true,
      event: { name: 'sign_up', props: { email: 'x' } },
    })
  })

  it('custom rules run after the built-in ones and can drop or modify', () => {
    const apply = createRules({
      custom: [
        e =>
          e.name === 'internal_test'
            ? { drop: { path: '/name', message: 'test traffic' } }
            : undefined,
        e => ({
          event: { ...e, props: { ...e.props, enriched: true } },
          sanitized: 'custom-enriched',
        }),
      ],
    })
    expect(apply(event({ name: 'internal_test' }), context())).toEqual({
      keep: false,
      error: { path: '/name', message: 'test traffic' },
    })
    expect(apply(event(), context())).toMatchObject({
      keep: true,
      event: { props: { enriched: true } },
      sanitized: ['custom-enriched'],
    })
  })

  it('rejects an unknown preset', () => {
    expect(() => createRules({ preset: 'lenient' as any })).toThrow(/standard, strict or off/)
  })
})

describe('originAndPath', () => {
  it.each([
    ['https://user:pw@a.example:8443/p/a?q=1#f', 'https://a.example:8443/p/a'],
    ['http://a.example', 'http://a.example/'],
    ['/relative', undefined],
    ['mailto:x@a.example', undefined],
  ])('%s', (input, expected) => {
    expect(originAndPath(input)).toBe(expected)
  })
})

describe('annotateConsent', () => {
  const record = (
    decision: string,
    categories?: [boolean, boolean, boolean],
    policyVersion = '3',
  ) => ({
    decision,
    policyVersion,
    categories: categories
      ? { preferences: categories[0], statistics: categories[1], marketing: categories[2] }
      : undefined,
  })

  it('consistent records have no annotations', () => {
    expect(annotateConsent(record('granted', [true, true, true]), site)).toEqual([])
    expect(annotateConsent(record('denied', [false, false, false]), site)).toEqual([])
    expect(annotateConsent(record('partial', [false, true, false]), site)).toEqual([])
    expect(annotateConsent(record('granted'), site)).toEqual([])
  })

  it('flags contradictions and stale policy versions (the record itself is never changed)', () => {
    expect(annotateConsent(record('granted', [false, false, false]), site)).toEqual([
      'decision-categories-mismatch',
    ])
    expect(annotateConsent(record('denied', [true, false, false]), site)).toEqual([
      'decision-categories-mismatch',
    ])
    expect(annotateConsent(record('partial', [true, true, true]), site)).toEqual([
      'decision-categories-mismatch',
    ])
    expect(annotateConsent(record('partial'), site)).toEqual(['partial-without-categories'])
    expect(annotateConsent(record('granted', [true, true, true], '2'), site)).toEqual([
      'policy-version-not-current',
    ])
  })
})
