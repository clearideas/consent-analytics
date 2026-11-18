// Analytics: what the collector stored for the demo website, as charts. Everything is
// computed here from the stored events and consent records (/_dev endpoints), and updates
// live while visitors (real, scripted or simulated) use the site.
import { bars, COLORS, columns, donut, empty, paletteColor, panel } from './lib/charts.js'
import { collector, merge, subscribe } from './lib/collector.js'
import { createBrowserFrame } from './lib/frame.js'
import { morphChildren } from './lib/morph.js'
import { setupShell } from './lib/shell.js'
import { $, formatMs, formatNumber, formatPercent, formatTime, h, jsonView } from './lib/ui.js'
import { seededRandom, simulateVisitors } from './lib/visitors.js'

setupShell()

const data = { events: [], consents: [] }
let selectedEventId = null

// --- Aggregation helpers -------------------------------------------------------------------
const countBy = (items, key) => {
  const counts = new Map()
  for (const item of items) {
    const value = key(item)
    if (value === undefined || value === null || value === '') continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}
const percentile = (values, p) => {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const countryOf = event =>
  event.server?.geo?.country ?? event.client?.country ?? event.props?.country ?? 'Unknown'

/** The latest record per consent ID: each visitor's current decision. */
const currentDecisions = consents => {
  const latest = new Map()
  for (const record of consents) latest.set(record.consentId, record)
  return [...latest.values()]
}
const allows = (record, category) =>
  record.categories ? record.categories[category] === true : record.decision === 'granted'

const BUCKETS = [5, 10, 30, 60, 300, 900, 3600, 21_600, 86_400].map(seconds => seconds * 1000)

function timeline(events) {
  if (!events.length) return empty('No events yet.')
  const times = events.map(event => Date.parse(event.receivedAt))
  const start = Math.min(...times)
  const end = Math.max(...times)
  const size = BUCKETS.find(bucket => (end - start) / bucket <= 30) ?? BUCKETS.at(-1)
  const first = Math.floor(start / size) * size
  const count = Math.floor((end - first) / size) + 1
  const buckets = Array.from({ length: count }, (_, index) => ({
    at: first + index * size,
    full: 0,
    limited: 0,
  }))
  for (const event of events) {
    const bucket = buckets[Math.floor((Date.parse(event.receivedAt) - first) / size)]
    bucket[event.trackingCategory === 'full' ? 'full' : 'limited'] += 1
  }
  const label = at =>
    size >= 86_400_000
      ? new Date(at).toLocaleDateString()
      : new Date(at).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          ...(size < 60_000 ? { second: '2-digit' } : {}),
        })
  return columns(
    buckets.map(bucket => ({
      label: label(bucket.at),
      segments: [
        { key: 'full', value: bucket.full, color: COLORS.full },
        { key: 'limited', value: bucket.limited, color: COLORS.limited },
      ],
    })),
    { labelEvery: Math.max(1, Math.ceil(count / 6)), title: 'Events over time' },
  )
}

// Core Web Vitals thresholds (good, poor), as published by web.dev.
const VITALS = [
  { name: 'LCP', title: 'Largest Contentful Paint', good: 2500, poor: 4000, unit: 'ms' },
  { name: 'INP', title: 'Interaction to Next Paint', good: 200, poor: 500, unit: 'ms' },
  { name: 'CLS', title: 'Cumulative Layout Shift', good: 0.1, poor: 0.25, unit: '' },
  { name: 'FCP', title: 'First Contentful Paint', good: 1800, poor: 3000, unit: 'ms' },
  { name: 'TTFB', title: 'Time to First Byte', good: 800, poor: 1800, unit: 'ms' },
  { name: 'FID', title: 'First Input Delay (replaced by INP)', good: 100, poor: 300, unit: 'ms' },
]
const rate = (vital, value) =>
  value === undefined
    ? 'none'
    : value <= vital.good
      ? 'good'
      : value <= vital.poor
        ? 'needs-improvement'
        : 'poor'

