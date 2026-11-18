// The generated protocol code against its sources:
//  - the committed files are exactly what the generator produces from the current spec,
//  - the standalone validators behave exactly like Ajv compiling the spec at runtime,
//  - the vendored runtime helpers behave exactly like the Ajv/ajv-formats originals.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createAjv,
  createDataPolicyAjv,
  generate,
  loadDataPolicySchema,
  loadSpec,
} from '../scripts/generate.mjs'
import { validateDataPolicyDocument } from '../src/policy/generated/data-policy-validator.ts'
import { SCHEMA_NAMES, type SchemaName } from '../src/protocol/generated/spec.ts'
import { validators } from '../src/protocol/generated/validators.ts'
import { formats, ucs2length } from '../src/protocol/runtime.ts'

const require = createRequire(import.meta.url)
const spec = loadSpec()
const ajv = createAjv(spec)
const reference = (name: SchemaName) => ajv.getSchema(`urn:clearideas:analytics:v1#/$defs/${name}`)!

const summary = (errors: any[] | null | undefined) =>
  (errors ?? []).map(e => `${e.instancePath} ${e.keyword} ${e.message}`).sort()

/**
 * Compare the generated validator with Ajv's on one document: validity and errors.
 * Returns the generated validator's verdict, and a description of any difference.
 */
function compare(name: SchemaName, data: unknown): { valid: boolean; mismatch?: string } {
  const generated = validators[name]
  const original = reference(name)
  const a = generated(data)
  const b = original(data)
  const errorsA = summary(generated.errors)
  const errorsB = summary(original.errors)
  if (a === b && errorsA.length === errorsB.length && errorsA.every((e, i) => e === errorsB[i])) {
    return { valid: a }
  }
  return {
    valid: a,
    mismatch: `${name}: ${JSON.stringify(data).slice(0, 300)}\n  generated ${a} ${JSON.stringify(errorsA)}\n  ajv       ${b} ${JSON.stringify(errorsB)}`,
  }
}

/** Assert one document gets the same result from both; returns the verdict. */
function expectSameResult(name: SchemaName, data: unknown): boolean {
  const { valid, mismatch } = compare(name, data)
  expect(mismatch).toBeUndefined()
  return valid
}

// --- corpus ---------------------------------------------------------------------------

const event = () => ({
  eventId: '6730a1f0c3d4e5f6a7b8c9d0',
  name: 'page_view',
  occurredAt: '2026-11-10T12:00:00.000Z',
  sessionId: '6730a1f0aabbccddeeff0011',
  pageViewId: '6730a1f0c3d4e5f6a7b8c9d0',
  trackingCategory: 'full',
  consent: { required: false, granted: false },
  props: {
    url: 'https://www.example.com/pricing',
    path: '/pricing',
    nested: { a: [1, 'x', null] },
  },
})
const batch = () => ({
  v: 1,
  siteKey: 'demo-site',
  sentAt: '2026-11-10T12:00:01.000Z',
  events: [event()],
})
const consent = () => ({
  v: 1,
  siteKey: 'demo-site',
  consentId: '6730a1f0c3d4e5f6a7b8c9d1',
  decision: 'partial',
  categories: { preferences: false, statistics: true, marketing: false },
  policyVersion: '2026-11-01',
  decidedAt: '2026-11-10T12:00:05.000Z',
  source: 'banner',
})

const DATE_TIMES = [
  '2026-11-10T12:00:00Z',
  '2026-11-10T12:00:00.123Z',
  '2026-11-10t12:00:00z',
  '2026-11-10 12:00:00Z',
  '2026-11-10T12:00:00+02:00',
  '2026-11-10T12:00:00-0530',
  '2026-11-10T12:00:00',
  '2026-02-29T00:00:00Z',
  '2024-02-29T00:00:00Z',
  '2026-13-01T00:00:00Z',
  '2026-04-31T00:00:00Z',
  '2016-12-31T23:59:60Z',
  '2016-12-31T22:59:60-01:00',
  '2016-12-31T23:59:61Z',
  '2026-11-10T24:00:00Z',
  '2026-11-10T12:00:00+24:00',
  '2026-11-10',
  'not a date',
  '',
]

