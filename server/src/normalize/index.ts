// A typed, queryable view of an event's props, following the spec's event catalog. The raw
// props are always stored too; this projection adds consistent field names and types:
// duplicated fields are merged (title/pageTitle, timeSpent/timeSpentTotal/duration, top-level
// utm_* and props.attribution), and `auto_metrics` gets its phase.
import type { PropValue } from '../protocol/index.ts'
import { CATALOG_PROPERTIES } from '../protocol/index.ts'

export interface EventProjection {
  page?: {
    url?: string
    path?: string
    referrer?: string
    title?: string
    viewportBucket?: string
    deviceBucket?: string
    connectionType?: string
  }
  /** First-touch attribution (utm_*, ci_*, click IDs, landing page and times). */
  attribution?: Record<string, string>
  /** Browser context sent with full events. */
  client?: {
    userAgent?: string
    timezone?: string
    language?: string
    country?: string
    continent?: string
  }
  engagement?: {
    timeSpent?: number
    clicks?: number
    keypresses?: number
    maxScrollDepth?: number
    /** scroll_depth: the new maximum depth. */
    scrollDepth?: number
  }
  vital?: { name: string; value: number }
  load?: {
    /** `dom`: sent at DOM ready; `load`: after window load. */
    phase: 'dom' | 'load'
    domContentLoadedTime?: number
    domInteractiveTime?: number
    totalResources?: number
    cachedResources?: number
    totalTransferSize?: number
    totalEncodedSize?: number
    totalDecodedSize?: number
    fullyLoadedTime?: number
    pageLoadTime?: number
  }
  outbound?: { url?: string; host?: string; path?: string; text?: string }
  error?: { message: string }
  /** The browser dropped this event's props because they were too large. */
  propsTruncated?: true
}

type Props = Record<string, PropValue>

const str = (value: PropValue | undefined): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined
const num = (value: PropValue | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** Copy the listed keys whose values have the expected type. */
function pick<T>(
  props: Props,
  keys: readonly string[],
  read: (v: PropValue | undefined) => T | undefined,
) {
  const out: Record<string, T> = {}
  for (const key of keys) {
    const value = read(props[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

const orUndefined = <T extends object>(value: T): T | undefined =>
  Object.keys(value).length ? value : undefined

const ATTRIBUTION_KEYS = CATALOG_PROPERTIES.Attribution.properties
const LOAD_KEYS = CATALOG_PROPERTIES.AutoMetricsProps.properties
const TOP_LEVEL_ATTRIBUTION = ATTRIBUTION_KEYS.filter(
  key =>
    key.startsWith('utm_') || key.startsWith('ci_') || ['gclid', 'msclkid', 'fbclid'].includes(key),
)

export function normalizeEvent(name: string, props: Props): EventProjection {
  const projection: EventProjection = {}
  if (props.propsTruncated === true) projection.propsTruncated = true

  const title = str(props.title) ?? str(props.pageTitle)
  const page = orUndefined({
    ...pick(
      props,
      ['url', 'path', 'referrer', 'viewportBucket', 'deviceBucket', 'connectionType'],
      str,
    ),
    ...(title ? { title } : {}),
  })
  if (page) projection.page = page

  const nested = props.attribution
  const attribution = {
    ...pick(props, TOP_LEVEL_ATTRIBUTION, str),
    ...(nested && typeof nested === 'object' && !Array.isArray(nested)
      ? pick(nested as Props, ATTRIBUTION_KEYS, str)
      : {}),
  }
  const attributionValue = orUndefined(attribution)
  if (attributionValue) projection.attribution = attributionValue

  const client = orUndefined(
    pick(props, ['userAgent', 'timezone', 'language', 'country', 'continent'], str),
  )
  if (client) projection.client = client

  const timeSpent = num(props.timeSpent) ?? num(props.timeSpentTotal) ?? num(props.duration)
  const engagement = {
    ...(timeSpent !== undefined ? { timeSpent } : {}),
    ...pick(props, ['clicks', 'keypresses', 'maxScrollDepth'], num),
    ...(name === 'scroll_depth' && num(props.depth) !== undefined
      ? { scrollDepth: num(props.depth)! }
      : {}),
  }
  const engagementValue = orUndefined(engagement)
  if (engagementValue) projection.engagement = engagementValue

  switch (name) {
    case 'web_vital': {
      const vitalName = str(props.name)
      const value = num(props.value)
      if (vitalName && value !== undefined) projection.vital = { name: vitalName, value }
      break
    }
    case 'auto_metrics': {
      const timings = pick(props, LOAD_KEYS, num)
      const phase = 'fullyLoadedTime' in timings || 'pageLoadTime' in timings ? 'load' : 'dom'
      projection.load = { phase, ...timings }
      break
    }
    case 'outbound_link_click': {
      const outbound = orUndefined({
        ...(str(props.outboundUrl) ? { url: str(props.outboundUrl)! } : {}),
        ...(str(props.outboundHost) ? { host: str(props.outboundHost)! } : {}),
        ...(str(props.outboundPath) ? { path: str(props.outboundPath)! } : {}),
        ...(str(props.outboundText) ? { text: str(props.outboundText)! } : {}),
      })
      if (outbound) projection.outbound = outbound
      break
    }
    case 'error': {
      const message = str(props.message)
      if (message) projection.error = { message }
      break
    }
  }
  return projection
}
