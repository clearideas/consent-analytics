// Server-side enrichment: IP forms, user agents, languages, and the collection levels.
import { describe, expect, it } from 'vitest'

import type { FullCollection, Geo, LimitedCollection, RequestFacts } from '../src/index.ts'
import {
  collectServerInfo,
  headerReader,
  ipHasher,
  parseUserAgent,
  primaryLanguage,
  requestFacts,
  truncateIp,
} from '../src/index.ts'

describe('truncateIp', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0'],
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3::'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8:0::'],
    ['2001:db8::1', '2001:db8:0::'],
    ['::1', '0:0:0::'],
    ['::ffff:192.0.2.1', '0:0:0::'],
    ['fe80::1%eth0', 'fe80:0:0::'],
  ])('%s -> %s', (ip, expected) => {
    expect(truncateIp(ip)).toBe(expected)
  })

  it('returns undefined for anything that is not an IP address', () => {
    for (const value of ['', 'localhost', '1.2.3', '2001:db8:::1', 'gggg::1'])
      expect(truncateIp(value)).toBeUndefined()
  })
})

describe('ipHasher', () => {
  const hash = ipHasher('a-secret-of-at-least-16-characters')
  const day1 = new Date('2026-11-10T08:00:00Z')
  const day1Later = new Date('2026-11-10T23:59:59Z')
  const day2 = new Date('2026-11-11T00:00:00Z')

  it('is stable within a UTC day and unlinkable across days', () => {
    const a = hash('203.0.113.9', day1)
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(hash('203.0.113.9', day1Later)).toBe(a)
    expect(hash('203.0.113.9', day2)).not.toBe(a)
    expect(hash('203.0.113.10', day1)).not.toBe(a)
    expect(a).not.toContain('203')
  })

  it('depends on the secret; equivalent IPv6 spellings hash the same', () => {
    expect(ipHasher('another-secret-16-chars-long')('203.0.113.9', day1)).not.toBe(
      hash('203.0.113.9', day1),
    )
    expect(hash('2001:db8::1', day1)).toBe(hash('2001:0DB8:0:0:0:0:0:1', day1))
  })

  it('requires a secret of at least 16 characters', () => {
    expect(() => ipHasher('short')).toThrow(/at least 16/)
  })
})

describe('parseUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      {
        browser: 'Chrome',
        browserVersion: '131',
        os: 'Windows',
        osVersion: '10',
        device: 'desktop',
        isBot: false,
      },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.86',
      { browser: 'Edge', browserVersion: '131', os: 'Windows', device: 'desktop' },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
      {
        browser: 'Firefox',
        browserVersion: '133',
        os: 'macOS',
        osVersion: '10.15',
        device: 'desktop',
      },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      { browser: 'Safari', browserVersion: '18', os: 'macOS', device: 'desktop' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', browserVersion: '18', os: 'iOS', osVersion: '18', device: 'mobile' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
      { browser: 'Chrome', browserVersion: '131', os: 'iOS', device: 'mobile' },
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', os: 'iPadOS', osVersion: '17', device: 'tablet' },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
      {
        browser: 'Samsung Internet',
        browserVersion: '26',
        os: 'Android',
        osVersion: '14',
        device: 'mobile',
      },
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      { browser: 'Chrome', os: 'Android', device: 'tablet' },
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/115.0.0.0',
      { browser: 'Opera', browserVersion: '115', os: 'Linux', device: 'desktop' },
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      { browser: 'Chrome', os: 'ChromeOS', device: 'desktop' },
    ],
  ])('%s', (ua, expected) => {
    expect(parseUserAgent(ua)).toMatchObject(expected)
  })

  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
    'curl/8.5.0',
    'python-requests/2.32.3',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    '',
  ])('bot: %s', ua => {
    expect(parseUserAgent(ua)).toEqual({ device: 'bot', isBot: true })
  })

  it('uses Client Hints when the user agent string does not say', () => {
    expect(
      parseUserAgent('Mozilla/5.0 (Unknown)', { mobile: '?1', platform: '"Android"' }),
    ).toMatchObject({
      os: 'Android',
      device: 'mobile',
    })
  })
})

