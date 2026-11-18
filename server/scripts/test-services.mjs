#!/usr/bin/env node
// Fetch local binaries for the adapter tests (no Docker, no root), into server/.cache/services:
//   node scripts/test-services.mjs [redis] [postgres] [mysql] [moto]     (default: all)
//
// - redis, postgres, mysql: Ubuntu 24.04 packages (apt-get download + dpkg -x). Other systems:
//   install the servers yourself, or set REDIS_URL / POSTGRES_URL / MYSQL_URL.
// - moto (SQS and DynamoDB emulator): a Python virtualenv with moto[server].
// - MongoDB: not in the Ubuntu archive. Extract the official tarball next to the repository or
//   set MONGOD_BIN / MONGODB_URL.
// test/support/services.ts finds what this script installed. CI uses containers instead.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'services')
const apt = join(root, 'apt')
const extracted = join(root, 'root')

const PACKAGES = {
  redis: ['redis-server', 'redis-tools', 'liblzf1', 'libjemalloc2'],
  postgres: ['postgresql-16', 'postgresql-client-16', 'libpq5', 'libllvm17t64'],
  mysql: [
    'mysql-server-core-8.0',
    'libaio1t64',
    'libmecab2',
    'libevent-core-2.1-7t64',
    'libevent-pthreads-2.1-7t64',
    'libprotobuf-lite32t64',
    'libicu74',
  ],
}
const MOTO = 'moto[server]==5.2.5'

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...options })
const aptOptions = [
  '-o', `Dir::State::Lists=${join(apt, 'lists')}`,
  '-o', `Dir::Cache=${join(apt, 'cache')}`,
  '-o', 'Debug::NoLocking=1',
]

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['redis', 'postgres', 'mysql', 'moto']
const debs = wanted.filter(name => name in PACKAGES)
if (debs.length) {
  mkdirSync(join(apt, 'lists', 'partial'), { recursive: true })
  mkdirSync(join(apt, 'cache', 'archives', 'partial'), { recursive: true })
  mkdirSync(extracted, { recursive: true })
  run('apt-get', [...aptOptions, 'update'], { stdio: 'ignore' })
  const downloads = join(apt, 'debs')
  mkdirSync(downloads, { recursive: true })
  run('apt-get', [...aptOptions, 'download', ...debs.flatMap(name => PACKAGES[name])], { cwd: downloads })
  for (const file of readdirSync(downloads).filter(f => f.endsWith('.deb'))) {
    run('dpkg', ['-x', join(downloads, file), extracted])
  }
}
if (wanted.includes('moto')) {
  const venv = join(root, 'moto')
  run('python3', ['-m', 'venv', venv])
  run(join(venv, 'bin', 'pip'), ['install', '--quiet', MOTO])
}
console.log(`Installed ${wanted.join(', ')} into ${root}`)
