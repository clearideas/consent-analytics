// The spec's event catalog and limited-tracking lists against what the browser really sends.
// Every standard event is produced by the real library (no hand-written payloads), then:
//  - its props validate against the catalog schema for its name,
//  - every prop key it carries is documented (catalog schema, or FullEventContext for full
//    events), so "if the browser sends it, the spec describes it",
//  - limited events use only x-limited-tracking names and fields,
//  - the collector library's typed projection uses every value the browser sends.
import { describe, expect, it, vi } from 'vitest'

import { createValidator, loadSpec } from '../sample-host/src/spec.ts'
import { normalizeEvent } from '../server/src/index.ts'
import { getAllowedAnonymousFields, isAnonymousTrackable, isEssentialEvent } from '../src/core'
import type { AnalyticsEvent } from '../src/types'
import { boot, CONSENT_REQUIRED_GEO, FULL_TRACKING_GEO, setPageHidden, settle } from './helpers'

const spec = loadSpec()
const validator = createValidator(spec)
const catalog: Record<string, string> = spec['x-event-catalog'].events
const limited: { events: string[]; fields: string[] } = spec['x-limited-tracking']
const schemaName = (ref: string) => ref.split('/').pop()!

/** Property names a schema documents, following $ref and allOf. */
function documentedKeys(name: string): Set<string> {
  const schema = spec.components.schemas[name]
  const keys = new Set<string>(Object.keys(schema.properties ?? {}))
  for (const part of schema.allOf ?? []) {
    for (const key of documentedKeys(schemaName(part.$ref))) keys.add(key)
  }
  return keys
}

/** Produce every standard event (plus an error and a custom event) with the real library. */
async function produceAllEvents(geo: typeof FULL_TRACKING_GEO): Promise<AnalyticsEvent[]> {
  window.history.replaceState(null, '', '/pricing?utm_source=news&utm_campaign=launch&gclid=G1')
  document.title = 'Pricing'
  const observers = new Map<string, (list: { getEntries: () => any[] }) => void>()
  vi.stubGlobal(
    'PerformanceObserver',
    class {
      constructor(private callback: (list: { getEntries: () => any[] }) => void) {}
      observe({ entryTypes, type }: { entryTypes?: string[]; type?: string }) {
        for (const name of entryTypes ?? [type!]) observers.set(name, this.callback)
      }
      disconnect() {}
    },
  )
  const startedAt = Date.now()
  const session = await boot({
    geo,
    beacon: 'available',
    config: {
      autoTrackScrollDepth: true,
      autoTrackTimeSpent: true,
      autoTrackOutboundLinks: true,
    },
  })
  const emit = (type: string, entries: any[]) =>
    observers.get(type)?.({ getEntries: () => entries })

  // web_vital (all six metrics; LCP, CLS and INP are reported when the page is hidden)
  emit('largest-contentful-paint', [{ startTime: 1234.6 }])
  emit('first-input', [{ startTime: 100, processingStart: 112.4, duration: 24, interactionId: 1 }])
  emit('event', [{ startTime: 900, duration: 180, interactionId: 2 }])
  emit('paint', [{ name: 'first-contentful-paint', startTime: 456.7 }])
  emit('navigation', [{ requestStart: 10, responseStart: 75.2 }])
  emit('layout-shift', [{ value: 0.05, hadRecentInput: false, startTime: 300 }])
  // auto_metrics, second phase (after window load)
  window.dispatchEvent(new Event('load'))
  // outbound_link_click
  document.body.innerHTML = '<a id="out" href="https://partner.example/offer?ref=x">Offer</a>'
  document.getElementById('out')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  // scroll_depth
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  Object.defineProperty(document.body, 'scrollHeight', { value: 2000, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true })
  Object.defineProperty(window, 'pageYOffset', { value: 500, configurable: true })
  window.dispatchEvent(new Event('scroll'))
  vi.advanceTimersByTime(300)
  vi.useRealTimers()
  // error and a custom event
  session.analytics.trackError('Something failed', { component: 'checkout' })
  session.analytics.trackEvent('sign_up', { plan: 'pro' })
  await settle()
  // time_spent (needs ≥ 30 s on the page) and page_exit, both when the page is hidden
  vi.spyOn(Date, 'now').mockReturnValue(startedAt + 45_000)
  setPageHidden(true)
  await session.analytics.flush()
  return session.api.events()
}

describe('x-limited-tracking matches the browser', () => {
  it('event names: exactly the essential and anonymous events', () => {
    const candidates = new Set([...Object.keys(catalog), ...limited.events, 'sign_up'])
    for (const name of candidates) {
      const browserSends = isEssentialEvent(name) || isAnonymousTrackable(name)
      expect(browserSends, name).toBe(limited.events.includes(name))
    }
  })

  it('fields: exactly the browser allowlist', () => {
    expect([...limited.fields].sort()).toEqual([...getAllowedAnonymousFields()].sort())
  })
})

describe('x-event-catalog matches the events the browser sends', () => {
  it('full events: every standard event is produced, valid and fully documented', async () => {
    const events = await produceAllEvents(FULL_TRACKING_GEO)
    const names = new Set(events.map(e => e.name))
    for (const name of Object.keys(catalog)) expect(names, `produced ${name}`).toContain(name)
    expect(events.every(e => e.trackingCategory === 'full')).toBe(true)

    const context = documentedKeys('FullEventContext')
    for (const event of events) {
      expect(event.props.attribution, `${event.name} carries attribution`).toMatchObject({
        utm_source: 'news',
        gclid: 'G1',
      })
      const ref = catalog[event.name]
      if (!ref) continue // custom event: caller props
      const schema = schemaName(ref)
      expect(validator.validate(schema as any, event.props), `${event.name} props`).toEqual([])
      if (event.name === 'error') continue // caller props are open-ended
      const documented = new Set([...documentedKeys(schema), ...context])
      const undocumented = Object.keys(event.props).filter(key => !documented.has(key))
      expect(undocumented, `${event.name}: props missing from the spec`).toEqual([])
    }
  })

  it('the collector library uses every value the browser sends in standard events', async () => {
    const events = await produceAllEvents(FULL_TRACKING_GEO)
    const leaves = (value: unknown): unknown[] =>
      value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value]
    let checked = 0
    for (const event of events) {
      if (!catalog[event.name] || event.name === 'error') continue // caller props are open-ended
      const projected = new Set(leaves(normalizeEvent(event.name, event.props as any)))
      // Empty strings and nulls carry no information (e.g. no referrer: a direct visit).
      const unused = Object.entries(event.props).filter(
        ([, value]) =>
          !leaves(value).every(leaf => leaf === '' || leaf === null || projected.has(leaf)),
      )
      expect(unused, `${event.name}: props not used by the projection`).toEqual([])
      checked++
    }
    expect(checked).toBeGreaterThan(8)
  })

  it('limited events: only x-limited-tracking names and fields, valid against the catalog', async () => {
    const events = await produceAllEvents(CONSENT_REQUIRED_GEO)
    expect(events.length).toBeGreaterThan(0)
    const fields = new Set(limited.fields)
    for (const event of events) {
      expect(event.trackingCategory).toBe('limited')
      expect(event.consent.granted).toBe(false)
      expect(limited.events, event.name).toContain(event.name)
      expect(
        Object.keys(event.props).filter(key => !fields.has(key)),
        event.name,
      ).toEqual([])
      const ref = catalog[event.name]
      if (ref) {
        expect(validator.validate(schemaName(ref) as any, event.props), event.name).toEqual([])
      }
    }
  })
})
