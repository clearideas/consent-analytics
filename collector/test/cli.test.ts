// The standalone collector as a process: configured by environment variables, against real
// services (see ../server/test/support/services.ts), stopped with SIGTERM.
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as ddb from '@aws-sdk/client-dynamodb'
import * as sqs from '@aws-sdk/client-sqs'
import { MongoClient } from 'mongodb'
import mysql from 'mysql2/promise'
import pg from 'pg'
import { afterAll, describe, expect, inject, it, vi } from 'vitest'

const ORIGIN = 'https://www.example.com'
const dir = mkdtempSync(join(tmpdir(), 'ca-collector-cli-'))
const sitesFile = join(dir, 'sites.json')
writeFileSync(sitesFile, JSON.stringify([{ siteKey: 'my-site', allowedOrigins: [ORIGIN] }]))
const running: ChildProcess[] = []

afterAll(() => {
  for (const child of running) child.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

interface Started {
  url: string
  logs: string[]
  stop(): Promise<number | null>
}

/** Start the CLI; resolves once it logs "collector started". */
function start(env: Record<string, string>): Promise<Started> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.ts'], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      PATH: process.env.PATH,
      SITES_FILE: sitesFile,
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'info',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  running.push(child)
  const logs: string[] = []
  return new Promise((resolve, reject) => {
    const onLine = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        logs.push(line)
        try {
          const entry = JSON.parse(line)
          if (entry.msg === 'collector started') {
            resolve({
              url: entry.url,
              logs,
              stop: () =>
                new Promise(done => {
                  child.once('exit', code => done(code))
                  child.kill('SIGTERM')
                }),
            })
          }
        } catch {
          // not JSON
        }
      }
    }
    child.stdout!.on('data', onLine)
    child.stderr!.on('data', onLine)
    child.once('exit', code => reject(new Error(`collector exited (${code}):\n${logs.join('\n')}`)))
  })
}

/** Run the CLI to completion. */
function run(env: Record<string, string>, args: string[] = []) {
  return new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'src/cli.ts', ...args],
      {
        cwd: join(import.meta.dirname, '..'),
        env: { PATH: process.env.PATH, ...env },
      },
    )
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    child.once('exit', code => resolve({ code, output }))
  })
}

let seq = 0
const event = () => ({
  eventId: `event-${randomUUID().slice(0, 8)}-${++seq}`,
  name: 'page_view',
  occurredAt: new Date().toISOString(),
  sessionId: 'session-0000001',
  trackingCategory: 'full',
  consent: { required: false, granted: false },
  props: { path: '/pricing' },
})
const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'text/plain', 'cf-ipcountry': 'US' },
    body: JSON.stringify(body),
  })
const sendTraffic = async (url: string, count = 3) => {
  const events = Array.from({ length: count }, event)
  const response = await post(url, '/v1/events', {
    v: 1,
    siteKey: 'my-site',
    sentAt: new Date().toISOString(),
    events,
  })
  expect(response.status).toBe(202)
  const consent = await post(url, '/v1/consent', {
    v: 1,
    siteKey: 'my-site',
    consentId: `consent-${randomUUID().slice(0, 8)}`,
    decision: 'granted',
    policyVersion: '1',
    decidedAt: new Date().toISOString(),
    source: 'banner',
  })
  expect(consent.status).toBe(201)
  return events.map(e => e.eventId)
}

describe('configuration errors', () => {
  it('an invalid configuration exits 1 with every problem listed; --check validates', async () => {
    const invalid = await run({ STORE: 'oracle' })
    expect(invalid.code).toBe(1)
    expect(invalid.output).toContain('STORE must be one of')
    expect(invalid.output).toContain('Configure sites')
    const check = await run({ SITES_FILE: sitesFile }, ['--check'])
    expect(check).toEqual({ code: 0, output: expect.stringContaining('Configuration is valid') })
  })
})

describe('SQLite, one process', () => {
  it('serves the API, /readyz and /metrics; events survive a restart', async () => {
    const database = join(dir, 'cli.db')
    const first = await start({
      STORE: 'sqlite',
      DATABASE_PATH: database,
      TRUSTED_GEO_HEADERS: 'cf-ipcountry',
    })
    const ids = await sendTraffic(first.url)
    expect((await fetch(`${first.url}/readyz`)).status).toBe(200)
    const metrics = await (await fetch(`${first.url}/metrics`)).text()
    expect(metrics).toContain('consent_analytics_up 1')
    expect(metrics).toContain(
      'consent_analytics_delivery_buffered{endpoint="events",mode="direct"} 0',
    )
    const context: any = await (
      await fetch(`${first.url}/v1/context?siteKey=my-site`, { headers: { 'cf-ipcountry': 'DE' } })
    ).json()
    expect(context.policy).toMatchObject({ consentRequired: true, reason: 'region' })
    expect(await first.stop()).toBe(0)

    const { sqliteStore } = await import('@clearideas/consent-analytics-server/sqlite')
    const store = sqliteStore({ path: database })
    expect((await store.listEvents()).map(e => e.eventId).sort()).toEqual([...ids].sort())
    expect((await store.listEvents())[0]).toMatchObject({
      profile: 'open',
      server: { geo: { country: 'US' } },
    })
    expect(await store.listConsents()).toHaveLength(1)
    await store.close!()
  })
})

