// The demo website: a small single-page site running the real library (built to /lib)
// against the sample collector. The playground pages show it in a frame and drive it; it
// also works on its own at /site/.
import { initAnalytics } from '/lib/index.mjs'

const { apiBaseUrl, siteKey } = window.PLAYGROUND
const wire = window.playgroundWire
const $ = selector => document.querySelector(selector)

// --- Visitor settings the playground controls (read once, at page load) ---------------
// A simulated Global Privacy Control signal, as privacy-focused browsers send it.
if (localStorage.getItem('playground_gpc') === '1') {
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true })
}

// --- Google tag stub: records what Google would receive -------------------------------
const gtagCalls = []
window.dataLayer = window.dataLayer || []
window.gtag = function gtag(...args) {
  window.dataLayer.push(args)
  const call = { at: Date.now(), args: JSON.parse(JSON.stringify(args)) }
  gtagCalls.push(call)
  wire.post({ type: 'gtag', call })
}
window.gtag('consent', 'default', {
  analytics_storage: 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
})

// --- Pages -----------------------------------------------------------------------------
const h = (tag, text, attributes = {}) => {
  const element = document.createElement(tag)
  if (text) element.textContent = text
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
  return element
}
const paragraphs = (...texts) => texts.map(text => h('p', text))

const DOC_SECTIONS = [
  [
    'What this page measures',
    'Scroll down: the library records how far you read (scroll_depth at 25, 50, 75 and 100 percent), and when you leave, a page_exit with the time you spent here.',
  ],
  [
    'Page views',
    'Every route change in a single-page app is a page_view. The URL is recorded without its query string or fragment unless the visitor allowed statistics, and never with secrets such as reset tokens.',
  ],
  [
    'Consent first',
    'Where the collector says consent is required, events are limited until the visitor decides: anonymous, essential events only, with no attribution and no identifiers.',
  ],
  [
    'Attribution',
    'Campaign parameters (utm_*) and ad click IDs (gclid, msclkid, fbclid) are kept as first-touch attribution only after consent, and removed from the address bar.',
  ],
  [
    'Web vitals',
    "LCP, FCP, CLS, INP and TTFB are measured with the browser's Performance APIs and sent with the page context.",
  ],
  [
    'Third parties',
    'Integrations such as Google Analytics run as plugins under the same rules: nothing is loaded or sent to a vendor before the visitor allows its category.',
  ],
  [
    'Delivery',
    'Events are batched and sent with sendBeacon when the page is hidden, so they survive navigation. Failed requests are retried with backoff.',
  ],
  [
    'Records',
    'Each decision is sent as an append-only consent record with the policy version, so the site can show what a visitor agreed to, and when.',
  ],
]

const PAGES = {
  '/site/': {
    title: 'Home',
    render: () => [
      h('p', 'Demo website', { class: 'eyebrow' }),
      h('h1', 'Measure your site without guessing about consent'),
      ...paragraphs(
        "This website stands in for yours. It runs @clearideas/consent-analytics the way a real site would: page views, clicks, errors and consent decisions go to the sample collector, under the consent policy the collector sets for the visitor's region.",
        'Use the navigation to move between pages without reloading, and the buttons below to act like a visitor.',
      ),
      h('a', 'Read how measurement works →', {
        href: '/site/docs',
        'data-nav': '',
        class: 'text-link',
      }),
    ],
  },
  '/site/pricing': {
    title: 'Pricing',
    render: () => {
      const plans = h('div', '', { class: 'plans' })
      for (const [name, price, features] of [
        ['Free', '$0', ['1 site', 'Consent banner', 'Limited events']],
        ['Pro', '$99/mo', ['Unlimited sites', 'Consent records', 'Integrations']],
      ]) {
        const plan = h('div', '', { class: 'plan' })
        plan.append(h('h2', name), h('p', price, { class: 'price' }))
        const list = h('ul')
        for (const feature of features) list.append(h('li', feature))
        plan.append(list)
        plans.append(plan)
      }
      return [
        h('h1', 'Pricing'),
        h(
          'p',
          'Arriving here recorded a page_exit for the page you left and a page_view for this one.',
        ),
        plans,
      ]
    },
  },
  '/site/docs': {
    title: 'Docs',
    render: () => [
      h('h1', 'How measurement works on this site'),
      ...DOC_SECTIONS.flatMap(([title, text]) => [h('h2', title), h('p', text), h('p', text)]),
    ],
  },
  '/site/reset-password': {
    title: 'Reset password',
    render: () => [
      h('h1', 'Reset your password'),
      h(
        'p',
        'The link that brought you here contained a reset token and an email address. Check what the collector stored: neither left the browser.',
      ),
    ],
  },
  '/site/privacy': {
    title: 'Privacy',
    render: () => [
      h('h1', 'Privacy policy'),
      ...paragraphs(
        'Necessary storage keeps the site working and remembers your consent decision. It is always on.',
        'Preferences remember your settings. Statistics measure how the site is used. Marketing lets advertising partners measure campaigns.',
        'Change your choices at any time with "Cookie settings" at the bottom of every page.',
      ),
    ],
  },
}

