// Rules applied to each valid event before it is stored.
//
// `standard` (default) repairs instead of rejecting, always toward the more private reading,
// and records what it changed in `sanitized`. Events that cannot be allowed (for example a
// sign-up sent without consent) are dropped and reported in `rejected[]`.
// `strict` drops inconsistent events instead of repairing them. `off` applies no rules.
import type { Event, FieldError } from '../protocol/index.ts'
import { isLimitedEventName, isLimitedField } from '../protocol/index.ts'
import type { Site } from '../sites/index.ts'

export type RulesPreset = 'standard' | 'strict' | 'off'

export interface RuleContext {
  site: Site
  /** Whether consent is required for this visitor (site setting, else region profile). */
  consentRequired: boolean
  /** The region's policy forbids sending anything without consent. */
  nothingWithoutConsent: boolean
  receivedAt: Date
  /** The batch's sentAt (client clock). */
  sentAt: string
}

export type RuleOutcome =
  { drop: FieldError } | { event: Event; sanitized?: string } | undefined | void

/** Your own rule: return `{ drop }`, a modified `{ event }`, or nothing to keep it as is. */
export type CustomRule = (event: Readonly<Event>, context: RuleContext) => RuleOutcome

export interface RulesOptions {
  preset?: RulesPreset
  /** Corrected times further in the past are replaced by the receive time. Default 7 days. */
  maxPastDays?: number
  /** Corrected times further in the future are replaced by the receive time. Default 10 minutes. */
  maxFutureMinutes?: number
  custom?: readonly CustomRule[]
}

export type RuleResult =
  | { keep: true; event: Event; sanitized: string[]; occurredAtCorrected: string }
  | { keep: false; error: FieldError }

const LIMITED_MESSAGE_MAX = 500

/** Origin + path of a URL (no query, fragment or credentials), or undefined if not a URL. */
export function originAndPath(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.origin}${url.pathname}`
  } catch {
    return undefined
  }
}

export function createRules(options: RulesOptions = {}) {
  const preset = options.preset ?? 'standard'
  if (!['standard', 'strict', 'off'].includes(preset)) {
    throw new Error(`rules.preset must be standard, strict or off (got "${preset}")`)
  }
  const maxPastMs = (options.maxPastDays ?? 7) * 86_400_000
  const maxFutureMs = (options.maxFutureMinutes ?? 10) * 60_000
  const custom = options.custom ?? []
  const strict = preset === 'strict'

  return function applyRules(input: Event, context: RuleContext): RuleResult {
    let event: Event = { ...input, consent: { ...input.consent }, props: { ...input.props } }
    const sanitized: string[] = []
    const drop = (path: string, message: string): RuleResult => ({
      keep: false,
      error: { path, message },
    })

    if (preset !== 'off') {
      // Site event name lists.
      const names = context.site.eventNames
      if (names?.allow && !names.allow.includes(event.name)) {
        return drop('/name', 'event name not accepted for this site')
      }
      if (names?.deny?.includes(event.name))
        return drop('/name', 'event name not accepted for this site')

      // Consistency of the consent claims: never more than the visitor gave.
      if (event.trackingCategory === 'limited' && event.consent.granted) {
        if (strict) return drop('/consent/granted', 'limited events cannot have consent granted')
        event.consent.granted = false
        sanitized.push('consent-granted-cleared')
      }
      if (
        event.trackingCategory === 'full' &&
        !event.consent.granted &&
        (event.consent.required || context.consentRequired)
      ) {
        if (strict) return drop('/trackingCategory', 'full tracking needs consent here')
        event.trackingCategory = 'limited'
        sanitized.push('downgraded-to-limited')
      }

      // Limited events: anonymous essentials only (x-limited-tracking).
      if (event.trackingCategory === 'limited') {
        if (context.nothingWithoutConsent && context.consentRequired) {
          return drop('/', 'nothing is collected without consent in this region')
        }
        if (!isLimitedEventName(event.name)) {
          return drop('/name', 'this event is not collected without consent')
        }
        const extra = Object.keys(event.props).filter(key => !isLimitedField(key))
        if (extra.length) {
          if (strict) return drop(`/props/${extra[0]}`, 'not allowed in limited events')
          for (const key of extra) delete event.props[key]
          sanitized.push('limited-props-removed')
        }
        for (const key of ['url', 'outboundUrl']) {
          const value = event.props[key]
          if (typeof value !== 'string') continue
          const reduced = originAndPath(value)
          if (reduced === undefined) {
            delete event.props[key]
            sanitized.push('limited-url-removed')
          } else if (reduced !== value) {
            event.props[key] = reduced
            sanitized.push('limited-url-reduced')
          }
        }
        const message = event.props.message
        if (typeof message === 'string' && message.length > LIMITED_MESSAGE_MAX) {
          event.props.message = message.slice(0, LIMITED_MESSAGE_MAX)
          sanitized.push('limited-message-shortened')
        }
      }
    }

    // Time: correct for clock skew (received - sent); replace implausible results.
    const received = context.receivedAt.getTime()
    const occurred = Date.parse(event.occurredAt)
    const sent = Date.parse(context.sentAt)
    let corrected = Number.isFinite(sent) ? occurred + (received - sent) : occurred
    if (
      !Number.isFinite(corrected) ||
      corrected > received + maxFutureMs ||
      corrected < received - maxPastMs
    ) {
      corrected = received
      sanitized.push('occurred-at-replaced')
    }

    for (const rule of custom) {
      const outcome = rule(event, context)
      if (!outcome) continue
      if ('drop' in outcome) return { keep: false, error: outcome.drop }
      event = outcome.event
      if (outcome.sanitized) sanitized.push(outcome.sanitized)
    }

    return {
      keep: true,
      event,
      sanitized: [...new Set(sanitized)],
      occurredAtCorrected: new Date(corrected).toISOString(),
    }
  }
}

/** Annotations for a consent record. Records are evidence: they are stored as received. */
export function annotateConsent(
  record: {
    decision: string
    categories?: { preferences: boolean; statistics: boolean; marketing: boolean } | null
    policyVersion: string
  },
  site: Site,
): string[] {
  const annotations: string[] = []
  const choices = record.categories
    ? [record.categories.preferences, record.categories.statistics, record.categories.marketing]
    : null
  if (choices) {
    const consistent =
      record.decision === 'granted'
        ? choices.every(Boolean)
        : record.decision === 'denied'
          ? choices.every(choice => !choice)
          : choices.some(Boolean) && !choices.every(Boolean)
    if (!consistent) annotations.push('decision-categories-mismatch')
  } else if (record.decision === 'partial') {
    annotations.push('partial-without-categories')
  }
  if (record.policyVersion !== site.policyVersion) annotations.push('policy-version-not-current')
  return annotations
}