/** Single-point mutations of a valid document: each property removed, retyped, nulled. */
function* mutations(doc: any, path: string[] = []): Generator<any> {
  if (!doc || typeof doc !== 'object') return
  for (const key of Object.keys(doc)) {
    const at = (value: unknown, remove = false) => {
      const copy = structuredClone(doc)
      if (remove) delete copy[key]
      else copy[key] = value
      return copy
    }
    for (const value of [undefined, null, 0, -1, 1.5, true, '', 'x', 'x'.repeat(65), [], {}]) {
      yield { path: [...path, key], doc: value === undefined ? at(null, true) : at(value) }
    }
    for (const nested of mutations(doc[key], [...path, key])) {
      const copy = structuredClone(doc)
      copy[key] = nested.doc
      yield { path: nested.path, doc: copy }
    }
  }
}

/** Deterministic pseudo-random JSON values. */
function randomValue(seed: { n: number }, depth = 0): unknown {
  const next = () => (seed.n = (seed.n * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  const pick = Math.floor(next() * (depth > 3 ? 5 : 7))
  switch (pick) {
    case 0:
      return null
    case 1:
      return next() > 0.5
    case 2:
      return Math.floor(next() * 200) - 50
    case 3:
      return [
        'page_view',
        'full',
        'limited',
        'granted',
        'demo-site',
        '😀'.repeat(1025),
        DATE_TIMES[Math.floor(next() * DATE_TIMES.length)],
      ][Math.floor(next() * 7)]
    case 4:
      return 'abcdefgh'.slice(0, Math.floor(next() * 8) + 1)
    case 5:
      return Array.from({ length: Math.floor(next() * 4) }, () => randomValue(seed, depth + 1))
    default:
      return Object.fromEntries(
        Array.from({ length: Math.floor(next() * 4) }, (_, i) => [
          ['v', 'siteKey', 'events', 'props', 'name', 'value', `k${i}`][Math.floor(next() * 7)]!,
          randomValue(seed, depth + 1),
        ]),
      )
  }
}

// --- tests ----------------------------------------------------------------------------

describe('generated files', () => {
  it('are up to date with spec/openapi.yaml', () => {
    for (const [name, content] of Object.entries(generate(spec))) {
      const committed = readFileSync(join(import.meta.dirname, '..', 'src', name), 'utf8')
      expect(committed === content, `${name} is stale: run npm run generate`).toBe(true)
    }
  })

  it('cover every schema of the spec', () => {
    expect([...SCHEMA_NAMES]).toEqual(Object.keys(spec.components.schemas))
    for (const name of SCHEMA_NAMES) expect(typeof validators[name]).toBe('function')
  })

  it('need nothing at runtime but the package itself', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src/protocol/generated/validators.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/require\(/)
    expect([...source.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1])).toEqual([
      '../runtime.ts',
      '../validator-types.ts',
      './spec.ts',
    ])
  })
})

// These compare thousands of documents. Mismatches are collected and asserted once (not one
// assertion per document), and the timeout leaves room for slow or busy CI machines.
describe('standalone validators behave exactly like Ajv', { timeout: 30_000 }, () => {
  it('on the examples in the spec', () => {
    const examples: Array<[SchemaName, unknown]> = [
      ['EventBatch', spec.paths['/v1/events'].post.requestBody.content['application/json'].example],
      [
        'ConsentRecordRequest',
        spec.paths['/v1/consent'].post.requestBody.content['application/json'].example,
      ],
      [
        'Context',
        spec.paths['/v1/context'].get.responses['200'].content['application/json'].example,
      ],
    ]
    for (const [name, example] of examples) expect(expectSameResult(name, example)).toBe(true)
  })

  it('on every single-point mutation of valid requests', () => {
    let invalid = 0
    const mismatches: string[] = []
    for (const [name, doc] of [
      ['Event', event()],
      ['EventBatch', batch()],
      ['ConsentRecordRequest', consent()],
    ] as const) {
      expect(expectSameResult(name, doc)).toBe(true)
      for (const mutation of mutations(doc)) {
        const result = compare(name, mutation.doc)
        if (!result.valid) invalid++
        if (result.mismatch) mismatches.push(result.mismatch)
      }
    }
    expect(mismatches).toEqual([])
    expect(invalid).toBeGreaterThan(100) // guard against a corpus that never fails
  })

  it('on timestamps, string lengths in code points, and nested props', () => {
    for (const occurredAt of DATE_TIMES) expectSameResult('Event', { ...event(), occurredAt })
    for (const text of ['x'.repeat(2048), 'x'.repeat(2049), '😀'.repeat(2048), '😀'.repeat(2049)]) {
      expectSameResult('Event', { ...event(), props: { text } })
    }
    let deep: unknown = 'leaf'
    for (let i = 0; i < 30; i++) deep = i % 2 ? [deep] : { k: deep }
    expectSameResult('Event', { ...event(), props: { deep } })
    expectSameResult('Event', {
      ...event(),
      props: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i])),
    })
    expectSameResult('EventBatch', { ...batch(), events: Array.from({ length: 51 }, event) })
  })

  it('on pseudo-random documents, for every schema', () => {
    const seed = { n: 42 }
    const mismatches: string[] = []
    let valid = 0
    for (let i = 0; i < 300; i++) {
      const value = randomValue(seed)
      for (const name of SCHEMA_NAMES) {
        const result = compare(name, value)
        if (result.valid) valid++
        if (result.mismatch) mismatches.push(result.mismatch)
      }
    }
    expect(mismatches).toEqual([])
    expect(valid).toBeGreaterThan(0) // guard: the corpus exercises both verdicts
  })
})

