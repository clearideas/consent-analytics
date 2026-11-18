// Identity configuration and sanitizing of what `identify` returns.
import { describe, expect, it, vi } from 'vitest'

import { identityConfig, sanitizeIdentity, silentLogger } from '../src/index.ts'

describe('identityConfig', () => {
  it('defaults to userId and accountId keys, no traits, linked consent records', () => {
    expect(identityConfig()).toEqual({
      keys: ['userId', 'accountId'],
      traits: [],
      maxValueLength: 256,
      consentRecords: true,
    })
  })

  it('rejects invalid names, no keys, and names that are both key and trait', () => {
    expect(() => identityConfig({ keys: ['user id'] })).toThrow(/not a valid key name/)
    expect(() => identityConfig({ keys: [] })).toThrow(/at least one key/)
    expect(() => identityConfig({ keys: ['userId'], traits: ['userId'] })).toThrow(
      /both a key and a trait/,
    )
  })
})

describe('sanitizeIdentity', () => {
  const config = identityConfig({
    keys: ['userId', 'accountId'],
    traits: ['plan', 'seats'],
    maxValueLength: 10,
  })
  const sanitize = (value: unknown) => sanitizeIdentity(value, config, silentLogger, new Set())

  it('splits keys and traits, keeping valid strings, finite numbers and booleans', () => {
    expect(sanitize({ userId: 'u-1', accountId: 42, plan: 'pro', seats: 5 })).toEqual({
      identity: { userId: 'u-1', accountId: 42 },
      traits: { plan: 'pro', seats: 5 },
    })
    expect(sanitize({ userId: 'u-1', plan: null, seats: undefined })).toEqual({
      identity: { userId: 'u-1' },
    })
  })

  it('drops invalid values; without any key there is no identity', () => {
    expect(sanitize({ userId: '', accountId: Number.NaN })).toBeUndefined()
    expect(sanitize({ userId: 'x'.repeat(11), accountId: { id: 1 } })).toBeUndefined()
    expect(sanitize({ plan: 'pro' })).toBeUndefined() // traits alone identify nobody
    for (const value of [null, undefined, 'u-1', 42, ['u-1']])
      expect(sanitize(value)).toBeUndefined()
  })

  it('warns once per unknown name', () => {
    const warn = vi.fn()
    const warned = new Set<string>()
    const logger = { ...silentLogger, warn }
    for (let i = 0; i < 3; i++)
      sanitizeIdentity({ userId: 'u-1', email: 'a@b.example' }, config, logger, warned)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toEqual({ name: 'email' }) // the name, never the value
  })
})