const mongoUrl = inject('mongodbUrl')
const redisUrl = inject('redisUrl')
describe.skipIf(!mongoUrl || !redisUrl)(
  'MongoDB + Redis Streams, API and worker in one process',
  () => {
    it('queued-fast events and direct consent records end up in MongoDB; sites can live in MongoDB', async () => {
      const database = `ca_cli_${process.pid}`
      const client = new MongoClient(mongoUrl)
      await client.connect()
      try {
        await client
          .db(database)
          .collection('analytics_sites')
          .insertOne({ siteKey: 'db-site', allowedOrigins: [ORIGIN] })
        const collector = await start({
          MODE: 'all',
          STORE: 'mongodb',
          MONGODB_URL: mongoUrl,
          MONGODB_DATABASE: database,
          SITES_MONGODB_COLLECTION: 'analytics_sites',
          QUEUE: 'redis',
          REDIS_URL: redisUrl,
          REDIS_STREAM: `{cli-${randomUUID()}}:ingest`,
          DELIVERY_EVENTS: 'queued-fast',
          DELIVERY_CONSENT: 'direct',
          RATE_LIMIT_PER_IP: '1000/1m',
        })
        const ids = await sendTraffic(collector.url)
        const fromDbSite = await post(collector.url, '/v1/events', {
          v: 1,
          siteKey: 'db-site',
          sentAt: new Date().toISOString(),
          events: [event()],
        })
        expect(fromDbSite.status).toBe(202)
        await vi.waitFor(
          async () =>
            expect(
              await client
                .db(database)
                .collection('analytics_events')
                .countDocuments({ siteKey: 'my-site' }),
            ).toBe(ids.length),
          { timeout: 20_000 },
        )
        expect(await client.db(database).collection('analytics_consents').countDocuments()).toBe(1)
        const indexes = await client.db(database).collection('analytics_events').indexes()
        expect(indexes.map(i => i.name)).toContain('retain_until') // created at start (AUTO_MIGRATE)
        expect(await collector.stop()).toBe(0)
      } finally {
        await client.db(database).dropDatabase()
        await client.close()
      }
    })
  },
)

const postgresUrl = inject('postgresUrl')
const awsEndpoint = inject('awsEndpoint')
describe.skipIf(!postgresUrl || !awsEndpoint)(
  'PostgreSQL + SQS, API and worker as separate processes',
  () => {
    it('the API queues events, the worker writes them; consent records go directly', async () => {
      const aws = {
        region: 'us-east-1',
        endpoint: awsEndpoint,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }
      const client = new sqs.SQSClient(aws)
      const { QueueUrl } = await client.send(
        new sqs.CreateQueueCommand({ QueueName: `ca-cli-${randomUUID()}` }),
      )
      const env = {
        STORE: 'postgres',
        POSTGRES_URL: postgresUrl,
        QUEUE: 'sqs',
        SQS_QUEUE_URL: QueueUrl!,
        AWS_REGION: 'us-east-1',
        AWS_ENDPOINT_URL: awsEndpoint,
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        DELIVERY_CONSENT: 'direct',
      }
      const api = await start({ ...env, MODE: 'api' })
      const worker = await start({ ...env, MODE: 'worker' })
      const pool = new pg.Pool({ connectionString: postgresUrl })
      try {
        expect((await fetch(`${worker.url}/healthz`)).status).toBe(200)
        expect((await fetch(`${worker.url}/v1/health`)).status).toBe(404) // no collector routes in a worker
        const ids = await sendTraffic(api.url)
        await vi.waitFor(
          async () => {
            const { rows } = await pool.query(
              'SELECT event_id FROM analytics_events WHERE event_id = ANY($1)',
              [ids],
            )
            expect(rows).toHaveLength(ids.length)
          },
          { timeout: 20_000 },
        )
        const metrics = await (await fetch(`${worker.url}/metrics`)).text()
        expect(metrics).toMatch(/consent_analytics_worker_written_total [1-9]/)
        expect(await api.stop()).toBe(0)
        expect(await worker.stop()).toBe(0)
      } finally {
        await pool.end()
      }
    })
  },
)

const mysqlUrl = inject('mysqlUrl')
describe.skipIf(!mysqlUrl)('MySQL', () => {
  it('direct delivery', async () => {
    const admin = await mysql.createConnection(mysqlUrl)
    await admin.query('CREATE DATABASE IF NOT EXISTS ca_cli')
    await admin.end()
    const url = mysqlUrl.replace(/\/mysql$/, '/ca_cli')
    const collector = await start({ STORE: 'mysql', MYSQL_URL: url })
    const ids = await sendTraffic(collector.url)
    expect(await collector.stop()).toBe(0)
    const pool = mysql.createPool({ uri: url })
    const [rows] = await pool.query('SELECT event_id FROM analytics_events')
    expect((rows as Array<{ event_id: string }>).map(r => r.event_id)).toEqual(
      expect.arrayContaining(ids),
    )
    await pool.end()
  })
})

describe.skipIf(!awsEndpoint)('DynamoDB', () => {
  it('creates its table and stores directly', async () => {
    const table = `ca-cli-${randomUUID()}`
    const collector = await start({
      STORE: 'dynamodb',
      DYNAMODB_TABLE: table,
      AWS_REGION: 'us-east-1',
      AWS_ENDPOINT_URL: awsEndpoint,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    })
    const ids = await sendTraffic(collector.url)
    expect(await collector.stop()).toBe(0)
    const client = new ddb.DynamoDBClient({
      region: 'us-east-1',
      endpoint: awsEndpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    })
    const { Items = [] } = await client.send(new ddb.ScanCommand({ TableName: table }))
    expect(Items.filter(item => item.kind?.S === 'event')).toHaveLength(ids.length)
  })
})