function vitalsView(events) {
  const byName = new Map()
  for (const event of events) {
    if (event.name !== 'web_vital') continue
    const name = event.vital?.name ?? event.props?.name
    const value = event.vital?.value ?? event.props?.value
    if (typeof value !== 'number') continue
    byName.set(name, [...(byName.get(name) ?? []), value])
  }
  return h(
    'div.vitals',
    {},
    ...VITALS.map(vital => {
      const values = byName.get(vital.name) ?? []
      const p75 = percentile(values, 75)
      const shares = ['good', 'needs-improvement', 'poor'].map(
        rating => values.filter(value => rate(vital, value) === rating).length,
      )
      return h(
        'article.vital',
        { dataset: { rating: rate(vital, p75), key: vital.name } },
        h('header', {}, h('strong', { text: vital.name }), h('small', { text: vital.title })),
        h('div.reading', {
          text: p75 === undefined ? '–' : vital.unit === 'ms' ? formatMs(p75) : p75.toFixed(3),
        }),
        h(
          'div.rating-bar',
          { title: `good ${shares[0]}, needs improvement ${shares[1]}, poor ${shares[2]}` },
          ...shares.map((share, index) =>
            h('i', {
              style: {
                width: values.length ? `${(share / values.length) * 100}%` : '0',
                background: [COLORS.full, COLORS.limited, COLORS.denied][index],
              },
            }),
          ),
        ),
        h('small', {
          text: values.length
            ? `p75 of ${values.length} · ${formatPercent(shares[0], values.length)} good`
            : 'no samples yet',
        }),
      )
    }),
  )
}

// What the data policy let the collector add, per profile.
const SERVER_FIELDS = [
  ['ip', 'IP address', server => server.ip && `${server.ipForm ?? 'full'}`],
  [
    'geo',
    'Location',
    server => server.geo && (server.geo.city ? 'city' : server.geo.region ? 'region' : 'country'),
  ],
  ['network', 'Network', server => server.network && (server.network.org ? 'org' : 'ASN')],
  [
    'userAgent',
    'User agent',
    server =>
      server.userAgent &&
      (server.userAgent.raw ? 'raw + parsed' : server.userAgent.browser ? 'parsed' : 'device type'),
  ],
  ['language', 'Language', server => server.language && 'yes'],
  ['gpc', 'GPC', server => server.gpc !== undefined && 'yes'],
]

function profileMatrix(events) {
  const profiles = countBy(events, event => event.profile).map(([profile]) => profile)
  if (!profiles.length) return empty('No events yet.')
  const rows = []
  for (const profile of profiles) {
    for (const category of ['full', 'limited']) {
      const subset = events.filter(
        event => event.profile === profile && event.trackingCategory === category,
      )
      if (!subset.length) continue
      rows.push(
        h(
          'tr',
          { dataset: { key: `${profile}-${category}` } },
          h('td', {}, h('strong', { text: profile })),
          h('td', {}, h(`span.chip.${category}`, { text: category })),
          h('td.mono', { text: String(subset.length) }),
          ...SERVER_FIELDS.map(([, , describe]) => {
            const levels = countBy(subset, event =>
              event.server ? describe(event.server) : undefined,
            )
            return h('td.mono', {
              text: levels.length ? levels.map(([level]) => level).join(', ') : '—',
            })
          }),
        ),
      )
    }
  }
  return h(
    'div.table-scroll',
    {},
    h(
      'table.data-table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: 'Profile' }),
          h('th', { text: 'Events' }),
          h('th', { text: 'Count' }),
          ...SERVER_FIELDS.map(([, title]) => h('th', { text: title })),
        ),
      ),
      h('tbody', {}, ...rows),
    ),
  )
}

