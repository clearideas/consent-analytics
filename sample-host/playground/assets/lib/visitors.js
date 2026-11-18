// Simulated visitors: scripted browsers on the demo website. Each one is a new visitor from
// a region, arriving from a source, who decides about consent (or doesn't), browses a few
// pages, acts, and leaves. Everything they send goes through the real library and the real
// collector, so the analytics show what a real site would collect.
import { collector } from './collector.js'
import { sleep } from './ui.js'

const pickWeighted = (options, random) => {
  const total = options.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = random() * total
  for (const [value, weight] of options) {
    roll -= weight
    if (roll <= 0) return value
  }
  return options[options.length - 1][0]
}

export const REGIONS = [
  [{ country: 'DE', continent: 'EU' }, 3],
  [{ country: 'FR', continent: 'EU' }, 2],
  [{ country: 'GB', continent: 'EU' }, 2],
  [{ country: 'NL', continent: 'EU' }, 1],
  [{ country: 'US', continent: 'NA' }, 4],
  [{ country: 'CA', continent: 'NA' }, 1],
  [{ country: 'JP', continent: 'AS' }, 1],
  [{ country: 'BR', continent: 'SA' }, 1],
  [null, 1], // the collector can't tell
]

export const SOURCES = [
  ['', 3], // direct
  ['?gclid=SIM-GCLID&utm_source=google&utm_medium=cpc&utm_campaign=spring-sale', 2],
  ['?utm_source=newsletter&utm_medium=email&utm_campaign=weekly', 2],
  ['?utm_source=linkedin&utm_medium=social&utm_campaign=launch', 1],
  ['?utm_source=partner-blog&utm_medium=referral', 1],
]

const LANDINGS = [
  ['/site/', 4],
  ['/site/pricing', 3],
  ['/site/docs', 2],
]

const CHOICES = [
  ['accept', 50],
  ['reject', 25],
  ['customize', 15],
  ['ignore', 10],
]

/** One visitor's plan, decided up front. */
export function planVisitor(random = Math.random) {
  const region = pickWeighted(REGIONS, random)
  return {
    region,
    source: pickWeighted(SOURCES, random),
    landing: pickWeighted(LANDINGS, random),
    choice: pickWeighted(CHOICES, random),
    gpc: region?.country === 'US' && random() < 0.2,
    pages: Math.floor(random() * 3),
    signUp: random() < 0.3,
    purchase: random() < 0.12,
    newsletter: random() < 0.18,
    error: random() < 0.06,
    outbound: random() < 0.1,
    readsDocs: random() < 0.6,
    readShare: [0.3, 0.6, 1][Math.floor(random() * 3)],
  }
}

const clickBanner = (document, labels) => {
  const banner = document.querySelector('#ci-consent-banner')
  if (!banner) return false
  const button = [...banner.querySelectorAll('button')].find(element =>
    labels.includes(element.textContent.trim()),
  )
  button?.click()
  return !!button
}

/**
 * Scroll down in steps with pauses, as a reader would: the library measures scroll depth a
 * moment after scrolling stops.
 */
async function read(frame, share = 1) {
  const page = frame.window
  if (!page) return
  const height = page.document.documentElement.scrollHeight - page.innerHeight
  for (const step of [0.3, 0.6, 1].filter(step => step <= share)) {
    page.scrollTo(0, height * step)
    await sleep(330)
  }
}

/** A repeatable random sequence (mulberry32), for simulations that can be replayed. */
export function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Run `count` visitors in `frame`. Calls onProgress({ index, count, plan }) before each.
 * Stops early when `signal` aborts.
 */
export async function simulateVisitors(
  frame,
  count,
  { onProgress = () => {}, signal, random = Math.random } = {},
) {
  const previous = (await collector.state()).geoOverride
  try {
    for (let index = 0; index < count; index++) {
      if (signal?.aborted) break
      const plan = planVisitor(random)
      onProgress({ index, count, plan })
      await frame.leave()
      frame.clearVisitor()
      frame.setFlag('gpc', plan.gpc)
      frame.setFlag('categories', plan.choice === 'customize')
      await collector.setRegion(plan.region?.country ?? null, plan.region?.continent)
      await frame.load(`${plan.landing}${plan.source}`)
      await sleep(250)

      const document = frame.document
      if (plan.choice === 'accept') clickBanner(document, ['Accept all'])
      if (plan.choice === 'reject') clickBanner(document, ['Reject non-essential'])
      if (plan.choice === 'customize' && clickBanner(document, ['Customize'])) {
        await sleep(120)
        const statistics = document.querySelector('#ci-consent-category-statistics')
        if (statistics && !statistics.checked) statistics.click()
        clickBanner(document, ['Save choices'])
      }
      await sleep(200)

      const pages = ['/site/pricing', '/site/docs', '/site/']
        .filter(path => path !== plan.landing)
        .slice(0, plan.pages)
      for (const path of pages) {
        frame.document.querySelector(`a[data-nav][href="${path}"]`)?.click()
        await sleep(250)
        if (path === '/site/docs' && plan.readsDocs) await read(frame, plan.readShare)
      }
      if (plan.landing === '/site/docs' && plan.readsDocs) await read(frame, plan.readShare)

      const act = selector => frame.document.querySelector(selector)?.click()
      if (plan.newsletter) act('#ev-custom')
      if (plan.signUp) act('#ev-signup')
      if (plan.purchase) act('#ev-purchase')
      if (plan.error) act('#ev-error')
      if (plan.outbound) act('[data-testid="outbound"]')
      await sleep(200)
      await frame.leave() // pagehide: the rest goes out with sendBeacon
    }
  } finally {
    frame.setFlag('gpc', false)
    frame.setFlag('categories', false)
    await collector.setRegion(previous?.country ?? null, previous?.continent)
  }
}
