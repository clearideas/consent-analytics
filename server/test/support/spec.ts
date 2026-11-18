// The spec, and a check that a response matches the schema the spec declares for it.
import { expect } from 'vitest'

import { loadSpec } from '../../scripts/generate.mjs'
import type { SchemaName } from '../../src/index.ts'
import { validate } from '../../src/index.ts'

export const spec = loadSpec()

/** Name of the schema the spec declares for this response ('inline' for inline schemas). */
export function responseSchema(
  path: string,
  method: string,
  status: number,
): SchemaName | 'inline' {
  const operation = spec.paths[path]?.[method.toLowerCase()]
  if (!operation) throw new Error(`No ${method} ${path} in spec`)
  let response = operation.responses[String(status)]
  if (!response) throw new Error(`Spec does not declare ${status} for ${method} ${path}`)
  if (response.$ref) response = spec.components.responses[response.$ref.split('/').pop()]
  const schema = (Object.values(response.content) as any[])[0].schema
  return schema.$ref ? (schema.$ref.split('/').pop() as SchemaName) : 'inline'
}

/** Assert a response to a spec operation is declared and matches its schema. */
export function expectMatchesSpec(
  path: string,
  method: string,
  status: number,
  contentType: string | null,
  body: unknown,
) {
  const schema = responseSchema(path, method, status)
  if (schema !== 'inline') {
    expect(validate(schema, body), `${method} ${path} ${status} matches ${schema}`).toEqual([])
  }
  if (status >= 400) expect(contentType).toContain('application/problem+json')
}
