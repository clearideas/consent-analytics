#!/usr/bin/env node
// Checks the package as it would be published (npm pack), not the source tree:
//  1. Only dist/, README, CHANGELOG, LICENSE and package.json are packed; no tests, no
//     credentials.
//  2. The command-line entry point is executable by npm (shebang) and the API is exported.
//  3. The server library dependency: `file:../server` while developing; an exact version
//     when publishing (RELEASE=1; the publish workflow pins it).
//  4. The built CLI validates a configuration (--check) and reports every problem.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const server = manifest.dependencies?.['@clearideas/consent-analytics-server']
assert(server, 'The collector must depend on @clearideas/consent-analytics-server')
if (process.env.RELEASE === '1') {
  assert(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(server), `Publish with an exact server version, not "${server}"`)
} else {
  assert(server === 'file:../server' || /^\d+\.\d+\.\d+/.test(server), `Unexpected server dependency "${server}"`)
}
for (const [name, range] of Object.entries(manifest.dependencies)) {
  if (name === '@clearideas/consent-analytics-server') continue
  assert(/^\d+\.\d+\.\d+$/.test(range), `Pin ${name} to an exact version (got "${range}")`)
}

const scratch = mkdtempSync(join(tmpdir(), 'ca-collector-pack-'))
try {
  const output = execFileSync(npm, ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })
  const files = JSON.parse(output)[0].files.map(file => file.path)
  const allowed = /^(?:dist\/.+\.(?:js|d\.ts|js\.map)|README\.md|CHANGELOG\.md|LICENSE|package\.json)$/
  for (const file of files) {
    assert(allowed.test(file), `Unexpected packed file: ${file}`)
    assert(!/\.(?:test|spec)\./.test(file), `Test file packed: ${file}`)
  }
  for (const entry of ['dist/cli.js', 'dist/main.js', 'dist/main.d.ts', 'README.md', 'LICENSE']) {
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
  }

  const bin = manifest.bin?.['consent-analytics-collector']
  assert.equal(bin, 'dist/cli.js')
  assert(readFileSync(join(root, bin), 'utf8').startsWith('#!/usr/bin/env node\n'), 'dist/cli.js needs a shebang')

  const api = await import(pathToFileURL(join(root, 'dist/main.js')).href)
  for (const name of ['startCollector', 'loadConfig', 'ConfigError']) {
    assert.equal(typeof api[name], 'function', `dist/main.js exports ${name}`)
  }

  const cli = env =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, bin), '--check'], {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
    })
  const valid = cli({ SITES_FILE: join(root, 'sites.example.json'), STORE: 'memory' })
  assert.equal(valid.status, 0, valid.stderr)
  assert.match(valid.stdout, /Configuration is valid/)
  const invalid = cli({ STORE: 'postgres', QUEUE: 'redis' })
  assert.equal(invalid.status, 1)
  for (const problem of ['SITES_FILE', 'POSTGRES_URL', 'REDIS_URL']) {
    assert.match(invalid.stderr, new RegExp(problem), `--check reports ${problem}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${manifest.name}: checked packed files, credentials, CLI entry point, exports and --check.`)
