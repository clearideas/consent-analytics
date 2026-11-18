#!/usr/bin/env node
// Make sure the packages a test run needs are installed, and match their lockfiles.
//
//   node scripts/ensure-deps.mjs <package dir>... [--built <package dir>]
//
// For each directory: every dependency declared in package.json must be installed at the
// version in package-lock.json. If not (a fresh clone, or a lockfile that changed since the
// last install), `npm ci` runs there. `--built <dir>` also builds that package when its dist/
// is missing or older than its src/ (the collector uses the server package's dist/).
//
// Runs before the test scripts (`pretest`), uses only Node built-ins, and never touches a
// directory whose dependencies are already in place. SKIP_INSTALL_CHECK=1 turns it off.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

if (process.env.SKIP_INSTALL_CHECK === '1') process.exit(0)

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const label = dir => relative(process.cwd(), dir) || '.'

/** Declared dependencies that are missing or not at their locked version. */
function outOfDate(dir) {
  const manifest = readJson(join(dir, 'package.json'))
  const lockPath = join(dir, 'package-lock.json')
  if (!existsSync(lockPath)) throw new Error(`${label(dir)}: package-lock.json is missing`)
  const locked = readJson(lockPath).packages ?? {}
  const problems = []
  const declared = { ...manifest.dependencies, ...manifest.devDependencies }
  for (const name of Object.keys(declared)) {
    const entry = locked[`node_modules/${name}`]
    const installed = join(dir, 'node_modules', name, 'package.json')
    if (!existsSync(installed)) {
      problems.push(`${name} (not installed)`)
      continue
    }
    if (!entry || entry.link) continue // linked local packages (file:) have no version to compare
    const { version } = readJson(installed)
    if (version !== entry.version) problems.push(`${name} (${version}, locked ${entry.version})`)
  }
  return problems
}

function newest(dir) {
  let latest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs)
  }
  return latest
}

const args = process.argv.slice(2)
const builds = []
const dirs = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--built') builds.push(resolve(args[++i]))
  else dirs.push(resolve(args[i]))
}

for (const dir of [...new Set([...dirs, ...builds])]) {
  const problems = outOfDate(dir)
  if (!problems.length) continue
  const shown = problems.slice(0, 5).join(', ') + (problems.length > 5 ? ', ...' : '')
  console.log(`[deps] ${label(dir)}: installing (npm ci): ${shown}`)
  execFileSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' })
}

for (const dir of builds) {
  const entry = join(dir, 'dist', 'index.js')
  if (existsSync(entry) && statSync(entry).mtimeMs >= newest(join(dir, 'src'))) continue
  console.log(`[deps] ${label(dir)}: building (dist/ is missing or older than src/)`)
  execFileSync(npm, ['run', 'build'], { cwd: dir, stdio: 'inherit' })
}
