// Vitest global setup: real services for adapter tests, started in parallel.
//
// Each service uses its TEST_* URL if set (CI: service containers), otherwise a local binary:
//   MongoDB   TEST_MONGODB_URL   | mongod: MONGOD_BIN, PATH, or an extracted tarball next to the repo
//   Redis     TEST_REDIS_URL     | redis-server: REDIS_SERVER_BIN, PATH, or .cache/services
//   Postgres  TEST_POSTGRES_URL  | initdb + postgres: PG_BIN_DIR, .cache/services, or PATH
//   MySQL     TEST_MYSQL_URL     | mysqld: MYSQLD_BIN, .cache/services, or PATH
//   SQS/DynamoDB  TEST_AWS_ENDPOINT_URL | moto_server: MOTO_SERVER_BIN, PATH, or .cache/services
// The variables are TEST_-prefixed on purpose: the tests create and drop databases, so they
// must never pick up the MONGODB_URL (etc.) of an application's own environment.
// `node scripts/test-services.mjs` installs the local ones (Linux x64; MongoDB excluded).
// SERVICES=none (or e.g. SERVICES=redis,mongodb) starts fewer, for quicker local runs.
// A service that is missing, unreachable or fails to start skips its tests (with a warning),
// unless REQUIRE_SERVICES=1 (CI), which makes it an error.
import type { ChildProcess } from 'node:child_process'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    /** '' when the service is not available. */
    mongodbUrl: string
    /** True when the TTL monitor runs every second (a local mongod started here). */
    mongodbFastTtl: boolean
    redisUrl: string
    postgresUrl: string
    mysqlUrl: string
    /** moto (SQS, DynamoDB) endpoint. */
    awsEndpoint: string
  }
}

const serverDir = resolve(import.meta.dirname, '..', '..')
const cache = join(serverDir, '.cache', 'services')
const extracted = join(cache, 'root')
const libraryPath = [join(extracted, 'usr', 'lib', 'x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH]
  .filter(Boolean)
  .join(':')

/** An executable on PATH (no `which`: it doesn't exist everywhere). */
const onPath = (name: string) => {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name]
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const file of names) if (existsSync(join(dir, file))) return join(dir, file)
  }
  return undefined
}
const firstExisting = (...candidates: Array<string | undefined>) =>
  candidates.find(c => c && existsSync(c))

function findMongod() {
  const nextToRepo = resolve(serverDir, '..', '..')
  const tarballs = existsSync(nextToRepo)
    ? readdirSync(nextToRepo)
        .filter(dir => dir.startsWith('mongodb-'))
        .map(dir => join(nextToRepo, dir, 'bin', 'mongod'))
    : []
  return firstExisting(process.env.MONGOD_BIN, onPath('mongod'), ...tarballs)
}

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => done(port))
    })
  })

const canConnect = (port: number, host = '127.0.0.1', timeoutMs = 2_000) =>
  new Promise<boolean>(done => {
    const socket = createConnection({ host, port })
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      done(false)
    })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => done(false))
  })

const DEFAULT_PORTS: Record<string, number> = {
  'mongodb:': 27017,
  'redis:': 6379,
  'postgres:': 5432,
  'postgresql:': 5432,
  'mysql:': 3306,
  'http:': 80,
  'https:': 443,
}

