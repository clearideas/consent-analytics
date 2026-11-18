// Overview: what this collector is, and the playground's pages.
import { collector, siteKey } from './lib/collector.js'
import { SCENARIOS } from './lib/scenarios.js'
import { setupShell } from './lib/shell.js'
import { $, h } from './lib/ui.js'

setupShell()

// Small static diagrams. Motion is saved for the pages themselves.
const illustrations = {
  live: `
    <rect class="box" x="34" y="18" width="132" height="84" rx="8"/>
    <rect class="faint" x="34" y="18" width="132" height="14" rx="6"/>
    <rect class="faint" x="46" y="42" width="70" height="6" rx="3"/>
    <rect class="faint" x="46" y="54" width="90" height="6" rx="3"/>
    <rect class="accent" x="46" y="82" width="108" height="12" rx="3"/>
    <path class="line" d="M166 60 H214"/>
    <circle class="accent" cx="190" cy="60" r="5"/>
    <rect class="box" x="214" y="36" width="72" height="48" rx="8"/>
    <rect class="good" x="226" y="50" width="48" height="6" rx="3"/>
    <rect class="warn" x="226" y="64" width="32" height="6" rx="3"/>`,
  scenarios: `
    <circle class="good" cx="70" cy="30" r="7"/><rect class="faint" x="88" y="27" width="110" height="6" rx="3"/>
    <circle class="good" cx="70" cy="52" r="7"/><rect class="faint" x="88" y="49" width="90" height="6" rx="3"/>
    <circle class="good" cx="70" cy="74" r="7"/><rect class="faint" x="88" y="71" width="124" height="6" rx="3"/>
    <circle class="accent-stroke" cx="70" cy="96" r="7"/><rect class="faint" x="88" y="93" width="70" height="6" rx="3"/>
    <path class="good-stroke" d="M226 62 l14 14 l28 -30"/>`,
  analytics: `
    <circle cx="80" cy="60" r="30" fill="none" style="stroke: var(--green); stroke-width: 13" stroke-dasharray="98 200" transform="rotate(-90 80 60)"/>
    <circle cx="80" cy="60" r="30" fill="none" style="stroke: var(--blue); stroke-width: 13" stroke-dasharray="0 100 28 200" transform="rotate(-90 80 60)"/>
    <circle cx="80" cy="60" r="30" fill="none" style="stroke: var(--red); stroke-width: 13" stroke-dasharray="0 130 56 200" transform="rotate(-90 80 60)"/>
    <rect class="warn" x="150" y="74" width="16" height="26" rx="2"/>
    <rect class="good" x="174" y="52" width="16" height="48" rx="2"/>
    <rect class="good" x="198" y="38" width="16" height="62" rx="2"/>
    <rect class="warn" x="222" y="66" width="16" height="34" rx="2"/>
    <rect class="good" x="246" y="30" width="16" height="70" rx="2"/>`,
  plain: `
    <rect class="box" x="96" y="20" width="128" height="80" rx="8"/>
    <rect class="faint" x="110" y="36" width="60" height="6" rx="3"/>
    <rect class="accent" x="110" y="52" width="100" height="8" rx="3"/>
    <rect class="faint" x="110" y="68" width="80" height="6" rx="3"/>`,
  tools: `
    <path class="accent-stroke" d="M160 22 L192 32 L188 72 Q182 92 160 100 Q138 92 132 72 L128 32 Z"/>
    <circle class="warn" cx="84" cy="44" r="6"/><circle class="warn" cx="84" cy="76" r="6"/>
    <path class="line" d="M92 44 H124 M92 76 H124"/>
    <circle class="good" cx="236" cy="60" r="6"/><path class="line" d="M196 60 H228"/>`,
}

const illustration = id => {
  const graphic = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  graphic.setAttribute('viewBox', '0 0 320 120')
  graphic.setAttribute('aria-hidden', 'true')
  graphic.classList.add('ill')
  graphic.innerHTML = illustrations[id] ?? ''
  return graphic
}

const card = ({ id, href, title, summary }) =>
  h(
    'a.card.demo-card',
    { href, dataset: { testid: `card-${id}` } },
    h('div.illustration', {}, illustration(id)),
    h(
      'div.content',
      {},
      h('div.title-row', {}, h('h2', { text: title }), h('span.open', { text: 'Open →' })),
      h('p', { text: summary }),
    ),
  )

$('#gallery').replaceChildren(
  card({
    id: 'live',
    href: '/live',
    title: 'Live playground',
    summary:
      'Be the visitor: pick a region, accept or reject, click around, and follow each request into storage.',
  }),
  card({
    id: 'scenarios',
    href: '/scenarios',
    title: 'Scenarios',
    summary: `${SCENARIOS.length} scripted journeys, from an EU visitor who rejects to the collector contract, each checked at every layer.`,
  }),
  card({
    id: 'analytics',
    href: '/analytics',
    title: 'Analytics',
    summary:
      'Consent rates, full and limited events, pages, acquisition, web vitals and devices, from what was stored.',
  }),
)
$('#more').replaceChildren(
  card({
    id: 'plain',
    href: '/plain/first',
    title: 'Script-tag site',
    summary:
      'A plain website with one script tag (dist/analytics.js), full page loads and a pushState navigation.',
  }),
  card({
    id: 'tools',
    href: '/tools/',
    title: 'Third-party tools',
    summary:
      'Meta Pixel and Hotjar plugins, consent-gated scripts and a footer link, under a strict Content Security Policy.',
  }),
)

const row = (label, ...content) => h('div.env-row', {}, h('span', { text: label }), ...content)
try {
  const [info, state] = await Promise.all([collector.info(), collector.state()])
  const site = state.sites.find(entry => entry.siteKey === siteKey)
  $('#environment').replaceChildren(
    row(
      'Library',
      h('span.chip.ok', {}, h('i'), `consent-analytics ${info.versions.library ?? ''}`.trim()),
    ),
    row(
      'Collector',
      h('span.chip.ok', {}, h('i'), `server ${info.versions.server ?? ''}`.trim()),
      h('small', { text: `spec ${info.versions.spec} · ${info.store}` }),
    ),
    row(
      'Data policy',
      h(
        `span.chip.${info.dataPolicy === 'balanced' ? 'info' : 'violet'}`,
        {},
        h('i'),
        info.dataPolicy,
      ),
      h('small', {
        text:
          info.dataPolicy === 'balanced'
            ? 'adds server-side data by region'
            : 'stores what the browser sends',
      }),
    ),
    row(
      'Site',
      h('span.chip', {}, h('i'), siteKey),
      h('small', {
        text: site ? `policy ${site.policyVersion} · consent by ${site.consentMode}` : '',
      }),
    ),
    row(
      'Region',
      state.geoOverride
        ? h('span.chip.info', {}, h('i'), `override: ${state.geoOverride.country}`)
        : h('span.chip.warn', {}, h('i'), 'unknown'),
      h('small', {
        text: state.geoOverride ? 'set from the live playground' : 'so consent is required',
      }),
    ),
  )
} catch {
  $('#environment').replaceChildren(
    h('p.empty', {
      text: 'The collector does not answer. Start the playground with: npm run playground',
    }),
  )
}
