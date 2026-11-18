// The server library is self-contained: every import in src/ is a node: built-in or a
// relative path that stays inside server/src (never the browser package or sample-host).
// ESLint rejects bare package imports; this test resolves relative paths, which it cannot.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import ts from 'typescript'
import { expect, it } from 'vitest'

const srcDir = resolve(import.meta.dirname, '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  )
}

it('imports only node: built-ins and files inside server/src', () => {
  const files = sourceFiles(srcDir)
  expect(files.length).toBeGreaterThan(3)
  const violations: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // TypeScript's scanner: static, side-effect and dynamic imports; comments ignored.
    const imports = ts.preProcessFile(source, true, true).importedFiles.map(f => f.fileName)
    for (const specifier of imports) {
      if (specifier.startsWith('node:')) continue
      const target = resolve(dirname(file), specifier)
      const inside = specifier.startsWith('.') && !relative(srcDir, target).startsWith('..')
      if (!inside) violations.push(`${relative(srcDir, file)} -> ${specifier}`)
    }
  }
  expect(violations).toEqual([])
})
