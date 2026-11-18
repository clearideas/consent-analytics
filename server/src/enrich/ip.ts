// IP address forms for storage: truncated (network prefix) or hashed (daily-rotating key).
import { createHmac } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

/** IPv4 to its /24 network (`203.0.113.0`), IPv6 to its /48 (`2001:db8:85a3::`). */
export function truncateIp(ip: string): string | undefined {
  if (isIPv4(ip)) return ip.split('.').slice(0, 3).concat('0').join('.')
  const groups = expandIPv6(ip)
  if (!groups) return undefined
  return `${groups
    .slice(0, 3)
    .map(g => g.replace(/^0+(?=.)/, ''))
    .join(':')}::`
}

/** The eight 16-bit groups of an IPv6 address (lower-case hex), or undefined. */
export function expandIPv6(ip: string): string[] | undefined {
  const address = ip.split('%')[0]! // zone index
  if (!isIPv6(address)) return undefined
  let text = address.toLowerCase()
  // Embedded IPv4 (e.g. ::ffff:192.0.2.1): convert its last 32 bits to two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4) {
    const [a, b, c, d] = v4[1]!.split('.').map(Number) as [number, number, number, number]
    text =
      text.slice(0, -v4[1]!.length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.split('::') as [string, string | undefined]
  const left = head ? head.split(':') : []
  const right = tail !== undefined && tail !== '' ? tail.split(':') : []
  const missing = 8 - left.length - right.length
  const groups = tail === undefined ? left : [...left, ...Array(missing).fill('0'), ...right]
  return groups.length === 8 ? groups.map(g => g.padStart(4, '0')) : undefined
}

/**
 * Hash IP addresses with a key that changes every UTC day: the same address gives the same
 * hash within a day (counting unique visitors), and hashes cannot be linked across days.
 * The daily key is derived from the secret, so every instance agrees without shared state.
 */
export function ipHasher(secret: string): (ip: string, at: Date) => string {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('hashSecret must be a string of at least 16 characters')
  }
  let day = ''
  let key: Buffer = Buffer.alloc(0)
  return (ip, at) => {
    const today = at.toISOString().slice(0, 10)
    if (today !== day) {
      day = today
      key = createHmac('sha256', secret).update(`consent-analytics/ip/${today}`).digest()
    }
    const normalized = expandIPv6(ip)?.join(':') ?? ip
    return createHmac('sha256', key).update(normalized).digest('base64url').slice(0, 22)
  }
}