// The library removes campaign parameters from the address bar (history.replaceState):
// tell the playground, so its address bar shows what the visitor sees.
const nativeReplaceState = history.replaceState.bind(history)
history.replaceState = (...args) => {
  nativeReplaceState(...args)
  wire.post({ type: 'route', href: location.href })
}

const routeListeners = new Set()
const currentPath = () => (location.pathname === '/site' ? '/site/' : location.pathname)

function renderPage() {
  const page = PAGES[currentPath()] ?? { title: 'Not found', render: () => [h('h1', 'Not found')] }
  document.title = `${page.title} · Example`
  $('#page').replaceChildren(...page.render())
  for (const link of document.querySelectorAll('nav [data-nav]')) {
    link.toggleAttribute('aria-current', link.getAttribute('href') === currentPath())
  }
}

function navigate(path) {
  history.pushState(history.state, '', path)
  renderPage()
  window.scrollTo(0, 0)
  for (const listener of routeListeners) listener(location.pathname)
  wire.post({ type: 'route', href: location.href })
}

document.addEventListener('click', event => {
  const link = event.target.closest?.('a')
  if (!link) return
  if (link.hasAttribute('data-nav')) {
    event.preventDefault()
    navigate(link.getAttribute('href'))
  } else if (link.dataset.outbound !== undefined) {
    // The library records the outbound click; the demo stays on this page.
    event.preventDefault()
    toast(`Outbound link to ${link.hostname} recorded (not opened in the demo).`)
  }
})
window.addEventListener('popstate', () => {
  renderPage()
  for (const listener of routeListeners) listener(location.pathname)
  wire.post({ type: 'route', href: location.href })
})

let toastTimer
function toast(text) {
  const element = $('#toast')
  element.textContent = text
  element.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (element.hidden = true), 2600)
}

// --- The library -------------------------------------------------------------------------
const config = {
  apiBaseUrl,
  siteKey,
  // Integrations are plugins, enabled by configuration and run under the consent rules.
  // loadScript: false uses the stub above instead of downloading gtag.js.
  integrations: {
    googleAnalytics: {
      measurementId: 'G-PLAYGROUND',
      adsConversions: { sign_up: 'AW-PLAYGROUND/signup' },
      loadScript: false,
    },
  },
  // Production-like batching: essential events (page_view, error) are sent at once,
  // others every 3 s, when 10 are queued, or when the page is hidden.
  flushInterval: 3000,
  batchSize: 10,
  maxRetries: 2,
  autoTrackScrollDepth: true,
  autoTrackTimeSpent: true,
  autoTrackOutboundLinks: true,
  exposeGlobals: true,
  websiteBaseUrl: `${location.origin}/site/`,
  consent: {
    choices: localStorage.getItem('playground_categories') === '1' ? 'categories' : 'simple',
  },
}

const adapter = {
  getConfig: () => config,
  getCurrentPath: () => location.pathname,
  getCurrentUrl: () => location.href,
  getReferrer: () => document.referrer,
  onRouteChange: callback => {
    routeListeners.add(callback)
    return () => routeListeners.delete(callback)
  },
  onAppReady: callback => callback(),
  onAppDestroy: () => {},
  getRouter: () => null,
}

renderPage()
const analytics = initAnalytics(config, adapter)
window.playgroundAnalytics = analytics
window.playgroundGtag = gtagCalls

// --- Visitor actions ---------------------------------------------------------------------
$('#ev-signup').addEventListener('click', () => {
  analytics.trackEvent('sign_up', { plan: 'pro', method: 'email' })
  toast('Thanks for signing up! (sign_up)')
})
$('#ev-purchase').addEventListener('click', () => {
  analytics.trackEvent('purchase', { value: 99, currency: 'USD', plan: 'pro' })
  toast('Order placed. (purchase)')
})
$('#ev-custom').addEventListener('click', () => {
  analytics.trackEvent('Newsletter Signup', { list: 'weekly' })
  toast('Subscribed. (Newsletter Signup)')
})
$('#ev-error').addEventListener('click', () => {
  analytics.trackError('Demo error: the checkout service did not answer', { code: 'E_DEMO' })
  toast('Problem reported. (error)')
})
$('#manage-cookies').addEventListener('click', () => analytics.consent.showBanner())

const stateOf = () => ({ ...analytics.consent.get(), config: { choices: config.consent.choices } })
analytics.consent.onChange(() => wire.post({ type: 'consent', state: stateOf() }))
analytics.ready().then(() => wire.post({ type: 'ready', href: location.href, state: stateOf() }))
window.addEventListener('pagehide', () => wire.post({ type: 'unload', href: location.href }))
