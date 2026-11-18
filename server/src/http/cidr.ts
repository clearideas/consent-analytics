// IP networks in CIDR notation (IPv4 and IPv6), for trusted proxy lists.
import { isIPv4 } from 'node:net'

import { expandIPv6 } from '../enrich/ip.ts'

interface Network {
  version: 4 | 6
  base: bigint
  bits: number
}

function toBigInt(ip: string): { version: 4 | 6; value: bigint } | undefined {
  if (isIPv4(ip)) {
    return {
      version: 4,
      value: ip.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n),
    }
  }
  const groups = expandIPv6(ip)
  if (!groups) return undefined
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is compared as IPv4.
  if (groups.slice(0, 5).every(g => g === '0000') && groups[5] === 'ffff') {
    return {
      version: 4,
      value: (BigInt(parseInt(groups[6]!, 16)) << 16n) | BigInt(parseInt(groups[7]!, 16)),
    }
  }
  return { version: 6, value: groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n) }
}

/** Parse "10.0.0.0/8", "2001:db8::/32" or a single address. Throws on anything else. */
export function parseCidr(text: string): Network {
  const [address, prefix] = text.trim().split('/')
  const parsed = address ? toBigInt(address) : undefined
  if (!parsed) throw new Error(`"${text}" is not an IP address or CIDR range`)
  const max = parsed.version === 4 ? 32 : 128
  const bits = prefix === undefined ? max : Number(prefix)
  if (!Number.isInteger(bits) || bits < 0 || bits > max)
    throw new Error(`"${text}": invalid prefix length`)
  const shift = BigInt(max - bits)
  return { version: parsed.version, base: (parsed.value >> shift) << shift, bits }
}

/** A function telling whether an address is in any of the networks. */
export function networkMatcher(cidrs: readonly string[]): (ip: string) => boolean {
  const networks = cidrs.map(parseCidr)
  return ip => {
    const parsed = toBigInt(ip)
    if (!parsed) return false
    return networks.some(network => {
      if (network.version !== parsed.version) return false
      const shift = BigInt((network.version === 4 ? 32 : 128) - network.bits)
      return (parsed.value >> shift) << shift === network.base
    })
  }
}
