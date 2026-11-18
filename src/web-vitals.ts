// Web vitals of the current document, measured with the browser's Performance APIs:
//
//   FCP   first-contentful-paint           reported once, when observed
//   TTFB  navigation responseStart         reported once, when observed
//   FID   first input delay                reported once, when observed
//   LCP   the last largest-contentful-paint reported when the page is first hidden
//   CLS   largest session window of shifts reported when hidden, if it changed
//   INP   (near) worst interaction latency reported when hidden, if it changed
//
// Observers are registered with `buffered: true`: the library usually starts after the
// first paint and the navigation response, and without it those entries are never seen.
// They describe the document, so they are not measured again on single-page navigations.

export interface WebVitalsOptions {
  /** Queue a `web_vital` event (normal delivery). */
  report: (name: string, value: number) => void
  /** Queue a `web_vital` event while the page is being hidden (sent with the same beacon). */
  reportNow: (name: string, value: number) => void
  /** Register work for when the page is hidden or unloaded. */
  onHidden: (handler: () => void) => void
  /** Register cleanup (observers are disconnected on destroy). */
  onCleanup: (cleanup: () => void) => void
  debug?: (message: string) => void
}

type EntryCallback = (entries: any[]) => void

/** Observe one entry type, including entries recorded before the call (buffered). */
function observe(
  type: string,
  callback: EntryCallback,
  options: WebVitalsOptions,
  extra: Record<string, unknown> = {},
): boolean {
  if (typeof PerformanceObserver === 'undefined') return false
  const supported = (PerformanceObserver as { supportedEntryTypes?: readonly string[] })
    .supportedEntryTypes
  if (supported && !supported.includes(type)) {
    options.debug?.(`${type} entries are not supported`)
    return false
  }
  try {
    const observer = new PerformanceObserver(list => callback(list.getEntries()))
    try {
      observer.observe({ type, buffered: true, ...extra } as PerformanceObserverInit)
    } catch {
      // Browsers without the `type` form (before 2020) only take entryTypes, unbuffered.
      observer.observe({ entryTypes: [type] })
    }
    options.onCleanup(() => observer.disconnect())
    return true
  } catch {
    options.debug?.(`${type} observer not supported`)
    return false
  }
}

const round = (value: number) => Math.round(value)

export function observeWebVitals(options: WebVitalsOptions): void {
  const { report, reportNow, onHidden } = options

  // FCP: the paint entry named first-contentful-paint (not first-paint).
  let fcpReported = false
  observe(
    'paint',
    entries => {
      const fcp = entries.find(entry => entry.name === 'first-contentful-paint')
      if (fcp && !fcpReported) {
        fcpReported = true
        report('FCP', round(fcp.startTime))
      }
    },
    options,
  )

  // TTFB: from navigation start to the first byte of the response (as web.dev defines it),
  // minus the time a prerendered page waited before it was shown.
  let ttfbReported = false
  observe(
    'navigation',
    entries => {
      const navigation = entries[0]
      if (!navigation || ttfbReported) return
      const ttfb = navigation.responseStart - (navigation.activationStart ?? 0)
      if (Number.isFinite(ttfb) && ttfb > 0) {
        ttfbReported = true
        report('TTFB', round(ttfb))
      }
    },
    options,
  )

  // FID: the delay before the first input was handled.
  let fidReported = false
  observe(
    'first-input',
    entries => {
      const first = entries[0]
      if (!first || fidReported) return
      fidReported = true
      report('FID', round(first.processingStart - first.startTime))
    },
    options,
  )

  // LCP: candidates keep coming until the visitor interacts; the last one counts.
  let lcp: number | undefined
  let lcpReported = false
  observe(
    'largest-contentful-paint',
    entries => {
      const last = entries[entries.length - 1]
      if (last) lcp = last.startTime
    },
    options,
  )

  // CLS: layout shifts not caused by input, grouped into session windows (gaps under 1 s,
  // at most 5 s long); the largest window counts.
  let cls = 0
  let windowValue = 0
  let windowStart = 0
  let windowLast = 0
  observe(
    'layout-shift',
    entries => {
      for (const entry of entries) {
        if (entry.hadRecentInput) continue
        const continues =
          windowValue > 0 &&
          entry.startTime - windowLast < 1000 &&
          entry.startTime - windowStart < 5000
        if (continues) windowValue += entry.value
        else {
          windowValue = entry.value
          windowStart = entry.startTime
        }
        windowLast = entry.startTime
        cls = Math.max(cls, windowValue)
      }
    },
    options,
  )
  let clsReported: number | undefined

  // INP: the longest interaction (by interactionId); with many interactions, one in fifty
  // is ignored as an outlier (the 98th percentile).
  const interactions = new Map<number, number>()
  const recordInteraction = (entries: any[]) => {
    for (const entry of entries) {
      if (!entry.interactionId) continue
      interactions.set(
        entry.interactionId,
        Math.max(interactions.get(entry.interactionId) ?? 0, entry.duration),
      )
    }
  }
  observe('event', recordInteraction, options, { durationThreshold: 40 })
  // The first input can be faster than the threshold; count it too.
  observe('first-input', recordInteraction, options)
  let inpReported: number | undefined
  const inp = () => {
    if (!interactions.size) return undefined
    const longest = [...interactions.values()].sort((a, b) => b - a)
    return longest[Math.min(longest.length - 1, Math.floor(interactions.size / 50))]
  }

  onHidden(() => {
    if (lcp !== undefined && !lcpReported) {
      lcpReported = true
      reportNow('LCP', round(lcp))
    }
    const clsValue = Math.round(cls * 1000) / 1000
    if (clsValue > 0 && clsValue !== clsReported) {
      clsReported = clsValue
      reportNow('CLS', clsValue)
    }
    const inpValue = inp()
    if (inpValue !== undefined && round(inpValue) !== inpReported) {
      inpReported = round(inpValue)
      reportNow('INP', inpReported)
    }
  })
}
