import { isIP } from 'node:net'

export function resolveAdmissionAddress(input: {
  transportAddress?: string
  frameworkClientAddress?: string
  trustProxy: boolean
}): string {
  return normalizeAddress(input.trustProxy ? input.frameworkClientAddress : input.transportAddress)
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
