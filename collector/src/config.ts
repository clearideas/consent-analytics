// Configuration from environment variables, validated all at once: a misconfigured deployment
// fails at start with every problem listed.
import { readFileSync } from 'node:fs'

import type { SiteInput } from '@clearideas/consent-analytics-server'

export type StoreKind = 'memory' | 'sqlite' | 'mongodb' | 'postgres' | 'mysql' | 'dynamodb'
export type QueueKind = 'none' | 'memory' | 'redis' | 'sqs'
export type DeliveryKind = 'direct' | 'buffered' | 'queued' | 'queued-fast'
export type Mode = 'api' | 'worker' | 'all'

export interface CollectorConfig {
  mode: Mode
  port: number
  host: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  store: StoreKind
  databasePath: string
  mongodbUrl?: string
  mongodbDatabase?: string
  postgresUrl?: string
  mysqlUrl?: string
  dynamodbTable?: string
  awsRegion?: string
  awsEndpoint?: string
  autoMigrate: boolean
  queue: QueueKind
  redisUrl?: string
  redisStream?: string
  sqsQueueUrl?: string
  sqsDeadLetterQueueUrl?: string
  delivery: { events: DeliveryKind; consent: DeliveryKind }
  sites: SiteInput[]
  sitesMongodbCollection?: string
  sitesCacheTtlMs: number
  dataPolicy: { preset: 'strict' | 'balanced' } | { file: string }
  consentCountries?: string[]
  noTrackingWithoutConsentCountries?: string[]
  usPrivacyStates?: string[]
  rulesPreset: 'standard' | 'strict' | 'off'
  hashSecret?: string
  trustedGeoHeaders: string[]
  ipinfoToken?: string
  defaultCountry?: string
  trustProxy: boolean | number | string[]
  rateLimitPerIp?: { limit: number; windowMs: number }
  rateLimitPerSite?: { limit: number; windowMs: number }
  contextTtlSeconds: number
  retentionIntervalMs: number
  workerConcurrency: number
  metrics: boolean
  shutdownTimeoutMs: number
}

export class ConfigError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