/** A configured service URL, if its host answers (a stopped container should skip, not hang). */
async function configured(variable: string): Promise<string | undefined> {
  const value = process.env[variable]
  if (!value) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${variable} is not a URL`)
  }
  // mongodb+srv and the like resolve through DNS: trust them as given.
  const port = Number(url.port) || DEFAULT_PORTS[url.protocol]
  if (port && !(await canConnect(port, url.hostname.replace(/^\[|\]$/g, '')))) {
    throw new Error(`${variable} (${url.host}) does not answer`)
  }
  return value
}

const children: ChildProcess[] = []
const temporary: string[] = []

async function start(
  name: string,
  binary: string,
  args: string[],
  port: number,
  timeoutMs = 60_000,
) {
  const child = spawn(binary, args, {
    stdio: 'ignore',
    env: { ...process.env, LD_LIBRARY_PATH: libraryPath },
  })
  children.push(child)
  let spawnError: Error | undefined
  child.once('error', error => (spawnError = error))
  const deadline = Date.now() + timeoutMs
  while (!(await canConnect(port))) {
    if (spawnError || Date.now() > deadline || child.exitCode !== null) {
      child.kill('SIGKILL')
      throw new Error(
        `${name} did not start (${binary}${spawnError ? `: ${spawnError.message}` : child.exitCode !== null ? `: exit code ${child.exitCode}` : ''})`,
      )
    }
    await new Promise(r => setTimeout(r, 200))
  }
}

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

// --- services ---------------------------------------------------------------------------

async function mongodb(project: TestProject) {
  const url = await configured('TEST_MONGODB_URL')
  if (url) {
    project.provide('mongodbUrl', url)
    project.provide('mongodbFastTtl', false)
    return true
  }
  const binary = findMongod()
  if (!binary) return false
  const port = await freePort()
  await start(
    'mongod',
    binary,
    [
      '--dbpath',
      tempDir('ca-mongod-'),
      '--port',
      String(port),
      '--bind_ip',
      '127.0.0.1',
      '--nounixsocket',
      '--quiet',
      '--setParameter',
      'ttlMonitorSleepSecs=1',
    ],
    port,
  )
  project.provide('mongodbUrl', `mongodb://127.0.0.1:${port}`)
  project.provide('mongodbFastTtl', true)
  return true
}

async function redis(project: TestProject) {
  const url = await configured('TEST_REDIS_URL')
  if (url) return (project.provide('redisUrl', url), true)
  const binary = firstExisting(
    process.env.REDIS_SERVER_BIN,
    onPath('redis-server'),
    join(extracted, 'usr', 'bin', 'redis-server'),
  )
  if (!binary) return false
  const port = await freePort()
  await start(
    'redis-server',
    binary,
    [
      '--port',
      String(port),
      '--bind',
      '127.0.0.1',
      '--save',
      '',
      '--appendonly',
      'no',
      '--dir',
      tempDir('ca-redis-'),
    ],
    port,
  )
  project.provide('redisUrl', `redis://127.0.0.1:${port}`)
  return true
}

async function postgres(project: TestProject) {
  const url = await configured('TEST_POSTGRES_URL')
  if (url) return (project.provide('postgresUrl', url), true)
  const initdb = onPath('initdb')
  const bin = firstExisting(
    process.env.PG_BIN_DIR,
    join(extracted, 'usr', 'lib', 'postgresql', '16', 'bin'),
    initdb && dirname(initdb),
  )
  if (!bin) return false
  const data = tempDir('ca-postgres-')
  execFileSync(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-sync'], {
    stdio: 'ignore',
    env: { ...process.env, LD_LIBRARY_PATH: libraryPath },
  })
  const port = await freePort()
  await start(
    'postgres',
    join(bin, 'postgres'),
    [
      '-D',
      data,
      '-p',
      String(port),
      '-k',
      data,
      '-c',
      'listen_addresses=127.0.0.1',
      '-c',
      'fsync=off',
    ],
    port,
  )
  project.provide('postgresUrl', `postgres://postgres@127.0.0.1:${port}/postgres`)
  return true
}

