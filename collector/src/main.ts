// The standalone collector: builds a collector, worker and retention job from the
// configuration, with the drivers it needs (loaded only when used).
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import type {
  Cache,
  CollectorStore,
  DataPolicyDocument,
  DeliveryOptions,
  GeoResolver,
  IngestQueue,
  Lock,
  Logger,
  RateLimiter,
  SiteSource,
  Worker,
} from '@clearideas/consent-analytics-server'
import {
  balancedDataPolicy,
  cachedSites,
  chainGeo,
  compileDataPolicy,
  consoleLogger,
  createCollector,
  fixedGeo,
  memoryQueue,
  memoryRateLimiter,
  memoryStore,
  runWorker,
  startRetention,
  staticSites,
  strictDataPolicy,
  trustedHeaderGeo,
} from '@clearideas/consent-analytics-server'
import { createCollectorServer } from '@clearideas/consent-analytics-server/node'
import type { RedisLike } from '@clearideas/consent-analytics-server/redis'
import type { Db } from 'mongodb'

import type { CollectorConfig, DeliveryKind } from './config.ts'

export type { CollectorConfig } from './config.ts'
export { ConfigError, loadConfig } from './config.ts'

export interface RunningCollector {
  /** Base URL of the HTTP server. */
  url: string
  stop(): Promise<void>
}

