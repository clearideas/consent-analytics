// Automatic tracking paths: outbound links, scroll depth, interaction counts, web vitals,
// and the opt-in console helpers.
import { describe, expect, it, vi } from 'vitest'

import { boot, setPageHidden, settle } from './helpers'

type Session = Awaited<ReturnType<typeof boot>>

async function flushed(session: Session) {
  await session.analytics.flush()
  return session.api.events()
}

describe('outbound links', () => {
  it('records clicks on links to other origins, without query or fragment', async () => {
    const session = await boot({ config: { autoTrackOutboundLinks: true } })
    document.body.innerHTML = `
      <a id="out" href="https://partner.example/offer?ref=SECRET#x"><span>See <b>offer</b></span></a>
      <a id="same" href="/pricing">Pricing</a>
      <a id="js" href="javascript:void(0)">JS</a>
      <a id="hash" href="#top">Top</a>`

    for (const id of ['out', 'same', 'js', 'hash']) {
      const target = id === 'out' ? document.querySelector('#out b')! : document.getElementById(id)!
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    await settle()

    const clicks = (await flushed(session)).filter(e => e.name === 'outbound_link_click')
    expect(clicks).toHaveLength(1)
    expect(clicks[0]!.props).toMatchObject({
      outboundUrl: 'https://partner.example/offer',
      outboundHost: 'partner.example',
      outboundPath: '/offer',
      outboundText: 'See offer',
    })
    expect(JSON.stringify(clicks)).not.toContain('SECRET')
  })
})

describe('scroll depth', () => {
  it('records each new maximum of at least 25%', async () => {
    const session = await boot({ config: { autoTrackScrollDepth: true } })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    Object.defineProperty(document.body, 'scrollHeight', { value: 4000, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true })

    const scrollTo = (y: number) => {
      Object.defineProperty(window, 'pageYOffset', { value: y, configurable: true })
      window.dispatchEvent(new Event('scroll'))
      vi.advanceTimersByTime(300)
    }
    scrollTo(0) // 25%
    scrollTo(1000) // 50%
    scrollTo(500) // lower: ignored
    scrollTo(3000) // 100%
    vi.useRealTimers()
    await settle()

    const depths = (await flushed(session))
      .filter(e => e.name === 'scroll_depth')
      .map(e => e.props.depth)
    expect(depths).toEqual([25, 50, 100])
  })
})

describe('interaction counts', () => {
  it('page_exit reports clicks and keypresses (ignoring shortcuts) for the page', async () => {
    const session = await boot({ beacon: 'available' })
    document.body.click()
    document.body.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))

    setPageHidden(true)

    const exit = (await session.api.events()).find(e => e.name === 'page_exit')!
    expect(exit.props).toMatchObject({ clicks: 2, keypresses: 1 })
  })
})