async function mysql(project: TestProject) {
  const url = await configured('TEST_MYSQL_URL')
  if (url) return (project.provide('mysqlUrl', url), true)
  const local = join(extracted, 'usr', 'sbin', 'mysqld')
  const binary = firstExisting(process.env.MYSQLD_BIN, local, onPath('mysqld'))
  if (!binary) return false
  // The extracted package needs its directories spelled out; installed servers know theirs.
  const base =
    binary === local
      ? [
          `--basedir=${join(extracted, 'usr')}`,
          `--lc-messages-dir=${join(extracted, 'usr', 'share', 'mysql')}`,
        ]
      : []
  // Initializing a data directory is slow: do it once per binary, then copy it for every run.
  const template = join(cache, binary === local ? 'mysql-template' : 'mysql-template-path')
  if (!existsSync(join(template, 'mysql'))) {
    rmSync(template, { recursive: true, force: true })
    mkdirSync(template, { recursive: true })
    execFileSync(
      binary,
      ['--no-defaults', '--initialize-insecure', `--datadir=${template}`, ...base],
      {
        stdio: 'ignore',
        env: { ...process.env, LD_LIBRARY_PATH: libraryPath },
      },
    )
  }
  const data = tempDir('ca-mysql-')
  cpSync(template, data, { recursive: true })
  const port = await freePort()
  await start(
    'mysqld',
    binary,
    [
      '--no-defaults',
      `--datadir=${data}`,
      ...base,
      `--port=${port}`,
      '--bind-address=127.0.0.1',
      `--socket=${join(data, 'mysql.sock')}`,
      '--mysqlx=OFF',
      '--secure-file-priv=',
      `--pid-file=${join(data, 'mysqld.pid')}`,
      '--skip-log-bin',
      '--innodb-flush-log-at-trx-commit=0',
      '--performance-schema=OFF',
    ],
    port,
  )
  project.provide('mysqlUrl', `mysql://root@127.0.0.1:${port}/mysql`)
  return true
}

async function moto(project: TestProject) {
  const url = await configured('TEST_AWS_ENDPOINT_URL')
  if (url) return (project.provide('awsEndpoint', url), true)
  const binary = firstExisting(
    process.env.MOTO_SERVER_BIN,
    onPath('moto_server'),
    join(cache, 'moto', 'bin', 'moto_server'),
  )
  if (!binary) return false
  const port = await freePort()
  await start('moto_server', binary, ['-H', '127.0.0.1', '-p', String(port)], port)
  project.provide('awsEndpoint', `http://127.0.0.1:${port}`)
  return true
}

export default async function setup(project: TestProject) {
  const required = process.env.REQUIRE_SERVICES === '1'
  const defaults = {
    mongodbUrl: '',
    mongodbFastTtl: false,
    redisUrl: '',
    postgresUrl: '',
    mysqlUrl: '',
    awsEndpoint: '',
  } as const
  for (const [key, value] of Object.entries(defaults))
    project.provide(key as keyof typeof defaults, value as never)

  const all = { mongodb, redis, postgres, mysql, moto }
  // SERVICES=none, or a comma-separated subset (e.g. "redis,mongodb"), for quicker local runs.
  const selected = (process.env.SERVICES ?? 'all').split(',').map(name => name.trim().toLowerCase())
  const services = Object.fromEntries(
    Object.entries(all).filter(([name]) => selected.includes('all') || selected.includes(name)),
  )
  const results = await Promise.allSettled(Object.values(services).map(service => service(project)))
  const missing: string[] = []
  Object.keys(services).forEach((name, index) => {
    const result = results[index]!
    if (result.status === 'fulfilled' && result.value) return
    const reason = result.status === 'rejected' ? (result.reason as Error).message : 'not installed'
    missing.push(`${name} (${reason})`)
  })
  if (missing.length) {
    if (required) {
      await stopAll()
      throw new Error(`REQUIRE_SERVICES=1 but not available: ${missing.join(', ')}`)
    }
    console.warn(
      `[services] Tests skipped for: ${missing.join(', ')}. See CONTRIBUTING.md (Real services).`,
    )
  }

  return stopAll
}

async function stopAll() {
  await Promise.all(
    children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return undefined
      const exited = new Promise(done => child.once('exit', done))
      child.kill('SIGTERM')
      return Promise.race([exited, new Promise(done => setTimeout(done, 10_000))])
    }),
  )
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
}
