// The sample collector, seen from the playground: its contract endpoints (/v1) and the
// development endpoints (/_dev, DEV_MODE only) that list what it stored and change its
// region override and site policy.
const { apiBaseUrl, siteKey } = window.PLAYGROUND

export { apiBaseUrl, siteKey }

export const api = path => `${apiBaseUrl.replace(/\/$/u, '')}${path}`

const json = async response => {
  if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status}`)
  return response.json()
}

const post = (path, body) =>
  fetch(api(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(json)

export const collector = {
  /** Stored events of the playground site, oldest first. */
  events: () => fetch(api(`/_dev/events?siteKey=${siteKey}&limit=5000`)).then(json),
  consents: () => fetch(api(`/_dev/consents?siteKey=${siteKey}`)).then(json),
  state: () => fetch(api('/_dev/state')).then(json),
  info: () => fetch(api('/_dev/info')).then(json),
  health: () =>
    fetch(api('/v1/health')).then(
      response => response.ok,
      () => false,
    ),
  /** Pretend every visitor comes from `country` (null: unknown region). */
  setRegion: (country, continent) => post('/_dev/geo', { country, continent }),
  /** Change the playground site's policy (policyVersion, consentMode, trackingWithoutConsent). */
  setPolicy: changes => post('/_dev/policy', { siteKey, ...changes }),
  /** Delete everything stored, clear the region override and restore the site policy. */
  reset: () => post('/_dev/reset'),
}

/**
 * Live changes from the collector (server-sent events): { type: 'event' | 'consent' | 'reset',
 * data }. Only the playground site's items are passed on.
 */
export function subscribe(listener) {
  const stream = new EventSource(api('/_dev/stream'))
  const forward = type => message => {
    const data = JSON.parse(message.data || '{}')
    if (type !== 'reset' && data.siteKey && data.siteKey !== siteKey) return
    listener({ type, data })
  }
  stream.addEventListener('ready', forward('ready'))
  stream.addEventListener('event', forward('event'))
  stream.addEventListener('consent', forward('consent'))
  stream.addEventListener('reset', forward('reset'))
  return () => stream.close()
}

/** Keep `list` sorted by `timeKey`, adding only items not seen yet (by `idKey`). */
export function merge(list, incoming, idKey, timeKey) {
  const seen = new Set(list.map(item => item[idKey]))
  for (const item of incoming) {
    if (seen.has(item[idKey])) continue
    seen.add(item[idKey])
    list.push(item)
  }
  list.sort((a, b) => (a[timeKey] < b[timeKey] ? -1 : a[timeKey] > b[timeKey] ? 1 : 0))
  return list
}

/** Events that are mostly measurement noise in a feed. */
export const NOISE = new Set(['web_vital', 'auto_metrics'])
