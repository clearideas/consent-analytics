// Browser → collector → storage, animated: a packet for every request that leaves the
// browser, and for every record the collector stores. Tallies say what passed each stage.
import { anchor, flash, h, sendPacket } from './ui.js'

/** Short label for a request: the event names in a batch, or the endpoint. */
export function requestLabel(request) {
  const path = request.path ?? ''
  if (path.includes('/v1/events')) {
    const names = (request.body?.events ?? []).map(event => event.name)
    const unique = [...new Set(names)]
    return unique.length
      ? `${unique.slice(0, 2).join(', ')}${unique.length > 2 ? ` +${unique.length - 2}` : ''}`
      : 'events'
  }
  if (path.includes('/v1/consent')) return `consent: ${request.body?.decision ?? '?'}`
  if (path.includes('/v1/context')) {
    const policy = request.response?.policy
    return policy
      ? `consent ${policy.consentRequired ? 'required' : 'not required'} (${policy.reason})`
      : 'policy?'
  }
  return path.split('?')[0]
}

export function createFlow(container) {
  const layer = h('div.flow-layer', { 'aria-hidden': 'true' })
  const node = (title, subtitle) => {
    const tallies = h('div.tallies')
    const element = h(
      'div.flow-node',
      {},
      h('strong', { text: title }),
      h('small', { text: subtitle }),
      tallies,
    )
    return { element, tallies }
  }
  const browser = node("Visitor's browser", 'the library, in the demo website')
  const collector = node('Collector', '/v1 · CORS, validation, rules, policy')
  const storage = node('Storage', 'events and consent records')
  const root = h('div.flow', {}, browser.element, collector.element, storage.element, layer)
  container.replaceChildren(root)

  const counts = {
    requests: 0,
    beacons: 0,
    context: 0,
    batches: 0,
    records: 0,
    refused: 0,
    full: 0,
    limited: 0,
    consents: 0,
  }
  const render = () => {
    browser.tallies.replaceChildren(
      h('span', { text: `${counts.requests} requests` }),
      h('span', { text: `${counts.beacons} beacons` }),
    )
    collector.tallies.replaceChildren(
      h('span', { text: `${counts.context} context` }),
      h('span', { text: `${counts.batches} event batches` }),
      h('span', { text: `${counts.records} consent` }),
      h(`span${counts.refused ? '.bad' : ''}`, { text: `${counts.refused} refused` }),
    )
    storage.tallies.replaceChildren(
      h('span.full', { text: `${counts.full} full` }),
      h('span.limited', { text: `${counts.limited} limited` }),
      h('span.consent', { text: `${counts.consents} consent` }),
    )
  }
  render()

  const between = (from, to, options) =>
    sendPacket(
      layer,
      anchor(from.element, root, 'right'),
      anchor(to.element, root, 'left'),
      options,
    )

  return {
    reset() {
      for (const key of Object.keys(counts)) counts[key] = 0
      render()
    },
    /** A request left the browser. */
    sent(request) {
      counts.requests += 1
      if (request.transport === 'beacon') counts.beacons += 1
      if (request.path?.includes('/v1/context')) counts.context += 1
      if (request.path?.includes('/v1/events')) counts.batches += 1
      if (request.path?.includes('/v1/consent')) counts.records += 1
      render()
      flash(browser.element)
      const tone = request.path?.includes('/v1/consent') ? 'violet' : 'blue'
      void between(browser, collector, { tone, label: requestLabel(request) })
    },
    /** The collector answered a request the page could read (fetch, not beacons). */
    answered(request) {
      // Refused: a whole request (4xx), or single events in an accepted batch (rejected[]).
      if (typeof request.status === 'number' && request.status >= 400) counts.refused += 1
      counts.refused += request.response?.rejected?.length ?? 0
      render()
      flash(collector.element)
    },
    /** The collector stored an event or a consent record. */
    stored(kind, item) {
      if (kind === 'consent') counts.consents += 1
      else if (item.trackingCategory === 'full') counts.full += 1
      else counts.limited += 1
      render()
      flash(storage.element)
      const tone =
        kind === 'consent' ? 'violet' : item.trackingCategory === 'full' ? 'green' : 'amber'
      void between(collector, storage, {
        tone,
        label: kind === 'consent' ? item.decision : item.name,
        duration: 600,
      })
    },
  }
}
