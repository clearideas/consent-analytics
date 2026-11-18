// The browser package is self-contained: src/ never reaches into server/, sample-host/ or
// Node.js built-ins. ESLint rejects such specifiers; this test resolves relative paths.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import ts from 'typescript'
import { expect, it } from 'vitest'

const srcDir = resolve(import.meta.dirname, '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  )
}

it('browser code imports only its own files and declared peer packages', () => {
  const files = sourceFiles(srcDir)
  expect(files.length).toBeGreaterThan(10)
  const peers = /^(react|react\/jsx-runtime|next\/navigation|nuxt|nuxt\/app)$/
  const violations: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // TypeScript's scanner: static, side-effect and dynamic imports; comments ignored.
    const imports = ts.preProcessFile(source, true, true).importedFiles.map(f => f.fileName)
    for (const specifier of imports) {
      if (peers.test(specifier)) continue
      const target = resolve(dirname(file), specifier)
      const inside = specifier.startsWith('.') && !relative(srcDir, target).startsWith('..')
      if (!inside) violations.push(`${relative(srcDir, file)} -> ${specifier}`)
    }
  }
  expect(violations).toEqual([])
})
