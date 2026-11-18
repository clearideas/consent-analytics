// Live playground: the demo website in a frame, driven from the controls, with everything
// that leaves the browser and everything the collector stores.
import { collector, merge, NOISE, siteKey, subscribe } from './lib/collector.js'
import { createFlow, requestLabel } from './lib/flow.js'
import { createBrowserFrame } from './lib/frame.js'
import { morphChildren } from './lib/morph.js'
import { setupShell } from './lib/shell.js'
import { $, $$, formatTime, h, jsonView, setupTabs } from './lib/ui.js'

setupShell()

const state = {
  requests: [],
  events: [],
  consents: [],
  gtag: [],
  site: null, // consent state reported by the site
  region: null,
  live: false, // history loaded: new items animate
}

// --- The visitor's browser ---------------------------------------------------------------
const flow = createFlow($('#flow'))
const frame = createBrowserFrame($('#browser'), {
  onMessage(message) {
    if (message.type === 'request') {
      state.requests.push(message.request)
      flow.sent(message.request)
      renderNetwork()
    }
    if (message.type === 'request-update') {
      const index = state.requests.findIndex(
        r => r.id === message.request.id && r.at === message.request.at,
      )
      if (index >= 0) state.requests[index] = message.request
      flow.answered(message.request)
      renderNetwork()
    }
    if (message.type === 'gtag') {
      state.gtag.push(message.call)
      renderGtag()
    }
    if (message.type === 'consent' || message.type === 'ready') {
      state.site = message.state
      renderStatus()
    }
  },
})

const forgetContext = () => sessionStorage.removeItem('ci_geo_context')
const note = text => {
  const element = $('#reset-note')
  element.textContent = text
  element.hidden = !text
}
const visit = async path => {
  try {
    await frame.load(path)
  } catch (error) {
    note(String(error.message ?? error))
  }
  renderStorage()
}
const reloadSite = () =>
  visit(frame.href.includes('/site') ? new URL(frame.href).pathname : '/site/')

// --- Controls ----------------------------------------------------------------------------
for (const button of $$('[data-region]')) {
  button.addEventListener('click', async () => {
    await collector.setRegion(button.dataset.region || null, button.dataset.continent)
    await refreshRegion()
    forgetContext()
    await reloadSite()
  })
}
const toggles = {
  gpc: $('#gpc'),
  categories: $('#categories-mode'),
}
for (const [flag, input] of Object.entries(toggles)) {
  input.checked = frame.flag(flag)
  input.addEventListener('change', async () => {
    frame.setFlag(flag, input.checked)
    await reloadSite()
  })
}
$('#no-tracking-without-consent').addEventListener('change', async event => {
  await collector.setPolicy({ trackingWithoutConsent: event.target.checked ? 'none' : 'limited' })
  forgetContext()
  await reloadSite()
})
$('#from-direct').addEventListener('click', () => visit('/site/'))
$('#from-ads').addEventListener('click', () => {
  frame.clearVisitor({ keepFlags: true })
  void visit(
    '/site/pricing?gclid=PLAYGROUND-GCLID-123&utm_source=google&utm_medium=cpc&utm_campaign=playground',
  )
})
$('#from-reset-link').addEventListener('click', () =>
  visit(
    '/site/reset-password?token=SECRET-RESET-TOKEN&email=jane%40example.com#access_token=SECRET-FRAGMENT',
  ),
)
$('#flush').addEventListener('click', () => frame.analytics?.flush())
$('#hide-page').addEventListener('click', () => {
  // What the browser tells a page when the visitor switches to another tab.
  const page = frame.document
  if (!page) return
  Object.defineProperty(page, 'visibilityState', { value: 'hidden', configurable: true })
  page.dispatchEvent(new Event('visibilitychange'))
  delete page.visibilityState
})
$('#leave-page').addEventListener('click', async () => {
  await frame.leave()
  note(
    'The visitor left the site: its last events went out with sendBeacon. Use "Arrive" to come back.',
  )
})
$('#new-policy').addEventListener('click', async () => {
  await collector.setPolicy({ policyVersion: new Date().toISOString().slice(0, 19) })
  forgetContext()
  await reloadSite()
  note('A new policy version is published: visitors who decided before are asked again.')
})
$('#reset-consent').addEventListener('click', async () => {
  for (const key of ['ci_consent_status', 'ci_consent_pending']) localStorage.removeItem(key)
  await reloadSite()
  note('Consent reset: the visitor has not decided yet.')
})
$('#reset-visitor').addEventListener('click', async () => {
  frame.clearVisitor()
  for (const input of Object.values(toggles)) input.checked = false
  await visit('/site/')
  note('Visitor reset: all ci_* storage and cookies cleared, a brand-new visitor.')
})
$('#reset-all').addEventListener('click', async () => {
  await frame.leave()
  await collector.reset()
  frame.clearVisitor()
  for (const input of Object.values(toggles)) input.checked = false
  $('#no-tracking-without-consent').checked = false
  state.requests.length = 0
  state.gtag.length = 0
  flow.reset()
  renderNetwork()
  renderGtag()
  await refreshRegion()
  await visit('/site/')
  note("Everything reset: the collector's data, the region and the visitor.")
})