export async function startCollector(
  config: CollectorConfig,
  logger: Logger = consoleLogger(config.logLevel),
): Promise<RunningCollector> {
  // On stop: first the worker and retention job, then HTTP (which flushes buffers and closes
  // the store), then queues and clients (in reverse order of creation).
  const stopFirst: Array<() => Promise<unknown>> = []
  const closers: Array<() => Promise<unknown>> = []
  const health: Array<() => Promise<unknown>> = []

  // --- clients (only what the configuration uses) ----------------------------------------
  let mongoDb: Db | undefined
  if (config.mongodbUrl && (config.store === 'mongodb' || config.sitesMongodbCollection)) {
    const { MongoClient } = await import('mongodb')
    const client = new MongoClient(config.mongodbUrl)
    await client.connect()
    closers.push(() => client.close())
    mongoDb = client.db(config.mongodbDatabase)
  }
  let redis: RedisLike | undefined
  if (config.redisUrl) {
    const { createClient } = await import('@redis/client')
    const { fromNodeRedis } = await import('@clearideas/consent-analytics-server/redis')
    const client = createClient({ url: config.redisUrl })
    client.on('error', error =>
      logger.error({ err: { message: (error as Error).message } }, 'redis connection error'),
    )
    await client.connect()
    closers.push(() => client.quit())
    redis = fromNodeRedis(client)
    health.push(() => client.ping())
  }
  const awsConfig = {
    ...(config.awsRegion ? { region: config.awsRegion } : {}),
    ...(config.awsEndpoint ? { endpoint: config.awsEndpoint } : {}),
  }

  // --- store ------------------------------------------------------------------------------
  let store: CollectorStore
  switch (config.store) {
    case 'memory':
      store = memoryStore()
      break
    case 'sqlite': {
      const { sqliteStore } = await import('@clearideas/consent-analytics-server/sqlite')
      store = sqliteStore({ path: config.databasePath })
      break
    }
    case 'mongodb': {
      const { ensureMongoIndexes, mongoStore } =
        await import('@clearideas/consent-analytics-server/mongodb')
      const mongo = mongoStore({ db: mongoDb! })
      if (config.autoMigrate) await ensureMongoIndexes(mongo)
      store = mongo
      break
    }
    case 'postgres': {
      const pg = (await import('pg')).default
      const { migratePostgres, postgresStore } =
        await import('@clearideas/consent-analytics-server/postgres')
      const pool = new pg.Pool({ connectionString: config.postgresUrl })
      closers.push(() => pool.end())
      if (config.autoMigrate) await migratePostgres(pool)
      store = postgresStore({ db: pool })
      break
    }
    case 'mysql': {
      const mysql = await import('mysql2/promise')
      const { migrateMysql, mysqlStore } =
        await import('@clearideas/consent-analytics-server/mysql')
      const pool = mysql.createPool({ uri: config.mysqlUrl!, connectionLimit: 10 })
      closers.push(() => pool.end())
      if (config.autoMigrate) await migrateMysql(pool)
      store = mysqlStore({ db: pool })
      break
    }
    case 'dynamodb': {
      const ddb = await import('@aws-sdk/client-dynamodb')
      const lib = await import('@aws-sdk/lib-dynamodb')
      const { createDynamoTable, dynamoStore } =
        await import('@clearideas/consent-analytics-server/dynamodb')
      const base = new ddb.DynamoDBClient(awsConfig)
      closers.push(async () => base.destroy())
      if (config.autoMigrate) {
        try {
          await base.send(new ddb.DescribeTableCommand({ TableName: config.dynamodbTable }))
        } catch (error) {
          if ((error as Error).name !== 'ResourceNotFoundException') throw error
          await createDynamoTable({ client: base, commands: ddb, table: config.dynamodbTable! })
        }
      }
      store = dynamoStore({
        client: lib.DynamoDBDocumentClient.from(base),
        commands: lib,
        table: config.dynamodbTable!,
      })
      break
    }
  }
  if (store.health) health.push(() => store.health!())

  // --- queue ------------------------------------------------------------------------------
  let queue: IngestQueue | undefined
  if (config.queue === 'memory') queue = memoryQueue()
  if (config.queue === 'redis') {
    const { redisStreamQueue } = await import('@clearideas/consent-analytics-server/redis')
    queue = redisStreamQueue(redis!, config.redisStream ? { stream: config.redisStream } : {})
  }
  if (config.queue === 'sqs') {
    const sqs = await import('@aws-sdk/client-sqs')
    const { sqsQueue } = await import('@clearideas/consent-analytics-server/sqs')
    const client = new sqs.SQSClient(awsConfig)
    closers.push(async () => client.destroy())
    queue = sqsQueue({
      client,
      commands: sqs,
      queueUrl: config.sqsQueueUrl!,
      deadLetterQueueUrl: config.sqsDeadLetterQueueUrl,
    })
  }
  if (queue?.close) closers.push(() => queue!.close!())

  // --- shared caches, locks, limits ---------------------------------------------------------
  let sharedCache: Cache | undefined
  let lock: Lock | undefined
  let rateLimiter: RateLimiter = memoryRateLimiter()
  if (redis) {
    const { redisCache, redisLock, redisRateLimiter } =
      await import('@clearideas/consent-analytics-server/redis')
    sharedCache = redisCache(redis)
    lock = redisLock(redis)
    rateLimiter = redisRateLimiter(redis, {
      fallback: memoryRateLimiter(),
      onError: error =>
        logger.warn(
          { err: { message: (error as Error).message } },
          'redis rate limiter failed; per-instance limits',
        ),
    })
  }

  // --- data policy ------------------------------------------------------------------------
  const presetOptions = {
    ...(config.consentCountries ? { consentCountries: config.consentCountries } : {}),
    ...(config.noTrackingWithoutConsentCountries
      ? { noTrackingWithoutConsentCountries: config.noTrackingWithoutConsentCountries }
      : {}),
  }
  const dataPolicy = compileDataPolicy(
    'file' in config.dataPolicy
      ? (JSON.parse(readFileSync(config.dataPolicy.file, 'utf8')) as DataPolicyDocument)
      : config.dataPolicy.preset === 'strict'
        ? strictDataPolicy(presetOptions)
        : balancedDataPolicy({
            ...presetOptions,
            ...(config.usPrivacyStates ? { usPrivacyStates: config.usPrivacyStates } : {}),
          }),
  )

  // --- worker and retention -----------------------------------------------------------------
  let worker: Worker | undefined
  if (config.mode !== 'api' && queue) {
    worker = runWorker({ queue, store, concurrency: config.workerConcurrency, logger })
    stopFirst.push(() => worker!.stop())
  }
  const runsRetention =
    config.retentionIntervalMs > 0 && store.purge && (config.mode !== 'api' || !queue)
  if (runsRetention) {
    const retention = startRetention({
      store,
      dataPolicy,
      everyMs: config.retentionIntervalMs,
      logger,
      ...(lock ? { lock } : {}),
    })
    stopFirst.push(() => retention.stop())
  }

  // --- HTTP -------------------------------------------------------------------------------
  const readyz = async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      await Promise.all(health.map(check => check()))
      res
        .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end('{"status":"ready"}')
    } catch (error) {
      res
        .writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ status: 'not ready', error: (error as Error).message }))
    }
  }
  let collectorStats: (() => ReturnType<ReturnType<typeof createCollector>['stats']>) | undefined
  const metrics = (_req: IncomingMessage, res: ServerResponse) => {
    res
      .writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' })
      .end(prometheus({ collector: collectorStats?.(), worker: worker?.stats() }))
  }
  const routes: Record<
    string,
    (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  > = {
    // Liveness in every mode (container health checks).
    '/healthz': (_req, res) => void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'),
    '/readyz': readyz,
    ...(config.metrics ? { '/metrics': metrics } : {}),
  }

  let url: string
  let stopHttp: () => Promise<void>
  if (config.mode === 'worker') {
    // A worker has no collector routes: just health and metrics.
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://worker.invalid').pathname
      const route = routes[path]
      if (route) void route(req, res)
      else res.writeHead(404).end()
    })
    await new Promise<void>(resolve => server.listen(config.port, config.host, resolve))
    const address = server.address() as AddressInfo
    url = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`
    stopHttp = () => new Promise<void>(resolve => server.close(() => resolve()))
  } else {
    const sites: SiteSource[] = []
    if (config.sites.length) sites.push(staticSites(config.sites))
    if (config.sitesMongodbCollection) {
      const { mongoSites } = await import('@clearideas/consent-analytics-server/mongodb')
      sites.push(mongoSites({ db: mongoDb!, collection: config.sitesMongodbCollection, logger }))
    }
    const { chainSites } = await import('@clearideas/consent-analytics-server')
    const siteSource = cachedSites(sites.length === 1 ? sites[0]! : chainSites(...sites), {
      ttlMs: config.sitesCacheTtlMs,
      ...(sharedCache ? { shared: sharedCache } : {}),
    })

    const resolvers: GeoResolver[] = []
    if (config.trustedGeoHeaders.length) {
      resolvers.push(
        trustedHeaderGeo(config.trustedGeoHeaders, {
          // e.g. cf-ipcontinent: read as the continent, never as a country
          continentHeaders: config.trustedGeoHeaders.filter(h => h.includes('continent')),
        }),
      )
    }
    if (config.ipinfoToken) {
      const { ipinfoGeo } = await import('@clearideas/consent-analytics-server/ipinfo')
      resolvers.push(
        ipinfoGeo({
          token: config.ipinfoToken,
          logger,
          ...(sharedCache
            ? {
                cache: sharedCache,
                ...(config.hashSecret ? { cacheKeySecret: config.hashSecret } : {}),
              }
            : {}),
        }),
      )
    }
    if (config.defaultCountry) resolvers.push(fixedGeo({ country: config.defaultCountry }))

    const delivery = (kind: DeliveryKind): DeliveryOptions =>
      kind === 'direct' || kind === 'buffered'
        ? { mode: kind }
        : { mode: 'queued', queue: queue!, ack: kind === 'queued-fast' ? 'fast' : 'durable' }
    const collector = createCollector({
      sites: siteSource,
      store,
      delivery: {
        events: delivery(config.delivery.events),
        consent: delivery(config.delivery.consent),
      },
      ...(resolvers.length ? { geo: chainGeo(...resolvers) } : {}),
      dataPolicy,
      rules: { preset: config.rulesPreset },
      ...(config.hashSecret ? { hashSecret: config.hashSecret } : {}),
      contextTtlSeconds: config.contextTtlSeconds,
      ...(config.rateLimitPerIp || config.rateLimitPerSite
        ? {
            rateLimit: {
              limiter: rateLimiter,
              ...(config.rateLimitPerIp ? { perIp: config.rateLimitPerIp } : {}),
              ...(config.rateLimitPerSite ? { perSite: config.rateLimitPerSite } : {}),
            },
          }
        : {}),
      flushTimeoutMs: config.shutdownTimeoutMs,
      logger,
    })
    collectorStats = () => collector.stats()
    const server = createCollectorServer(collector, {
      port: config.port,
      host: config.host,
      trustProxy: config.trustProxy,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      routes,
    })
    ;({ url } = await server.listen())
    // Closing the server drains requests, flushes buffers and closes the store.
    stopHttp = () => server.close()
  }

  logger.info(
    { url, mode: config.mode, store: config.store, queue: config.queue, delivery: config.delivery },
    'collector started',
  )

  let stopping: Promise<void> | undefined
  return {
    url,
    stop() {
      stopping ??= (async () => {
        await Promise.all(stopFirst.map(stop => stop()))
        await stopHttp()
        for (const close of closers.reverse()) {
          try {
            await close()
          } catch (error) {
            logger.warn({ err: { message: (error as Error).message } }, 'error while shutting down')
          }
        }
        if (config.mode === 'worker') await store.close?.()
        logger.info({}, 'collector stopped')
      })()
      return stopping
    },
  }
}

/** Prometheus text exposition of delivery and worker statistics. */
export function prometheus(stats: {
  collector?: ReturnType<ReturnType<typeof createCollector>['stats']>
  worker?: ReturnType<Worker['stats']>
}): string {
  const lines: string[] = []
  const metric = (
    name: string,
    type: 'gauge' | 'counter',
    help: string,
    samples: Array<[Record<string, string>, number]>,
  ) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
    for (const [labels, value] of samples) {
      const text = Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',')
      lines.push(`${name}${text ? `{${text}}` : ''} ${value}`)
    }
  }
  metric('consent_analytics_up', 'gauge', 'The collector process is running.', [[{}, 1]])
  if (stats.collector) {
    const endpoints = Object.entries(stats.collector) as unknown as Array<
      [string, Record<string, unknown>]
    >
    const sample = (field: string) =>
      endpoints.map(
        ([endpoint, s]) =>
          [{ endpoint, mode: String(s.mode) }, Number(s[field] ?? 0)] as [
            Record<string, string>,
            number,
          ],
      )
    metric(
      'consent_analytics_delivery_buffered',
      'gauge',
      'Messages waiting in the in-process buffer.',
      sample('buffered'),
    )
    metric(
      'consent_analytics_delivery_written_total',
      'counter',
      'Messages written from the buffer.',
      sample('written'),
    )
    metric(
      'consent_analytics_delivery_failed_flushes_total',
      'counter',
      'Buffer writes that failed and were retried.',
      sample('failedFlushes'),
    )
    metric(
      'consent_analytics_delivery_lost_total',
      'counter',
      'Buffered messages given up on.',
      sample('lost'),
    )
  }
  if (stats.worker) {
    for (const [field, help] of [
      ['received', 'Messages received from the queue.'],
      ['written', 'Messages written to the store.'],
      ['retried', 'Messages scheduled for a retry.'],
      ['deadLettered', 'Messages dead-lettered.'],
    ] as const) {
      const name = `consent_analytics_worker_${field.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}_total`
      metric(name, 'counter', help, [[{}, stats.worker[field]]])
    }
  }
  return `${lines.join('\n')}\n`
}