function explorer(events) {
  if (!events.length) return empty('No events yet.')
  const rows = events
    .slice()
    .reverse()
    .slice(0, 250)
    .map(event =>
      h(
        'tr',
        {
          'aria-selected': String(event.eventId === selectedEventId),
          dataset: { testid: 'explorer-row', key: event.eventId, eventId: event.eventId },
        },
        h('td.mono', { text: formatTime(event.receivedAt) }),
        h('td.mono', { text: event.name }),
        h('td', {}, h(`span.chip.${event.trackingCategory}`, { text: event.trackingCategory })),
        h('td', {
          text: event.consentRequired
            ? event.consentGranted
              ? 'consented'
              : 'no consent'
            : 'not required',
        }),
        h('td.mono', { text: event.props?.path ?? '' }),
        h('td.mono', { text: countryOf(event) }),
        h('td.mono', { text: event.profile ?? '' }),
        h('td.mono', { text: event.sessionId.slice(-6) }),
      ),
    )
  const selected = events.find(event => event.eventId === selectedEventId)
  const browserFields = [
    'eventId',
    'name',
    'occurredAt',
    'sessionId',
    'pageViewId',
    'trackingCategory',
    'consent',
    'props',
  ]
  const pick = (object, keys) =>
    Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]))
  return [
    h(
      'div.table-scroll',
      {},
      h(
        'table.data-table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...[
              'Received',
              'Event',
              'Category',
              'Consent',
              'Path',
              'Country',
              'Profile',
              'Session',
            ].map(text => h('th', { text })),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
    ),
    selected
      ? h(
          'div.split',
          { style: { marginTop: '14px' } },
          h(
            'div',
            {},
            h('h4', { text: 'Sent by the browser' }),
            jsonView(pick(selected, browserFields)),
          ),
          h(
            'div',
            {},
            h('h4', { text: 'Added by the collector' }),
            jsonView(
              Object.fromEntries(
                Object.entries(selected).filter(
                  ([key]) =>
                    !browserFields.includes(key) &&
                    !['consentRequired', 'consentGranted', 'siteKey'].includes(key),
                ),
              ),
            ),
          ),
        )
      : h('p.caption', {
          style: { marginTop: '12px' },
          text: 'Select an event to see what the browser sent and what the collector added.',
        }),
  ]
}