const DURATION = /^(\d+)(ms|s|m|h|d)$/
const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** "500ms", "30s", "5m", "1h", "2d" (or "0") to milliseconds. */
export function parseDurationMs(value: string): number | undefined {
  if (value === '0') return 0
  const match = DURATION.exec(value.trim())
  return match ? Number(match[1]) * UNITS[match[2] as keyof typeof UNITS] : undefined
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const problems: string[] = []
  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = (env[name]?.trim() || fallback).toLowerCase() as T
    if (!allowed.includes(value))
      problems.push(`${name} must be one of ${allowed.join(', ')} (got "${env[name]}")`)
    return value
  }
  const integer = (name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer from ${min} to ${max} (got "${raw}")`)
      return fallback
    }
    return value
  }
  const duration = (name: string, fallback: string) => {
    const raw = env[name]?.trim() || fallback
    const value = parseDurationMs(raw)
    if (value === undefined)
      problems.push(`${name} must be a duration like 30s, 5m or 1h (got "${raw}")`)
    return value ?? 0
  }
  const rate = (name: string) => {
    const raw = env[name]
    if (!raw) return undefined
    const [limit, window] = raw.split('/')
    const windowMs = window ? parseDurationMs(window) : undefined
    if (!limit || !/^\d+$/.test(limit) || !windowMs) {
      problems.push(`${name} must look like 600/1m (requests per window; got "${raw}")`)
      return undefined
    }
    return { limit: Number(limit), windowMs }
  }
  const bool = (name: string, fallback: boolean) => {
    const raw = env[name]?.trim().toLowerCase()
    if (raw === undefined || raw === '') return fallback
    if (['1', 'true', 'yes'].includes(raw)) return true
    if (['0', 'false', 'no'].includes(raw)) return false
    problems.push(`${name} must be true or false (got "${env[name]}")`)
    return fallback
  }

  const mode = oneOf('MODE', ['api', 'worker', 'all'] as const, 'api')
  const store = oneOf(
    'STORE',
    ['memory', 'sqlite', 'mongodb', 'postgres', 'mysql', 'dynamodb'] as const,
    'sqlite',
  )
  const queue = oneOf('QUEUE', ['none', 'memory', 'redis', 'sqs'] as const, 'none')
  const deliveryKinds = ['direct', 'buffered', 'queued', 'queued-fast'] as const
  const events = oneOf('DELIVERY_EVENTS', deliveryKinds, queue === 'none' ? 'direct' : 'queued')
  const consent = oneOf('DELIVERY_CONSENT', deliveryKinds, queue === 'none' ? 'direct' : 'queued')

  // Sites: a JSON file (array of site definitions) and/or a MongoDB collection.
  let sites: SiteInput[] = []
  if (env.SITES_FILE) {
    try {
      const parsed = JSON.parse(readFileSync(env.SITES_FILE, 'utf8'))
      if (!Array.isArray(parsed)) problems.push('SITES_FILE must contain a JSON array of sites')
      else sites = parsed
    } catch (error) {
      problems.push(`SITES_FILE could not be read: ${(error as Error).message}`)
    }
  }
  const sitesMongodbCollection = env.SITES_MONGODB_COLLECTION || undefined
  if (!env.SITES_FILE && !sitesMongodbCollection) {
    problems.push('Configure sites: SITES_FILE (JSON array) and/or SITES_MONGODB_COLLECTION')
  }

  const dataPolicyRaw = env.DATA_POLICY ?? 'balanced'
  const dataPolicy: CollectorConfig['dataPolicy'] =
    dataPolicyRaw === 'strict' || dataPolicyRaw === 'balanced'
      ? { preset: dataPolicyRaw }
      : { file: dataPolicyRaw }

  let trustProxy: boolean | number | string[] = false
  const trustRaw = env.TRUST_PROXY?.trim()
  if (trustRaw && !['false', '0'].includes(trustRaw)) {
    if (trustRaw === 'true') trustProxy = true
    else if (/^\d+$/.test(trustRaw)) trustProxy = Number(trustRaw)
    else trustProxy = list(trustRaw)
  }

  const defaultCountry = env.DEFAULT_COUNTRY?.trim().toUpperCase() || undefined
  if (defaultCountry && !/^[A-Z]{2}$/.test(defaultCountry))
    problems.push('DEFAULT_COUNTRY must be an ISO 3166-1 alpha-2 code')

  const config: CollectorConfig = {
    mode,
    port: integer('PORT', 8787, 0, 65_535),
    host: env.HOST || '0.0.0.0',
    logLevel: oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    store,
    databasePath: env.DATABASE_PATH || './data/analytics.db',
    mongodbUrl: env.MONGODB_URL || undefined,
    mongodbDatabase: env.MONGODB_DATABASE || undefined,
    postgresUrl: env.POSTGRES_URL || env.DATABASE_URL || undefined,
    mysqlUrl: env.MYSQL_URL || undefined,
    dynamodbTable: env.DYNAMODB_TABLE || undefined,
    awsRegion: env.AWS_REGION || undefined,
    awsEndpoint: env.AWS_ENDPOINT_URL || undefined,
    autoMigrate: bool('AUTO_MIGRATE', true),
    queue,
    redisUrl: env.REDIS_URL || undefined,
    redisStream: env.REDIS_STREAM || undefined,
    sqsQueueUrl: env.SQS_QUEUE_URL || undefined,
    sqsDeadLetterQueueUrl: env.SQS_DEAD_LETTER_QUEUE_URL || undefined,
    delivery: { events, consent },
    sites,
    sitesMongodbCollection,
    sitesCacheTtlMs: duration('SITES_CACHE_TTL', '60s'),
    dataPolicy,
    consentCountries: env.CONSENT_COUNTRIES ? list(env.CONSENT_COUNTRIES) : undefined,
    noTrackingWithoutConsentCountries: env.NO_TRACKING_WITHOUT_CONSENT_COUNTRIES
      ? list(env.NO_TRACKING_WITHOUT_CONSENT_COUNTRIES)
      : undefined,
    usPrivacyStates: env.US_PRIVACY_STATES ? list(env.US_PRIVACY_STATES) : undefined,
    rulesPreset: oneOf('RULES_PRESET', ['standard', 'strict', 'off'] as const, 'standard'),
    hashSecret: env.HASH_SECRET || undefined,
    trustedGeoHeaders: list(env.TRUSTED_GEO_HEADERS).map(h => h.toLowerCase()),
    ipinfoToken: env.IPINFO_TOKEN || undefined,
    defaultCountry,
    trustProxy,
    rateLimitPerIp: rate('RATE_LIMIT_PER_IP'),
    rateLimitPerSite: rate('RATE_LIMIT_PER_SITE'),
    contextTtlSeconds: integer('CONTEXT_TTL_SECONDS', 3600, 0, 86_400),
    retentionIntervalMs: duration('RETENTION_INTERVAL', '1h'),
    workerConcurrency: integer('WORKER_CONCURRENCY', 1, 1, 64),
    metrics: bool('METRICS', true),
    shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 10_000, 0, 600_000),
  }

  // Combinations.
  const needs = (condition: boolean, message: string) => condition || problems.push(message)
  needs(store !== 'mongodb' || !!config.mongodbUrl, 'STORE=mongodb needs MONGODB_URL')
  needs(
    store !== 'postgres' || !!config.postgresUrl,
    'STORE=postgres needs POSTGRES_URL (or DATABASE_URL)',
  )
  needs(store !== 'mysql' || !!config.mysqlUrl, 'STORE=mysql needs MYSQL_URL')
  needs(store !== 'dynamodb' || !!config.dynamodbTable, 'STORE=dynamodb needs DYNAMODB_TABLE')
  needs(queue !== 'redis' || !!config.redisUrl, 'QUEUE=redis needs REDIS_URL')
  needs(queue !== 'sqs' || !!config.sqsQueueUrl, 'QUEUE=sqs needs SQS_QUEUE_URL')
  needs(
    !sitesMongodbCollection || !!config.mongodbUrl,
    'SITES_MONGODB_COLLECTION needs MONGODB_URL',
  )
  needs(
    queue !== 'memory' || mode === 'all',
    'QUEUE=memory only works with MODE=all (API and worker in one process)',
  )
  needs(mode === 'api' || queue !== 'none', `MODE=${mode} needs a QUEUE to work from`)
  const queued = [events, consent].some(kind => kind.startsWith('queued'))
  needs(
    !queued || queue !== 'none',
    'Queued delivery (DELIVERY_EVENTS/DELIVERY_CONSENT) needs a QUEUE',
  )
  needs(
    store !== 'memory' || mode === 'all' || !queued,
    'STORE=memory with a separate worker process cannot share data',
  )
  needs(
    !config.hashSecret || config.hashSecret.length >= 16,
    'HASH_SECRET must be at least 16 characters',
  )

  if (problems.length) throw new ConfigError(problems)
  return config
}
