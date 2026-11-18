#!/usr/bin/env node
// Checks the package as it would be published (npm pack), not the source tree:
//  1. The manifest declares no dependencies of any kind (the zero-dependency promise).
//  2. Only dist/, schemas/, README, LICENSE, THIRD_PARTY_NOTICES and package.json are packed; no tests,
//     no credentials.
//  3. Every import in dist/ is relative or a `node:` built-in.
//  4. Installing the tarball into an empty project, offline, adds exactly one package.
//  5. The installed package works: ESM import, require() (Node >= 22.12), validation, and a
//     collector answering through the fetch and node:http transports.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (args, cwd) => execFileSync(npm, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const field of [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
]) {
  const value = manifest[field]
  assert(
    value === undefined || (Array.isArray(value) ? value : Object.keys(value)).length === 0,
    `package.json must not declare ${field}: the server library has no dependencies`,
  )
}

const scratch = mkdtempSync(join(tmpdir(), 'ca-server-pack-'))
try {
  const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', scratch], root))
  const files = packed.files.map(file => file.path)
  const allowed =
    /^(?:dist\/.+\.(?:js|d\.ts|js\.map)|schemas\/[\w-]+\.schema\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md|package\.json)$/
  for (const file of files) {
    assert(allowed.test(file), `Unexpected packed file: ${file}`)
    assert(!/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./.test(file), `Test file packed: ${file}`)
  }
  for (const entry of [
    'dist/index.js',
    'dist/index.d.ts',
    'schemas/data-policy.schema.json',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ]) {
    assert(files.includes(entry), `Missing packed file: ${entry}`)
  }

  const credentialPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b/,
    /\bnpm_[A-Za-z0-9]{30,100}\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\bsk-(?:proj-|ant-api\d\d-)?[A-Za-z0-9_-]{35,250}\b/,
  ]
  for (const file of files) {
    const content = readFileSync(join(root, file), 'utf8')
    assert(!credentialPatterns.some(p => p.test(content)), `Credential-shaped content in ${file}`)
    if (file.endsWith('.js')) {
      // Static, side-effect and dynamic imports, and require() (TypeScript's scanner: comments
      // are ignored): only relative paths and node: built-ins.
      const specifiers = ts.preProcessFile(content, true, true).importedFiles.map(file => file.fileName)
      for (const specifier of specifiers) {
        assert(
          specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:'),
          `${file} imports "${specifier}": only relative and node: imports are allowed`,
        )
      }
    }
  }

  // Install into an empty project, offline: anything beyond this one package would fail.
  const project = join(scratch, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  run(['install', '--offline', '--no-audit', '--no-fund', join(scratch, packed.filename)], project)
  const tree = JSON.parse(run(['ls', '--all', '--omit=dev', '--json'], project))
  const installed = []
  const walk = deps => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      installed.push(name)
      walk(info.dependencies)
    }
  }
  walk(tree.dependencies)
  assert.deepEqual(installed, [manifest.name], `Installing must add exactly one package, got: ${installed.join(', ')}`)

  const smoke = `
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    const esm = await import(${JSON.stringify(manifest.name)})
    const cjs = createRequire(import.meta.url)(${JSON.stringify(manifest.name)})
    for (const api of [esm, cjs]) {
      assert.equal(typeof api.validate, 'function')
      assert.equal(api.SPEC_VERSION, ${JSON.stringify(JSON.parse(readFileSync(join(root, 'src/protocol/generated/spec.ts'), 'utf8').match(/SPEC_VERSION = ("[^"]+")/)[1]))})
      assert.deepEqual(api.validate('SiteKey', 'demo-site'), [])
      assert.equal(api.validate('SiteKey', 'x').length, 1)
    }
    // The transports, end to end on the installed package.
    const { toFetchHandler } = await import(${JSON.stringify(`${manifest.name}/fetch`)})
    const { createCollectorServer } = await import(${JSON.stringify(`${manifest.name}/node`)})
    const { collectorMiddleware } = await import(${JSON.stringify(`${manifest.name}/express`)})
    assert.equal(typeof collectorMiddleware, 'function')
    const mongo = await import(${JSON.stringify(`${manifest.name}/mongodb`)})
    for (const name of ['mongoStore', 'mongoSites', 'ensureMongoIndexes']) assert.equal(typeof mongo[name], 'function')
    const redis = await import(${JSON.stringify(`${manifest.name}/redis`)})
    for (const name of ['fromNodeRedis', 'fromIoredis', 'fromUpstash', 'redisStreamQueue', 'redisRateLimiter', 'redisCache', 'redisLock']) {
      assert.equal(typeof redis[name], 'function', name)
    }
    assert.equal(typeof (await import(${JSON.stringify(`${manifest.name}/ipinfo`)})).ipinfoGeo, 'function')
    const adapters = {
      sqs: ['sqsQueue'],
      postgres: ['postgresStore', 'migratePostgres', 'postgresMigrations'],
      mysql: ['mysqlStore', 'migrateMysql', 'mysqlMigrations'],
      dynamodb: ['dynamoStore', 'createDynamoTable'],
      sqlite: ['sqliteStore'],
    }
    for (const [subpath, names] of Object.entries(adapters)) {
      const module = await import(${JSON.stringify(`${manifest.name}/`)} + subpath)
      for (const name of names) assert.equal(typeof module[name], 'function', subpath + ': ' + name)
    }
    const collector = () => esm.createCollector({
      sites: [{ siteKey: 'demo-site', allowedOrigins: ['https://www.example.com'] }],
      store: esm.memoryStore(),
      logger: false,
    })
    const viaFetch = await toFetchHandler(collector())(
      new Request('http://collector.test/v1/context?siteKey=demo-site'),
    )
    assert.equal(viaFetch.status, 200)
    assert.equal((await viaFetch.json()).policy.reason, 'unknown-region')
    const server = createCollectorServer(collector(), { port: 0, host: '127.0.0.1' })
    const { url } = await server.listen()
    assert.equal((await fetch(url + '/v1/health')).status, 200)
    await server.close()
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', smoke], { cwd: project, stdio: 'pipe' })

  console.log(
    `${manifest.name}@${manifest.version}: ${files.length} files, no dependencies; offline install adds exactly 1 package; ESM import, require() and the fetch, node and Express transports and the adapters load.`,
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