// --- Rendering -------------------------------------------------------------------------------
function render() {
  const category = document.querySelector('input[name="category"]:checked').value
  const events = data.events.filter(
    event => category === 'all' || event.trackingCategory === category,
  )
  const decisions = currentDecisions(data.consents)
  const pageViews = events.filter(event => event.name === 'page_view')
  const sessions = new Set(events.map(event => event.sessionId))
  const full = events.filter(event => event.trackingCategory === 'full').length
  const exits = events.filter(
    event => event.name === 'page_exit' && typeof event.engagement?.timeSpent === 'number',
  )
  const averageTime = exits.length
    ? exits.reduce((sum, event) => sum + event.engagement.timeSpent, 0) / exits.length
    : undefined
  const acceptedAll = decisions.filter(record => record.decision === 'granted').length
  const allowedStatistics = decisions.filter(record => allows(record, 'statistics')).length

  const stat = (label, value, note, tone) =>
    h(
      'div.stat',
      tone ? { dataset: { tone } } : {},
      h('dt', { text: label }),
      h('dd', {}, value, note ? h('small', { text: note }) : null),
    )
  morphChildren($('#kpis'), [
    stat('Sessions', formatNumber(sessions.size)),
    stat('Page views', formatNumber(pageViews.length)),
    stat('Events', formatNumber(events.length)),
    stat(
      'Full events',
      formatPercent(full, events.length),
      `${full} of ${events.length}`,
      full ? 'good' : undefined,
    ),
    stat('Consent decisions', formatNumber(decisions.length), `${data.consents.length} records`),
    stat(
      'Allow statistics',
      formatPercent(allowedStatistics, decisions.length),
      `${acceptedAll} accepted all`,
      decisions.length ? 'good' : undefined,
    ),
    stat('Avg. time on page', averageTime === undefined ? '–' : `${averageTime.toFixed(0)} s`),
    stat(
      'Errors',
      formatNumber(events.filter(event => event.name === 'error').length),
      undefined,
      events.some(event => event.name === 'error') ? 'bad' : undefined,
    ),
  ])

  const noise = new Set(['web_vital', 'auto_metrics'])
  const eventMix = countBy(
    events.filter(event => !noise.has(event.name)),
    event => event.name,
  ).slice(0, 12)
  const countries = countBy(events, countryOf)
  const profiles = countBy(decisions, record => record.profile ?? 'unknown')
  const pages = countBy(pageViews, event => event.props?.path)
  const sources = countBy(
    events.filter(
      event => event.name === 'page_view' && (event.attribution ?? event.props?.attribution),
    ),
    event => {
      const attribution = event.attribution ?? event.props.attribution
      return attribution.utm_source ?? (attribution.gclid ? 'google (click ID)' : 'other')
    },
  )
  const scrolled = [25, 50, 75, 100].map(depth => ({
    label: `${depth}%`,
    value: new Set(
      events
        .filter(
          event =>
            event.name === 'scroll_depth' &&
            (event.engagement?.scrollDepth ?? event.props?.depth) >= depth,
        )
        .map(event => event.pageViewId),
    ).size,
  }))
  const timeBuckets = [
    ['< 5 s', 0, 5],
    ['5–15 s', 5, 15],
    ['15–30 s', 15, 30],
    ['30–60 s', 30, 60],
    ['> 60 s', 60, Infinity],
  ].map(([label, from, to]) => ({
    label,
    value: exits.filter(
      event => event.engagement.timeSpent >= from && event.engagement.timeSpent < to,
    ).length,
  }))
  const devices = countBy(events, event => {
    const agent = event.server?.userAgent
    if (agent?.browser) return `${agent.browser} · ${agent.device ?? 'device?'}`
    if (agent?.device) return agent.device
    return event.props?.deviceBucket
  })
  const outbound = countBy(
    events.filter(event => event.name === 'outbound_link_click'),
    event => event.outbound?.host ?? event.props?.outboundHost ?? event.props?.outboundUrl,
  )
  const errors = countBy(
    events.filter(event => event.name === 'error'),
    event => event.error?.message ?? event.props?.message,
  )

  const segmentsFor = (subset, key) =>
    countBy(subset, key).map(([label, value]) => {
      const group = subset.filter(event => key(event) === label)
      const fullCount = group.filter(event => event.trackingCategory === 'full').length
      return {
        label,
        value,
        segments: [
          { key: 'full', value: fullCount, color: COLORS.full },
          { key: 'limited', value: value - fullCount, color: COLORS.limited },
        ],
      }
    })
  const categoryLegend = [
    { label: 'full', color: COLORS.full },
    { label: 'limited', color: COLORS.limited },
  ]
  const decisionLegend = [
    { label: 'granted', color: COLORS.granted },
    { label: 'partial', color: COLORS.partial },
    { label: 'denied', color: COLORS.denied },
  ]

  morphChildren($('#dashboard'), [
    panel({
      title: 'Events over time',
      note: 'by tracking category',
      span: 8,
      body: timeline(events),
      legendItems: categoryLegend,
      testid: 'chart-timeline',
    }),
    panel({
      title: 'Consent decisions',
      note: "each visitor's current decision",
      span: 4,
      body: h(
        'div',
        { style: { display: 'grid', placeItems: 'center' } },
        donut(
          ['granted', 'partial', 'denied'].map(decision => ({
            label: decision,
            value: decisions.filter(record => record.decision === decision).length,
            color: COLORS[decision],
          })),
          { center: String(decisions.length), caption: 'decisions' },
        ),
      ),
      legendItems: decisionLegend,
      testid: 'chart-decisions',
    }),
    panel({
      title: 'Tracking by country',
      note: 'full needs consent where it is required',
      span: 6,
      body: bars(segmentsFor(events, countryOf).slice(0, 10), { emptyText: 'No events yet.' }),
      legendItems: categoryLegend,
      testid: 'chart-countries',
    }),
    panel({
      title: 'Choices per category',
      note: 'share of decisions that allow it',
      span: 6,
      body: decisions.length
        ? bars(
            ['preferences', 'statistics', 'marketing'].map((name, index) => ({
              label: name,
              value: decisions.filter(record => allows(record, name)).length,
              color: paletteColor(index + 1),
              note: formatPercent(
                decisions.filter(record => allows(record, name)).length,
                decisions.length,
              ),
            })),
            { max: decisions.length },
          )
        : empty('No consent records yet.'),
      testid: 'chart-categories',
    }),
    panel({
      title: 'Consent by data-policy profile',
      note: "the profile the collector chose for the visitor's region",
      span: 6,
      body: bars(
        profiles.map(([profile, value]) => {
          const subset = decisions.filter(record => (record.profile ?? 'unknown') === profile)
          return {
            label: profile,
            value,
            segments: ['granted', 'partial', 'denied'].map(decision => ({
              key: decision,
              value: subset.filter(record => record.decision === decision).length,
              color: COLORS[decision],
            })),
          }
        }),
        { emptyText: 'No consent records yet.' },
      ),
      legendItems: decisionLegend,
      testid: 'chart-profiles',
    }),
    panel({
      title: 'Event mix',
      note: 'without web_vital and auto_metrics',
      span: 6,
      body: bars(
        segmentsFor(
          events.filter(event => !noise.has(event.name)),
          event => event.name,
        ).slice(0, 12),
        {
          emptyText: 'No events yet.',
        },
      ),
      legendItems: eventMix.length ? categoryLegend : undefined,
      testid: 'chart-events',
    }),
    panel({
      title: 'Top pages',
      note: 'page views',
      span: 6,
      body: bars(segmentsFor(pageViews, event => event.props?.path).slice(0, 8), {
        emptyText: 'No page views yet.',
      }),
      legendItems: pages.length ? categoryLegend : undefined,
      testid: 'chart-pages',
    }),
    panel({
      title: 'Acquisition',
      note: 'first-touch source, kept only with consent',
      span: 6,
      body: bars(
        sources.map(([label, value], index) => ({ label, value, color: paletteColor(index) })),
        { emptyText: 'No attributed visits yet.' },
      ),
      testid: 'chart-sources',
    }),
    panel({
      title: 'Web vitals',
      note: '75th percentile, rated by the Core Web Vitals thresholds',
      span: 12,
      body: vitalsView(events),
      legendItems: [
        { label: 'good', color: COLORS.full },
        { label: 'needs improvement', color: COLORS.limited },
        { label: 'poor', color: COLORS.denied },
      ],
      testid: 'chart-vitals',
    }),
    panel({
      title: 'Scroll depth',
      note: 'page views that reached it',
      span: 4,
      body: scrolled.some(row => row.value)
        ? bars(scrolled.map(row => ({ ...row, color: COLORS.cyan })))
        : empty('No scrolling yet.'),
      testid: 'chart-scroll',
    }),
    panel({
      title: 'Time on page',
      note: 'from page_exit',
      span: 4,
      body: exits.length
        ? bars(timeBuckets.map(row => ({ ...row, color: COLORS.violet })))
        : empty('No page exits yet.'),
      testid: 'chart-time',
    }),
    panel({
      title: 'Browsers and devices',
      note: 'parsed by the collector where the policy allows',
      span: 4,
      body: bars(
        devices
          .slice(0, 6)
          .map(([label, value], index) => ({ label, value, color: paletteColor(index) })),
        {
          emptyText: 'No device data yet.',
        },
      ),
      testid: 'chart-devices',
    }),
    panel({
      title: 'What the collector added, by profile',
      note: 'server-side enrichment the data policy allowed (— = nothing)',
      span: 12,
      body: profileMatrix(events),
      testid: 'chart-enrichment',
    }),
    panel({
      title: 'Outbound links',
      span: 6,
      body: bars(
        outbound.map(([label, value]) => ({ label, value, color: COLORS.blue })),
        { emptyText: 'No outbound clicks yet.' },
      ),
      testid: 'chart-outbound',
    }),
    panel({
      title: 'Errors',
      span: 6,
      body: bars(
        errors.map(([label, value]) => ({ label, value, color: COLORS.denied })),
        { emptyText: 'No errors yet.' },
      ),
      testid: 'chart-errors',
    }),
    panel({
      title: 'Event explorer',
      note: 'newest first',
      span: 12,
      body: explorer(events),
      testid: 'explorer',
    }),
  ])
}