async function refreshRegion() {
  const current = await collector.state()
  state.region = current.geoOverride
  const site = current.sites.find(entry => entry.siteKey === siteKey)
  $('#no-tracking-without-consent').checked = site?.trackingWithoutConsent === 'none'
  for (const button of $$('[data-region]')) {
    button.setAttribute(
      'aria-pressed',
      String((button.dataset.region || null) === (state.region?.country ?? null)),
    )
  }
  renderStatus()
}

// --- Status ------------------------------------------------------------------------------
function renderStatus() {
  const chip = (text, tone = '') => h(`span.chip${tone ? `.${tone}` : ''}`, {}, h('i'), text)
  const site = state.site
  const context = JSON.parse(sessionStorage.getItem('ci_geo_context') || 'null')
  const required = site?.required ?? true
  const decision =
    site?.granted === true
      ? 'accepted'
      : site?.granted === false
        ? 'decided (not all)'
        : 'undecided'
  const full = !required || site?.categories?.statistics === true
  const marketing = site?.categories?.marketing ?? (!required && !site?.gpc)
  morphChildren($('#status'), [
    chip(`Region: ${state.region?.country ?? 'unknown'}`, state.region ? 'info' : 'warn'),
    chip(`Consent required: ${required ? 'yes' : 'no'}`, required ? 'warn' : 'ok'),
    chip(
      `Decision: ${decision}`,
      site?.granted === true ? 'ok' : site?.granted === false ? 'danger' : '',
    ),
    chip(`Policy: ${site?.policyVersion ?? context?.policyVersion ?? '?'}`),
    chip(`GPC: ${site?.gpc ? 'on' : 'off'}`, site?.gpc ? 'info' : ''),
    ...(site?.config?.choices === 'categories'
      ? ['preferences', 'statistics', 'marketing'].map(category =>
          chip(`${category}: ${site.categories?.[category] ?? '?'}`),
        )
      : []),
    chip(`Tracking: ${full ? 'full' : 'limited'}`, full ? 'full' : 'limited'),
    chip(`Marketing tags: ${marketing ? 'on' : 'off'}`, marketing ? 'ok' : ''),
  ])
}

// --- Feeds -------------------------------------------------------------------------------
// Feed items are keyed: lists are updated in place (morph), so an opened item stays open
// while new ones arrive at the top.
const entry = (key, summaryParts, body, testid) =>
  h(
    'li',
    { dataset: { key, ...(testid ? { testid } : {}) } },
    h('details', {}, h('summary', {}, ...summaryParts), ...(Array.isArray(body) ? body : [body])),
  )
const categoryChip = category =>
  h(`span.chip.${category === 'full' ? 'full' : 'limited'}`, { text: category })

function renderNetwork() {
  morphChildren(
    $('#feed-network'),
    state.requests
      .slice()
      .reverse()
      .map(request => {
        const status =
          typeof request.status === 'number'
            ? h(`span.status.${request.status < 400 ? 'ok' : 'bad'}`, { text: request.status })
            : h(
                `span.status.${request.status === 'refused' || request.status === 'failed' ? 'bad' : 'pending'}`,
                {
                  text: request.status,
                },
              )
        return entry(
          `${request.at}-${request.id}`,
          [
            h('span.method', { text: request.transport === 'beacon' ? 'BEACON' : request.method }),
            h('span.name', { text: request.path.split('?')[0] }),
            h('span.path', { text: requestLabel(request) }),
            status,
            h('time', { text: formatTime(request.at) }),
          ],
          h(
            'div.split',
            {},
            h('div', {}, h('h4', { text: 'Request body' }), jsonView(request.body)),
            h(
              'div',
              {},
              h('h4', {
                text:
                  request.transport === 'beacon' ? 'Answer (not readable for beacons)' : 'Answer',
              }),
              jsonView(request.response ?? null),
            ),
          ),
          'request',
        )
      }),
  )
  $('#count-network').textContent = String(state.requests.length)
}

const BROWSER_FIELDS = [
  'eventId',
  'name',
  'occurredAt',
  'sessionId',
  'pageViewId',
  'trackingCategory',
  'consent',
  'props',
]
const SERVER_FIELDS = [
  'receivedAt',
  'sentAt',
  'occurredAtCorrected',
  'origin',
  'profile',
  'server',
  'identity',
  'sanitized',
  'retainUntil',
  'ipRetainUntil',
  'page',
  'attribution',
  'client',
  'engagement',
  'vital',
  'load',
  'outbound',
  'error',
]
const pick = (object, keys) =>
  Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]))