describe('vendored runtime helpers match the originals', () => {
  const ajvUcs2length = require('ajv/dist/runtime/ucs2length').default
  const { fullFormats } = require('ajv-formats/dist/formats')

  it('ucs2length', () => {
    for (const text of ['', 'abc', '😀', 'a😀b', '\ud83d', '\ude00', '\ud83dx', 'é', '👩‍👩‍👧']) {
      expect(ucs2length(text), JSON.stringify(text)).toBe(ajvUcs2length(text))
    }
  })

  it('date-time (validate and compare)', () => {
    const ours = formats['date-time'] as { validate: (s: string) => boolean; compare: Function }
    for (const value of DATE_TIMES) {
      expect(ours.validate(value), value).toBe(fullFormats['date-time'].validate(value))
      for (const other of DATE_TIMES) {
        expect(ours.compare(value, other)).toEqual(fullFormats['date-time'].compare(value, other))
      }
    }
  })

  it('every format the generated code uses is provided', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src/protocol/generated/validators.ts'),
      'utf8',
    )
    const used = new Set([...source.matchAll(/formats\["([^"]+)"\]/g)].map(m => m[1]))
    expect([...used].sort()).toEqual(Object.keys(formats).sort())
  })
})

describe('the data policy validator behaves exactly like Ajv', () => {
  const schema = loadDataPolicySchema()
  const reference = createDataPolicyAjv(schema).getSchema(schema.$id)!
  const minimal = () => ({
    version: 1,
    profiles: { consent: { consent: { required: true } }, open: { consent: { required: false } } },
    rules: [
      { match: 'unknown', profile: 'consent' },
      { match: '*', profile: 'open' },
    ],
  })
  const complete = () => ({
    $schema: './schema.json',
    version: 1,
    description: 'd',
    regionSets: { gdpr: ['@EEA', 'GB', 'CH'], states: ['US-CA', 'US-CO'] },
    profiles: {
      gdpr: {
        description: 'EU',
        consent: { required: true, withoutConsent: 'limited' },
        collect: {
          full: {
            ip: 'full',
            geo: 'coords',
            network: 'org',
            userAgent: 'raw',
            language: true,
            privacyFlags: true,
            gpc: true,
            identity: true,
            clientProps: { deny: ['userAgent'] },
          },
          limited: {
            geo: 'country',
            network: 'asn',
            userAgent: 'device-type',
            language: true,
            gpc: true,
          },
          onGlobalPrivacyControl: { ip: 'none' },
        },
        retention: { events: '25mo', ip: '30d', rawUserAgent: '12w', consents: '5y' },
      },
    },
    rules: [
      { match: ['unknown', '@gdpr'], profile: 'gdpr' },
      { match: 'US-CA', profile: 'gdpr' },
      { match: '*', profile: 'gdpr' },
    ],
  })

  it('on every single-point mutation of a complete and a minimal policy', () => {
    const mismatches: string[] = []
    let invalid = 0
    for (const doc of [complete(), minimal()]) {
      expect(validateDataPolicyDocument(doc)).toBe(true)
      for (const mutation of mutations(doc)) {
        const a = validateDataPolicyDocument(mutation.doc)
        const ea = summary(validateDataPolicyDocument.errors)
        const b = reference(mutation.doc)
        const eb = summary(reference.errors)
        if (!a) invalid++
        if (a !== b || JSON.stringify(ea) !== JSON.stringify(eb)) {
          mismatches.push(
            `${mutation.path.join('/')}: ${a} ${JSON.stringify(ea)} vs ${b} ${JSON.stringify(eb)}`,
          )
        }
      }
    }
    expect(mismatches).toEqual([])
    expect(invalid).toBeGreaterThan(200) // guard against a corpus that never fails
  })
})
