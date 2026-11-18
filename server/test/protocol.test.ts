// The public protocol API: validation results and the constants that mirror the spec.
import { describe, expect, it } from 'vitest'

import { loadSpec } from '../scripts/generate.mjs'
import {
  CONSENT_MAX_BYTES,
  EVENT_CATALOG,
  EVENTS_MAX_BYTES,
  isLimitedEventName,
  isLimitedField,
  LIMITED_TRACKING,
  SITE_KEY_PATTERN,
  SPEC_VERSION,
  validate,
} from '../src/index.ts'

const spec = loadSpec()

describe('validate', () => {
  it('accepts the examples in the spec', () => {
    expect(
      validate(
        'EventBatch',
        spec.paths['/v1/events'].post.requestBody.content['application/json'].example,
      ),
    ).toEqual([])
    expect(
      validate(
        'ConsentRecordRequest',
        spec.paths['/v1/consent'].post.requestBody.content['application/json'].example,
      ),
    ).toEqual([])
  })

  it('reports every error with a JSON Pointer and a readable message', () => {
    const errors = validate('ConsentRecordRequest', {
      v: 2,
      siteKey: 'demo-site',
      consentId: 'short',
      decision: 'maybe',
      policyVersion: '1',
      decidedAt: 'yesterday',
      source: 'banner',
      extra: true,
    })
    expect(errors).toEqual(
      expect.arrayContaining([
        { path: '/v', message: 'must be equal to constant' },
        { path: '/consentId', message: expect.stringContaining('must match pattern') },
        { path: '/decision', message: 'must be equal to one of the allowed values' },
        { path: '/decidedAt', message: 'must match format "date-time"' },
        { path: '/', message: 'unexpected property "extra"' },
      ]),
    )
  })

  it('reports missing required properties at the object that lacks them', () => {
    expect(validate('Event', {})).toEqual(
      expect.arrayContaining([{ path: '/', message: "must have required property 'eventId'" }]),
    )
  })

  it('rejects unknown schema names', () => {
    expect(() => validate('Nope' as any, {})).toThrow('Unknown schema: Nope')
  })
})

describe('constants mirror the spec', () => {
  it('version, site key pattern and body limits', () => {
    expect(SPEC_VERSION).toBe(spec.info.version)
    expect(SITE_KEY_PATTERN.source).toBe(spec.components.schemas.SiteKey.pattern)
    const text = spec.info.description.replace(/\s+/g, ' ')
    expect(text).toContain(
      `bodies MUST NOT exceed ${EVENTS_MAX_BYTES.toLocaleString('en-US')} bytes`,
    )
    expect(text).toContain(
      `bodies MUST NOT exceed ${CONSENT_MAX_BYTES.toLocaleString('en-US')} bytes`,
    )
  })

  it('limited tracking lists and the event catalog', () => {
    expect(LIMITED_TRACKING).toEqual({
      events: spec['x-limited-tracking'].events,
      fields: spec['x-limited-tracking'].fields,
    })
    expect(isLimitedEventName('page_view')).toBe(true)
    expect(isLimitedEventName('sign_up')).toBe(false)
    expect(isLimitedField('path')).toBe(true)
    expect(isLimitedField('userAgent')).toBe(false)
    for (const [event, schema] of Object.entries(EVENT_CATALOG)) {
      expect(spec['x-event-catalog'].events[event]).toBe(`#/components/schemas/${schema}`)
    }
  })
})
