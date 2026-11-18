// Runs scripted visitor journeys (scenarios.js) in the playground's browser frame, against
// the real collector, and checks what happened at each layer:
//   browser    what the site shows and keeps (banner, address bar, storage, consent state)
//   network    what left the browser (the site's wiretap)
//   collector  what the collector stored (/_dev endpoints)
//   google     what the Google tag received (a stub that records calls)
import { collector, siteKey } from './collector.js'
import { sleep } from './ui.js'

export class CheckFailed extends Error {}

/**
 * @param {object} options
 * @param {ReturnType<import('./frame.js').createBrowserFrame>} options.frame
 * @param {() => 'normal' | 'fast'} options.speed
 */
export function createRunner({ frame, speed = () => 'normal', onDirect = () => {} }) {
  // What the site reported, across page loads (a reload starts the site's own lists over).
  const sent = []
  const gtag = []
  let consentState = null

  const onSiteMessage = message => {
    if (message.type === 'request') sent.push(message.request)
    if (message.type === 'request-update') {
      const index = sent.findIndex(
        request => request.id === message.request.id && request.at === message.request.at,
      )
      if (index >= 0) sent[index] = message.request
    }
    if (message.type === 'gtag') gtag.push(message.call.args)
    if (message.type === 'consent' || message.type === 'ready') consentState = message.state
  }

  // Watchable runs slow down enough to follow each step; fast runs only wait for the page.
  const pause = (ms = 900) => sleep(speed() === 'fast' ? Math.min(ms, 60) : ms)

  async function run(scenario, { onStep = () => {}, onCheck = () => {} } = {}) {
    sent.length = 0
    gtag.length = 0
    consentState = null
    const steps = []
    const checks = []
    const started = performance.now()
    let current = -1

    const endStep = state => {
      if (current >= 0 && steps[current].state === 'running') {
        steps[current].state = state
        onStep(steps[current])
      }
    }
    const record = (label, pass, layer, detail) => {
      const check = { label, layer, state: pass ? 'passed' : 'failed', detail: detail ?? '' }
      checks.push(check)
      onCheck(check)
      return pass
    }

    const doc = () => {
      const document = frame.document
      if (!document || !frame.href.includes('/site'))
        throw new Error('The demo website is not open')
      return document
    }
    const find = selector => {
      const element = doc().querySelector(selector)
      if (!element) throw new Error(`Not on the page: ${selector}`)
      return element
    }
    const bannerButton = label => {
      const banner = doc().querySelector('#ci-consent-banner')
      if (!banner) throw new Error('The consent banner is not shown')
      const button = [...banner.querySelectorAll('button')].find(
        element => element.textContent.trim() === label,
      )
      if (!button) throw new Error(`The banner has no "${label}" button`)
      return button
    }
    const requestsTo = path => sent.filter(request => request.path?.startsWith(`/v1/${path}`))
    const sentEventNames = () =>
      requestsTo('events').flatMap(request => (request.body?.events ?? []).map(event => event.name))

    const t = {
      scenario,
      siteKey,
      /** Start a new step (ends the previous one). */
      async step(title, detail) {
        endStep('done')
        steps.push({ index: steps.length + 1, title, detail, state: 'running' })
        current = steps.length - 1
        onStep(steps[current])
        await pause(700)
      },
      pause,
      // --- set up -------------------------------------------------------------------------
      async region(country, continent) {
        await collector.setRegion(country, continent)
      },
      policy: changes => collector.setPolicy(changes),
      flag: (name, on) => frame.setFlag(name, on),
      // --- the visitor ----------------------------------------------------------------------
      async visit(path) {
        const message = await frame.load(path)
        consentState = message.state
        await pause()
      },
      async reload() {
        const message = await frame.reload()
        consentState = message.state
        await pause()
      },
      async click(selector) {
        find(selector).click()
        await pause(600)
      },
      /** Click a link of the site's navigation (a single-page navigation). */
      async navigate(path) {
        find(`a[data-nav][href="${path}"]`).click()
        await pause(700)
      },
      async clickBanner(label) {
        bannerButton(label).click()
        await pause(700)
      },
      /** Tick a category checkbox in the banner's Customize view. */
      async tick(category) {
        const box = doc().querySelector(`#ci-consent-category-${category.toLowerCase()}`)
        if (!box) throw new Error(`No "${category}" choice in the banner`)
        if (!box.checked) box.click()
        await pause(200)
      },
      flush() {
        frame.analytics?.flush()
      },
      async leave() {
        await frame.leave()
        await pause()
      },
      // --- what we can observe ----------------------------------------------------------------
      banner: () => doc().querySelector('#ci-consent-banner'),
      bannerVisible() {
        const banner = doc().querySelector('#ci-consent-banner')
        return !!banner && banner.getClientRects().length > 0
      },
      url: () => frame.href,
      local: key => localStorage.getItem(key),
      consent: () => frame.analytics?.consent.get() ?? consentState,
      sent,
      requestsTo,
      sentEventNames,
      gtag,
      gtagEvents: () => gtag.filter(call => call[0] === 'event'),
      events: () => collector.events(),
      consents: () => collector.consents(),
      /** Direct requests to the collector from this page (the playground's origin). */
      async fetch(path, init = {}) {
        const url = new URL(path, window.PLAYGROUND.apiBaseUrl)
        const body = typeof init.body === 'string' && init.body.length < 10_000 ? init.body : null
        let parsed = body
        try {
          parsed = body && JSON.parse(body)
        } catch {}
        const entry = {
          id: `direct-${Date.now()}-${Math.random()}`,
          at: Date.now(),
          transport: 'fetch',
          method: init.method ?? 'GET',
          url: url.href,
          path: `${url.pathname}${url.search}`,
          body: parsed,
          status: 'pending',
          direct: true,
        }
        onDirect({ type: 'request', request: { ...entry } })
        const response = await fetch(url, init)
        entry.status = response.status
        try {
          entry.response = await response.clone().json()
        } catch {}
        onDirect({ type: 'request-update', request: { ...entry } })
        return response
      },
      // --- checks ------------------------------------------------------------------------------
      /** A check that holds now. `value` may be a boolean or { pass, detail }. */
      check(label, value, { layer = 'browser', detail } = {}) {
        const result = typeof value === 'object' && value !== null ? value : { pass: !!value }
        return record(label, result.pass, layer, result.detail ?? detail)
      },
      /** A check that must come true within `timeout` (the collector stores asynchronously). */
      async eventually(label, probe, { layer = 'collector', timeout = 6000, detail } = {}) {
        const deadline = Date.now() + timeout
        let last = { pass: false }
        for (;;) {
          try {
            const value = await probe()
            last =
              typeof value === 'object' && value !== null && 'pass' in value
                ? value
                : { pass: !!value }
          } catch (error) {
            last = { pass: false, detail: String(error?.message ?? error) }
          }
          if (last.pass || Date.now() > deadline) break
          await sleep(150)
        }
        return record(label, last.pass, layer, last.detail ?? detail)
      },
      /** A check that must stay true for `wait` (something was not sent or stored). */
      async stays(label, probe, { layer = 'collector', wait = 900, detail } = {}) {
        await sleep(wait)
        let result
        try {
          const value = await probe()
          result =
            typeof value === 'object' && value !== null && 'pass' in value
              ? value
              : { pass: !!value }
        } catch (error) {
          result = { pass: false, detail: String(error?.message ?? error) }
        }
        return record(label, result.pass, layer, result.detail ?? detail)
      },
    }

    let error
    try {
      // Every scenario starts from nothing: no stored data, no region, a new visitor.
      await frame.leave()
      await sleep(250) // beacons sent on leaving land before the reset
      await collector.reset()
      frame.clearVisitor()
      sent.length = 0
      gtag.length = 0
      await scenario.run(t)
      endStep('done')
    } catch (caught) {
      error = caught
      endStep('failed')
      record(`Scenario stopped: ${caught?.message ?? caught}`, false, 'browser')
    }
    return {
      id: scenario.id,
      passed: !error && checks.every(check => check.state === 'passed'),
      steps,
      checks,
      error: error ? String(error.message ?? error) : undefined,
      durationMs: Math.round(performance.now() - started),
    }
  }

  return { run, onSiteMessage, sent, gtag }
}
