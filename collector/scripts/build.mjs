#!/usr/bin/env node
// Build dist/: compile src/ with tsc. Relative `.ts` imports are
// rewritten to `.js` (rewriteRelativeImportExtensions).
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')

rmSync(join(root, 'dist'), { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], {
  cwd: root,
  stdio: 'inherit',
})
console.log('Built dist/')