// --- Data --------------------------------------------------------------------------------------
// Streaming data is drawn at most once a second: charts then move a step at a time
// instead of twitching with every event.
let pending = false
let lastRender = 0
const scheduleRender = () => {
  if (pending) return
  pending = true
  setTimeout(
    () => {
      pending = false
      lastRender = performance.now()
      render()
    },
    Math.max(250, 1000 - (performance.now() - lastRender)),
  )
}

async function load() {
  const [events, consents] = await Promise.all([collector.events(), collector.consents()])
  data.events = []
  data.consents = []
  merge(data.events, events, 'eventId', 'receivedAt')
  merge(data.consents, consents, 'recordId', 'recordedAt')
  render()
  document.body.dataset.loaded = 'true'
}

subscribe(({ type, data: item }) => {
  if (type === 'ready') void load()
  if (type === 'event') {
    merge(data.events, [item], 'eventId', 'receivedAt')
    scheduleRender()
  }
  if (type === 'consent') {
    merge(data.consents, [item], 'recordId', 'recordedAt')
    scheduleRender()
  }
  if (type === 'reset') {
    data.events = []
    data.consents = []
    render()
  }
})

for (const input of document.querySelectorAll('input[name="category"]'))
  input.addEventListener('change', render)

// The explorer's rows are redrawn in place, so selection is handled here, once.
$('#dashboard').addEventListener('click', event => {
  const row = event.target.closest('[data-event-id]')
  if (!row) return
  selectedEventId = row.dataset.eventId
  render()
})

