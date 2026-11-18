// Consent record IDs are derived from the record itself, so a retried record (the browser
// resends the identical body) gets the same recordId without a database lookup. This works
// the same whether records are written directly or through a queue. A new decision always
// differs in decidedAt (and usually in its choices), so it gets a new record. The key is the
// one the spec names: siteKey, consentId, decidedAt, decision, categories, policyVersion.
import { createHash } from 'node:crypto'

import type { ConsentRecordRequest } from '../protocol/index.ts'

export function consentRecordId(siteKey: string, record: ConsentRecordRequest): string {
  const categories = record.categories
    ? [record.categories.preferences, record.categories.statistics, record.categories.marketing]
    : null
  const key = JSON.stringify([
    'consent-record/v1',
    siteKey,
    record.consentId,
    record.decidedAt,
    record.decision,
    categories,
    record.policyVersion,
  ])
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}