describe('primaryLanguage', () => {
  it.each([
    ['de-DE,de;q=0.9,en;q=0.8', 'de-DE'],
    ['en;q=0.5, fr-ca;q=0.9', 'fr-CA'],
    ['zh-Hant-TW', 'zh-Hant-TW'],
    ['*', undefined],
    ['en;q=0', undefined],
    ['"><script>', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%s -> %s', (header, expected) => {
    expect(primaryLanguage(header)).toBe(expected)
  })
})

describe('collectServerInfo', () => {
  const facts: RequestFacts = requestFacts(
    headerReader({
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'accept-language': 'de-DE,de;q=0.9',
      'sec-gpc': '1',
    }),
    '203.0.113.77',
  )
  const geo: Geo = {
    country: 'DE',
    continent: 'EU',
    region: 'Berlin',
    regionCode: 'DE-BE',
    city: 'Berlin',
    postalCode: '10115',
    timezone: 'Europe/Berlin',
    latitude: 52.52,
    longitude: 13.4,
    asn: 'AS3320',
    org: 'Deutsche Telekom AG',
    privacy: { vpn: false, hosting: false },
  }
  const nothing: FullCollection = {
    ip: 'none',
    geo: 'none',
    network: 'none',
    userAgent: 'none',
    language: false,
    privacyFlags: false,
    gpc: false,
    identity: false,
    clientPropsDeny: [],
  }
  const receivedAt = new Date('2026-11-10T12:00:00Z')
  const collect = (
    collection: FullCollection | LimitedCollection,
    category: 'full' | 'limited' = 'full',
  ) =>
    collectServerInfo(facts, geo, collection, {
      category,
      receivedAt,
      hashIp: ipHasher('0123456789abcdef'),
    })

  it('nothing collected: undefined', () => {
    expect(collect(nothing)).toBeUndefined()
  })

  it('everything', () => {
    expect(
      collect({
        ...nothing,
        ip: 'full',
        geo: 'coords',
        network: 'org',
        userAgent: 'raw',
        language: true,
        privacyFlags: true,
        gpc: true,
      }),
    ).toEqual({
      ip: '203.0.113.77',
      ipForm: 'full',
      geo: {
        country: 'DE',
        continent: 'EU',
        region: 'Berlin',
        regionCode: 'DE-BE',
        city: 'Berlin',
        postalCode: '10115',
        timezone: 'Europe/Berlin',
        latitude: 52.52,
        longitude: 13.4,
      },
      network: { asn: 'AS3320', org: 'Deutsche Telekom AG' },
      userAgent: {
        browser: 'Chrome',
        browserVersion: '131',
        os: 'Windows',
        osVersion: '10',
        device: 'desktop',
        isBot: false,
        raw: facts.userAgent,
      },
      language: 'de-DE',
      gpc: true,
      privacy: { vpn: false, hosting: false },
    })
  })

  it('each level keeps only its own fields', () => {
    expect(collect({ ...nothing, ip: 'truncated' })).toEqual({
      ip: '203.0.113.0',
      ipForm: 'truncated',
    })
    expect(collect({ ...nothing, ip: 'hashed' })).toEqual({
      ip: expect.stringMatching(/^[\w-]{22}$/),
      ipForm: 'hashed',
    })
    expect(collect({ ...nothing, geo: 'country' })).toEqual({
      geo: { country: 'DE', continent: 'EU' },
    })
    expect(collect({ ...nothing, geo: 'region' })).toEqual({
      geo: { country: 'DE', continent: 'EU', region: 'Berlin', regionCode: 'DE-BE' },
    })
    expect(collect({ ...nothing, geo: 'city' })?.geo).not.toHaveProperty('latitude')
    expect(collect({ ...nothing, geo: 'city' })?.geo).toMatchObject({
      city: 'Berlin',
      timezone: 'Europe/Berlin',
    })
    expect(collect({ ...nothing, network: 'asn' })).toEqual({ network: { asn: 'AS3320' } })
    expect(collect({ ...nothing, userAgent: 'device-type' })).toEqual({
      userAgent: { device: 'desktop' },
    })
    expect(collect({ ...nothing, userAgent: 'parsed' })?.userAgent).not.toHaveProperty('raw')
  })

  it('limited events never get an IP address or privacy flags, whatever the collection says', () => {
    // The schema forbids `ip` in limited collections; this holds even for a malformed one.
    const limited = {
      geo: 'country',
      network: 'asn',
      userAgent: 'parsed',
      language: true,
      gpc: true,
      ip: 'full',
      privacyFlags: true,
    }
    expect(collect(limited as unknown as LimitedCollection, 'limited')).toEqual({
      geo: { country: 'DE', continent: 'EU' },
      network: { asn: 'AS3320' },
      userAgent: {
        browser: 'Chrome',
        browserVersion: '131',
        os: 'Windows',
        osVersion: '10',
        device: 'desktop',
        isBot: false,
      },
      language: 'de-DE',
      gpc: true,
    })
  })

  it('hashed IP without a hasher stores nothing; missing inputs are skipped', () => {
    expect(
      collectServerInfo(facts, geo, { ...nothing, ip: 'hashed' }, { category: 'full', receivedAt }),
    ).toBeUndefined()
    const bare = requestFacts(headerReader({}), undefined)
    expect(
      collectServerInfo(
        bare,
        null,
        { ...nothing, ip: 'full', geo: 'coords', userAgent: 'raw', language: true, gpc: true },
        { category: 'full', receivedAt },
      ),
    ).toEqual({ gpc: false })
  })
})