$('#clear-data').addEventListener('click', async () => {
  if (!confirm('Delete every stored event and consent record, and reset the region?')) return
  await collector.reset()
})

// --- Simulated visitors -------------------------------------------------------------------------
let frame
let controller
const simulateButton = $('#simulate')
simulateButton.addEventListener('click', async () => {
  if (controller) {
    controller.abort()
    return
  }
  const count = Number(document.querySelector('input[name="visitors"]:checked').value)
  $('#simulation').hidden = false
  frame ??= createBrowserFrame($('#sim-browser'), { compact: true })
  $('#sim-browser').hidden = false
  controller = new AbortController()
  simulateButton.dataset.state = 'running'
  $('#simulate-label').textContent = 'Stop'
  try {
    // ?seed=42 replays the same visitors (used by the end-to-end tests).
    const seed = new URLSearchParams(location.search).get('seed')
    await simulateVisitors(frame, count, {
      signal: controller.signal,
      ...(seed ? { random: seededRandom(Number(seed)) } : {}),
      onProgress({ index, plan }) {
        $('#simulation-title').textContent = `Visitor ${index + 1} of ${count}`
        $('#simulation-detail').textContent =
          ` · ${plan.region?.country ?? 'unknown region'} · ${plan.source ? new URLSearchParams(plan.source).get('utm_source') : 'direct'} · ${plan.choice}${plan.gpc ? ' · GPC' : ''}`
        $('#simulation-progress').style.width = `${(index / count) * 100}%`
      },
    })
    $('#sim-browser').hidden = true
    $('#simulation-title').textContent = controller.signal.aborted
      ? 'Stopped'
      : `${count} visitors simulated`
    $('#simulation-detail').textContent = ''
    $('#simulation-progress').style.width = '100%'
  } catch (error) {
    $('#simulation-title').textContent = 'Simulation failed'
    $('#simulation-detail').textContent = ` · ${error.message ?? error}`
  } finally {
    controller = undefined
    simulateButton.dataset.state = 'idle'
    $('#simulate-label').textContent = 'Simulate visitors'
    document.body.dataset.simulated = 'true'
  }
})

window.playgroundDashboard = { data, render }
