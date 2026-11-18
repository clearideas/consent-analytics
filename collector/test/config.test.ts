// Configuration from environment variables.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig, parseDurationMs } from '../src/config.ts'

const dir = mkdtempSync(join(tmpdir(), 'ca-collector-config-'))
const sitesFile = join(dir, 'sites.json')
writeFileSync(
  sitesFile,
  JSON.stringify([{ siteKey: 'my-site', allowedOrigins: ['https://www.example.com'] }]),
)

function problems(env: Record<string, string>): string[] {
  try {
    loadConfig(env)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return (error as ConfigError).problems
  }
  throw new Error('expected invalid configuration')
}

describe('loadConfig', () => {
  it('defaults: API, SQLite, no queue, direct delivery, balanced policy', () => {
    expect(loadConfig({ SITES_FILE: sitesFile })).toMatchObject({
      mode: 'api',
      port: 8787,
      store: 'sqlite',
      databasePath: './data/analytics.db',
      queue: 'none',
      delivery: { events: 'direct', consent: 'direct' },
      dataPolicy: { preset: 'balanced' },
      rulesPreset: 'standard',
      trustProxy: false,
      autoMigrate: true,
      retentionIntervalMs: 3_600_000,
      sites: [{ siteKey: 'my-site' }],
    })
  })

  it('treats empty variables as unset (as compose files often pass them)', () => {
    expect(
      loadConfig({
        SITES_FILE: sitesFile,
        MODE: '',
        STORE: ' ',
        SITES_CACHE_TTL: '',
        HASH_SECRET: '',
      }),
    ).toMatchObject({
      mode: 'api',
      store: 'sqlite',
      sitesCacheTtlMs: 60_000,
      hashSecret: undefined,
    })
  })

  it('reads the sample host variables and the new ones', () => {
    const config = loadConfig({
      SITES_FILE: sitesFile,
      PORT: '9000',
      TRUSTED_GEO_HEADERS: 'CF-IPCountry, cf-ipcontinent',
      DEFAULT_COUNTRY: 'us',
      CONSENT_COUNTRIES: 'DE, FR',
      NO_TRACKING_WITHOUT_CONSENT_COUNTRIES: 'DE',
      CONTEXT_TTL_SECONDS: '600',
      QUEUE: 'redis',
      REDIS_URL: 'redis://r',
      DELIVERY_EVENTS: 'queued-fast',
      DELIVERY_CONSENT: 'direct',
      TRUST_PROXY: '10.0.0.0/8, 172.16.0.0/12',
      RATE_LIMIT_PER_IP: '600/1m',
      RETENTION_INTERVAL: '0',
      DATA_POLICY: '/etc/policy.json',
    })
    expect(config).toMatchObject({
      port: 9000,
      trustedGeoHeaders: ['cf-ipcountry', 'cf-ipcontinent'],
      defaultCountry: 'US',
      consentCountries: ['DE', 'FR'],
      noTrackingWithoutConsentCountries: ['DE'],
      contextTtlSeconds: 600,
      delivery: { events: 'queued-fast', consent: 'direct' },
      trustProxy: ['10.0.0.0/8', '172.16.0.0/12'],
      rateLimitPerIp: { limit: 600, windowMs: 60_000 },
      retentionIntervalMs: 0,
      dataPolicy: { file: '/etc/policy.json' },
    })
    expect(loadConfig({ SITES_FILE: sitesFile, TRUST_PROXY: '2' }).trustProxy).toBe(2)
    expect(
      loadConfig({ SITES_FILE: sitesFile, QUEUE: 'sqs', SQS_QUEUE_URL: 'q' }).delivery,
    ).toEqual({
      events: 'queued',
      consent: 'queued',
    })
  })

  it('lists every problem at once', () => {
    expect(
      problems({
        STORE: 'oracle',
        MODE: 'worker',
        PORT: 'eighty',
        DEFAULT_COUNTRY: 'Germany',
        RATE_LIMIT_PER_IP: 'lots',
        HASH_SECRET: 'short',
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^STORE must be one of/),
        expect.stringMatching(/^PORT must be an integer/),
        'Configure sites: SITES_FILE (JSON array) and/or SITES_MONGODB_COLLECTION',
        'DEFAULT_COUNTRY must be an ISO 3166-1 alpha-2 code',
        expect.stringMatching(/^RATE_LIMIT_PER_IP must look like/),
        'MODE=worker needs a QUEUE to work from',
        'HASH_SECRET must be at least 16 characters',
      ]),
    )
  })

  it.each([
    [{ STORE: 'mongodb' }, 'STORE=mongodb needs MONGODB_URL'],
    [{ STORE: 'postgres' }, 'STORE=postgres needs POSTGRES_URL (or DATABASE_URL)'],
    [{ STORE: 'dynamodb' }, 'STORE=dynamodb needs DYNAMODB_TABLE'],
    [{ QUEUE: 'redis' }, 'QUEUE=redis needs REDIS_URL'],
    [{ QUEUE: 'memory' }, 'QUEUE=memory only works with MODE=all (API and worker in one process)'],
    [
      { DELIVERY_EVENTS: 'queued' },
      'Queued delivery (DELIVERY_EVENTS/DELIVERY_CONSENT) needs a QUEUE',
    ],
    [{ SITES_FILE: '/nope.json' }, expect.stringMatching(/^SITES_FILE could not be read/)],
  ])('%j is rejected', (env, message) => {
    expect(problems({ SITES_FILE: sitesFile, ...env })).toContainEqual(message)
  })
})

it('parseDurationMs', () => {
  expect([
    parseDurationMs('250ms'),
    parseDurationMs('30s'),
    parseDurationMs('5m'),
    parseDurationMs('1h'),
    parseDurationMs('2d'),
    parseDurationMs('0'),
  ]).toEqual([250, 30_000, 300_000, 3_600_000, 172_800_000, 0])
  expect(parseDurationMs('5 minutes')).toBeUndefined()
})