describe('web vitals', () => {
  /** A PerformanceObserver stand-in: records how each type is observed; tests emit entries. */
  function stubObservers() {
    const observers = new Map<string, (list: { getEntries: () => any[] }) => void>()
    const options = new Map<string, Record<string, unknown>>()
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        constructor(private callback: (list: { getEntries: () => any[] }) => void) {}
        observe(init: { entryTypes?: string[]; type?: string }) {
          for (const type of init.entryTypes ?? [init.type!]) {
            observers.set(`${type}:${observers.has(`${type}:0`) ? 1 : 0}`, this.callback)
            options.set(type, init)
          }
        }
        disconnect() {}
      },
    )
    const emit = (type: string, entries: any[]) => {
      for (const index of [0, 1]) observers.get(`${type}:${index}`)?.({ getEntries: () => entries })
    }
    return { emit, options }
  }

  const vitalsOf = async (session: Session) =>
    (await session.api.events())
      .filter(e => e.name === 'web_vital')
      .map(e => [e.props.name, e.props.value, e.props.path])

  it('observes buffered entries, so metrics recorded before the library started count', async () => {
    const { options } = stubObservers()
    await boot()
    for (const type of [
      'paint',
      'navigation',
      'largest-contentful-paint',
      'layout-shift',
      'first-input',
      'event',
    ]) {
      expect(options.get(type), type).toMatchObject({ type, buffered: true })
    }
    expect(options.get('event')).toMatchObject({ durationThreshold: 40 })
  })

  it('FCP, TTFB and FID when observed; LCP, CLS and INP when the page is hidden', async () => {
    const { emit } = stubObservers()
    const session = await boot({ beacon: 'available' })

    // first-paint is not FCP; TTFB counts from navigation start.
    emit('paint', [
      { name: 'first-paint', startTime: 300.2 },
      { name: 'first-contentful-paint', startTime: 456.7 },
    ])
    emit('navigation', [{ requestStart: 10, responseStart: 75.2 }])
    emit('largest-contentful-paint', [{ startTime: 800.4 }, { startTime: 1234.6 }])
    emit('first-input', [
      { startTime: 100, processingStart: 112.4, duration: 30, interactionId: 7 },
    ])
    emit('event', [
      { startTime: 2000, duration: 96, interactionId: 8 },
      { startTime: 2001, duration: 120, interactionId: 8 }, // same interaction: the longest part
      { startTime: 2500, duration: 64, interactionId: 9 },
      { startTime: 2600, duration: 500 }, // not an interaction (no interactionId)
    ])
    emit('layout-shift', [
      { value: 0.05, hadRecentInput: false, startTime: 1000 },
      { value: 0.5, hadRecentInput: true, startTime: 1100 }, // after input: ignored
      { value: 0.0123, hadRecentInput: false, startTime: 1500 },
    ])
    await settle()
    await session.analytics.flush()
    expect(await vitalsOf(session)).toEqual([
      ['FCP', 457, '/'],
      ['TTFB', 75, '/'],
      ['FID', 12, '/'],
    ])

    setPageHidden(true)
    await session.analytics.flush()
    const vitals = Object.fromEntries(
      (await vitalsOf(session)).map(([name, value]) => [name, value]),
    )
    expect(vitals).toEqual({ FCP: 457, TTFB: 75, FID: 12, LCP: 1235, CLS: 0.062, INP: 120 })
  })

  it('CLS takes the largest session window, and is reported again only when it changes', async () => {
    const { emit } = stubObservers()
    const session = await boot({ beacon: 'available' })
    emit('layout-shift', [
      { value: 0.1, hadRecentInput: false, startTime: 1000 },
      { value: 0.1, hadRecentInput: false, startTime: 1500 }, // same window: 0.2
      { value: 0.15, hadRecentInput: false, startTime: 4000 }, // gap > 1 s: a new window
    ])
    setPageHidden(true)
    setPageHidden(false)
    setPageHidden(true) // unchanged: not reported again
    emit('layout-shift', [{ value: 0.1, hadRecentInput: false, startTime: 4500 }]) // window 0.25
    setPageHidden(false)
    setPageHidden(true)
    await session.analytics.flush()

    const cls = (await vitalsOf(session))
      .filter(([name]) => name === 'CLS')
      .map(([, value]) => value)
    expect(cls).toEqual([0.2, 0.25])
  })

  it('LCP describes the landing page, even after a single-page navigation', async () => {
    const { emit } = stubObservers()
    const session = await boot({ beacon: 'available' })
    emit('largest-contentful-paint', [{ startTime: 900 }])
    session.navigate('/pricing')
    await settle()
    setPageHidden(true)
    await session.analytics.flush()

    expect((await vitalsOf(session)).find(([name]) => name === 'LCP')).toEqual(['LCP', 900, '/'])
  })

  it('works where the buffered form is not supported, and skips unsupported types', async () => {
    const observed: unknown[] = []
    const Observer = class {
      static supportedEntryTypes = ['paint', 'layout-shift']
      observe(init: { type?: string; entryTypes?: string[] }) {
        if (init.type) throw new TypeError('type is not supported')
        observed.push(init)
      }
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', Observer)
    await boot()
    expect(observed).toEqual([{ entryTypes: ['paint'] }, { entryTypes: ['layout-shift'] }])
  })
})

describe('console helpers (exposeGlobals)', () => {
  it('toggle debug logging and report owner-tracking status', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await boot({ config: { exposeGlobals: true } })
    const ns = (window as any).ciAnalytics

    expect(ns.enableDebug()).toEqual({ enabled: true, source: 'console override' })
    expect(ns.debugStatus().enabled).toBe(true)
    expect(ns.disableDebug()).toEqual({ enabled: false, source: 'console override' })
    expect(ns.ownerTrackingStatus()).toMatchObject({ enabled: false })
    expect(log).toHaveBeenCalled()
  })

  it('opening the banner from the console works', async () => {
    await boot({ config: { exposeGlobals: true } })

    ;(window as any).ciAnalytics.showCookieBanner()

    expect(document.getElementById('ci-consent-banner')).not.toBeNull()
  })
})
