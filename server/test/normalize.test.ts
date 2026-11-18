// The typed projection of event props, following the spec's event catalog.
import { describe, expect, it } from 'vitest'

import { CATALOG_PROPERTIES, EVENT_CATALOG, normalizeEvent } from '../src/index.ts'
import { spec } from './support/spec.ts'

describe('normalizeEvent', () => {
  it('page_view: page context, browser context and attribution (nested wins over top level)', () => {
    expect(
      normalizeEvent('page_view', {
        url: 'https://a.example/pricing?plan=pro',
        path: '/pricing',
        referrer: 'https://google.com/',
        pageTitle: 'Pricing',
        viewportBucket: 'lg',
        deviceBucket: 'desktop',
        connectionType: '4g',
        userAgent: 'UA',
        timezone: 'Europe/Berlin',
        language: 'de-DE',
        country: 'DE',
        continent: 'EU',
        utm_source: 'top-level',
        utm_medium: 'cpc',
        gclid: 'G1',
        attribution: {
          utm_source: 'news',
          landingPath: '/',
          firstSeen: '2026-11-01T00:00:00.000Z',
          junk: 1,
        },
      }),
    ).toEqual({
      page: {
        url: 'https://a.example/pricing?plan=pro',
        path: '/pricing',
        referrer: 'https://google.com/',
        title: 'Pricing',
        viewportBucket: 'lg',
        deviceBucket: 'desktop',
        connectionType: '4g',
      },
      client: {
        userAgent: 'UA',
        timezone: 'Europe/Berlin',
        language: 'de-DE',
        country: 'DE',
        continent: 'EU',
      },
      attribution: {
        utm_source: 'news',
        utm_medium: 'cpc',
        gclid: 'G1',
        landingPath: '/',
        firstSeen: '2026-11-01T00:00:00.000Z',
      },
    })
  })

  it('engagement: timeSpent from timeSpent, timeSpentTotal or duration; scroll depth', () => {
    expect(
      normalizeEvent('page_exit', {
        timeSpent: 12,
        timeSpentTotal: 12,
        clicks: 0,
        keypresses: 3,
        maxScrollDepth: 50,
      }),
    ).toEqual({
      engagement: { timeSpent: 12, clicks: 0, keypresses: 3, maxScrollDepth: 50 },
    })
    expect(normalizeEvent('time_spent', { duration: 45 }).engagement).toEqual({ timeSpent: 45 })
    expect(normalizeEvent('scroll_depth', { depth: 75, path: '/docs' })).toEqual({
      page: { path: '/docs' },
      engagement: { scrollDepth: 75 },
    })
  })

  it('web_vital, auto_metrics (with phase), outbound_link_click, error', () => {
    expect(normalizeEvent('web_vital', { name: 'CLS', value: 0.062 }).vital).toEqual({
      name: 'CLS',
      value: 0.062,
    })
    expect(
      normalizeEvent('auto_metrics', { domContentLoadedTime: 800, totalResources: 12 }).load,
    ).toEqual({
      phase: 'dom',
      domContentLoadedTime: 800,
      totalResources: 12,
    })
    expect(
      normalizeEvent('auto_metrics', { fullyLoadedTime: 1500, pageLoadTime: 1400 }).load,
    ).toEqual({
      phase: 'load',
      fullyLoadedTime: 1500,
      pageLoadTime: 1400,
    })
    expect(
      normalizeEvent('outbound_link_click', {
        outboundUrl: 'https://partner.example/offer',
        outboundHost: 'partner.example',
        outboundPath: '/offer',
        outboundText: 'See offer',
      }).outbound,
    ).toEqual({
      url: 'https://partner.example/offer',
      host: 'partner.example',
      path: '/offer',
      text: 'See offer',
    })
    expect(normalizeEvent('error', { message: 'boom', component: 'checkout' }).error).toEqual({
      message: 'boom',
    })
  })

  it('ignores values of the wrong type, and maps nothing it does not know', () => {
    expect(
      normalizeEvent('page_exit', {
        path: 42,
        clicks: '3',
        timeSpent: Number.NaN,
        title: '',
        attribution: 'x',
      }),
    ).toEqual({})
    expect(normalizeEvent('sign_up', { plan: 'pro', amount: 10 })).toEqual({})
    expect(normalizeEvent('web_vital', { name: 'LCP' })).toEqual({})
  })

  it('marks events whose props the browser had to drop', () => {
    expect(normalizeEvent('page_view', { propsTruncated: true })).toEqual({ propsTruncated: true })
  })
})

describe('every documented catalog prop is used', () => {
  // For each property of each catalog schema, a sample value must appear in the projection.
  const schemas = spec.components.schemas
  const sample = (property: any, name: string): unknown => {
    const resolved = property.$ref ? schemas[property.$ref.split('/').pop()] : property
    if (resolved.enum) return resolved.enum[0]
    if (resolved.type === 'integer') return 42
    if (resolved.type === 'number') return 4.2
    if (resolved.type === 'boolean') return true
    return `sample-${name}`
  }
  const values = (value: unknown): unknown[] =>
    value && typeof value === 'object' ? Object.values(value).flatMap(values) : [value]

  const eventFor = (schema: string) =>
    Object.entries(EVENT_CATALOG).find(([, s]) => s === schema)?.[0] ??
    (schema === 'EngagementProps' ? 'page_exit' : 'page_view')

  const cases = Object.entries(CATALOG_PROPERTIES).flatMap(([schema, { properties }]) =>
    properties
      .filter(property => !(schema === 'FullEventContext' && property === 'attribution')) // covered by Attribution
      .map(property => [schema, property] as const),
  )

  it.each(cases)('%s.%s', (schema, property) => {
    const value = sample(schemas[schema].properties[property], property)
    const props =
      schema === 'Attribution' ? { attribution: { [property]: value } } : { [property]: value }
    const projection = normalizeEvent(eventFor(schema), props as any)
    // auto_metrics also records its phase; web_vital needs both fields to form a vital.
    const withPair =
      schema === 'WebVitalProps'
        ? normalizeEvent('web_vital', { name: 'LCP', value: 1, [property]: value } as any)
        : projection
    expect(values(withPair), `${schema}.${property} is mapped`).toContain(value)
  })

  it('covers every schema in the catalog', () => {
    expect(cases.length).toBeGreaterThan(60)
    for (const schema of Object.values(EVENT_CATALOG))
      expect(Object.keys(CATALOG_PROPERTIES)).toContain(schema)
  })
})
