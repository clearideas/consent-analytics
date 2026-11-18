// A small user-agent parser: browser, OS, device type and bots. Major versions only (enough
// for reporting, less identifying). Client Hints are used when the browser sends them.

export type DeviceType = 'mobile' | 'tablet' | 'desktop' | 'bot'

export interface ParsedUserAgent {
  browser?: string
  browserVersion?: string
  os?: string
  osVersion?: string
  device: DeviceType
  isBot: boolean
}

export interface ClientHints {
  /** Sec-CH-UA-Mobile: "?1" or "?0". */
  mobile?: string | null
  /** Sec-CH-UA-Platform, e.g. "\"Windows\"". */
  platform?: string | null
}

const BOT =
  /bot\b|bot\/|crawler|spider|crawling|slurp|mediapartners|facebookexternalhit|bingpreview|headlesschrome|phantomjs|lighthouse|pagespeed|pingdom|uptimerobot|statuscake|python-requests|python-urllib|aiohttp|curl\/|wget\/|go-http-client|java\/|okhttp|axios\/|node-fetch|undici|libwww|httpclient|scrapy/i

// Checked in order: browsers that also claim to be Chrome/Safari come first.
const BROWSERS: Array<[name: string, pattern: RegExp]> = [
  ['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ['Opera', /\b(?:OPR|OPiOS|Opera)\/(\d+)/],
  ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
  ['Yandex', /\bYaBrowser\/(\d+)/],
  ['Vivaldi', /\bVivaldi\/(\d+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /\b(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /\bVersion\/(\d+)(?:[.\d]*)? (?:Mobile\/\S+ )?Safari\//],
]

const PLATFORM_HINTS: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  android: 'Android',
  ios: 'iOS',
  'chrome os': 'ChromeOS',
  chromeos: 'ChromeOS',
  linux: 'Linux',
}

function parseOs(ua: string): { os?: string; osVersion?: string } {
  let match: RegExpExecArray | null
  if ((match = /\b(?:iPhone|iPod).*? OS (\d+)/.exec(ua))) return { os: 'iOS', osVersion: match[1] }
  if ((match = /\biPad.*? OS (\d+)/.exec(ua))) return { os: 'iPadOS', osVersion: match[1] }
  if ((match = /\bAndroid (\d+)/.exec(ua))) return { os: 'Android', osVersion: match[1] }
  if (/\bAndroid\b/.test(ua)) return { os: 'Android' }
  if ((match = /\bWindows NT (\d+\.\d+)/.exec(ua))) {
    const versions: Record<string, string> = { '10.0': '10', '6.3': '8.1', '6.2': '8', '6.1': '7' }
    const osVersion = versions[match[1]!]
    return { os: 'Windows', ...(osVersion ? { osVersion } : {}) }
  }
  if ((match = /\bMac OS X (\d+)[._](\d+)/.exec(ua))) {
    return { os: 'macOS', osVersion: match[1] === '10' ? `10.${match[2]}` : match[1] }
  }
  if (/\bCrOS\b/.test(ua)) return { os: 'ChromeOS' }
  if (/\bLinux\b/.test(ua)) return { os: 'Linux' }
  return {}
}

export function parseUserAgent(userAgent: string, hints: ClientHints = {}): ParsedUserAgent {
  const ua = userAgent.slice(0, 1024)
  if (BOT.test(ua) || !ua.trim()) {
    return { device: 'bot', isBot: true }
  }
  const result: ParsedUserAgent = { device: 'desktop', isBot: false }
  for (const [name, pattern] of BROWSERS) {
    const match = pattern.exec(ua)
    if (match) {
      result.browser = name
      result.browserVersion = match[1]
      break
    }
  }
  const { os, osVersion } = parseOs(ua)
  if (os) result.os = os
  if (osVersion) result.osVersion = osVersion
  if (!result.os && hints.platform) {
    const hinted = PLATFORM_HINTS[hints.platform.replace(/"/g, '').trim().toLowerCase()]
    if (hinted) result.os = hinted
  }

  if (
    /\biPad\b|\bTablet\b|\bKindle\b|\bSilk\//.test(ua) ||
    (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua))
  ) {
    result.device = 'tablet'
  } else if (/\bMobi|\biPhone\b|\biPod\b/.test(ua) || hints.mobile === '?1') {
    result.device = 'mobile'
  }
  return result
}