function renderEvents() {
  const hideNoise = $('#hide-noise').checked
  const shown = state.events.filter(event => !hideNoise || !NOISE.has(event.name))
  morphChildren(
    $('#feed-events'),
    shown
      .slice()
      .reverse()
      .map(event =>
        entry(
          event.eventId,
          [
            h('span.name', { text: event.name }),
            categoryChip(event.trackingCategory),
            h('span.chip', {
              text: event.consentRequired
                ? event.consentGranted
                  ? 'consented'
                  : 'no consent'
                : 'consent not required',
            }),
            h('span.path', { text: event.props?.path ?? '' }),
            h('time', { text: formatTime(event.receivedAt) }),
          ],
          h(
            'div.split',
            {},
            h(
              'div',
              {},
              h('h4', { text: 'Sent by the browser' }),
              jsonView(pick(event, BROWSER_FIELDS)),
            ),
            h(
              'div',
              {},
              h('h4', { text: 'Added by the collector' }),
              jsonView(pick(event, SERVER_FIELDS)),
            ),
          ),
          'event',
        ),
      ),
  )
  $('#count-events').textContent = String(state.events.length)
}

function renderConsents() {
  morphChildren(
    $('#feed-consents'),
    state.consents
      .slice()
      .reverse()
      .map(record =>
        entry(
          record.recordId,
          [
            h(`span.chip.${record.decision}`, { text: record.decision }),
            h('span.path', { text: `policy ${record.policyVersion} · ${record.source}` }),
            record.categories
              ? h('span.path', {
                  text: Object.entries(record.categories)
                    .map(([category, allowed]) => `${category} ${allowed ? '✓' : '✗'}`)
                    .join(' '),
                })
              : null,
            h('time', { text: formatTime(record.recordedAt) }),
          ],
          jsonView(record),
          'consent',
        ),
      ),
  )
  $('#count-consents').textContent = String(state.consents.length)
}

function renderGtag() {
  morphChildren(
    $('#feed-gtag'),
    state.gtag
      .map((call, index) => ({ call, key: `${call.at}-${index}` }))
      .reverse()
      .map(({ call, key }) =>
        entry(
          key,
          [
            h('span.name', { text: call.args.slice(0, 2).join(' · ') }),
            h('time', { text: formatTime(call.at) }),
          ],
          jsonView(call.args[2] ?? null),
        ),
      ),
  )
  $('#count-gtag').textContent = String(state.gtag.length)
}

function renderStorage() {
  const rows = [['address bar', frame.href]]
  for (const [where, storage] of [
    ['localStorage', localStorage],
    ['sessionStorage', sessionStorage],
  ]) {
    for (const key of Object.keys(storage).sort()) {
      if (!key.startsWith('ci_') && !key.startsWith('playground_')) continue
      let value = storage.getItem(key)
      try {
        value = JSON.stringify(JSON.parse(value), null, 2)
      } catch {}
      rows.push([`${where} · ${key}`, value])
    }
  }
  rows.push(['document.cookie', document.cookie || '(none)'])
  morphChildren($('#feed-storage'), [
    h(
      'dl.kv',
      {},
      ...rows.flatMap(([key, value]) => [h('dt', { text: key }), h('dd', { text: value })]),
    ),
  ])
}

$('#hide-noise').addEventListener('change', renderEvents)
setupTabs($('.inspector'), name => {
  $('.inspector .filter-row').hidden = name !== 'events'
  if (name === 'storage') renderStorage()
})
setInterval(() => {
  if (!$('#feed-storage').hidden) renderStorage()
  renderStatus()
}, 1000)

// --- The collector -----------------------------------------------------------------------
async function loadHistory() {
  const [events, consents] = await Promise.all([collector.events(), collector.consents()])
  merge(state.events, events, 'eventId', 'receivedAt')
  merge(state.consents, consents, 'recordId', 'recordedAt')
  renderEvents()
  renderConsents()
  state.live = true
}
subscribe(({ type, data }) => {
  if (type === 'ready') void loadHistory()
  if (type === 'event') {
    const known = state.events.some(event => event.eventId === data.eventId)
    merge(state.events, [data], 'eventId', 'receivedAt')
    if (!known && state.live) flow.stored('event', data)
    renderEvents()
  }
  if (type === 'consent') {
    const known = state.consents.some(record => record.recordId === data.recordId)
    merge(state.consents, [data], 'recordId', 'recordedAt')
    if (!known && state.live) flow.stored('consent', data)
    renderConsents()
  }
  if (type === 'reset') {
    state.events.length = 0
    state.consents.length = 0
    renderEvents()
    renderConsents()
  }
})

await refreshRegion()
renderNetwork()
renderGtag()
await visit('/site/')
