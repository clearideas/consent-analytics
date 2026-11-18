// Shared matching rules for retention and data subject requests (every store must agree).
import type { Identity } from '../identity/index.ts'
import type { PurgeOptions, SubjectSelector } from './types.ts'

/** Whether a stored identity has all the selector's keys and values. */
export function identityMatches(
  stored: Identity | undefined,
  wanted: Identity | undefined,
): boolean {
  if (!stored || !wanted || !Object.keys(wanted).length) return false
  return Object.entries(wanted).every(([key, value]) => stored[key] === value)
}

export function siteMatches(siteKey: string, selector: SubjectSelector): boolean {
  return !selector.siteKey || selector.siteKey === siteKey
}

/** Per-profile cutoffs by profile name. */
export function profileCutoffs(options: PurgeOptions) {
  return new Map((options.profiles ?? []).map(entry => [entry.profile, entry]))
}

/** Whether an ISO time is on or before a cutoff. */
export const due = (iso: string | undefined, cutoff: Date | undefined, inclusive = true) => {
  if (!iso || !cutoff) return false
  const time = Date.parse(iso)
  return inclusive ? time <= cutoff.getTime() : time < cutoff.getTime()
}
