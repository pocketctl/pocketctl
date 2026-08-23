import { isIP } from 'node:net'

/**
 * M-1: canonicalize the client address Fastify already resolved.
 *
 * Trust decisions live in the framework (trustProxy: false | string[] of
 * trusted proxy CIDRs), so req.ip is authoritative everywhere: when the
 * transport peer is not a trusted proxy, forwarding headers never influence
 * it and the socket address is used. REST rate limiting, WS admission, the
 * auth-failure ban and audit logs all consume this same canonical value.
 */
export function canonicalClientAddress(frameworkClientAddress: string | undefined): string {
  return normalizeAddress(frameworkClientAddress)
}

function normalizeAddress(address: string | undefined): string {
  if (!address) return 'unknown'
  const candidate = address.trim().replace(/^\[|\]$/g, '')
  if (candidate.toLowerCase().startsWith('::ffff:')) {
    const v4 = candidate.slice(7)
    if (isIP(v4) === 4) return v4
  }
  if (isIP(candidate) !== 6) return candidate
  try {
    return new URL(`http://[${candidate}]/`).hostname.slice(1, -1)
  } catch {
    return candidate.toLowerCase()
  }
}
