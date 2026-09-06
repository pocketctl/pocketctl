let fallbackSequence = 0

function formatUuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

/**
 * Creates a correlation/idempotency identifier in both secure browser origins
 * and plain-HTTP LAN origins. These IDs are not authentication secrets.
 */
export function createClientId(): string {
  const browserCrypto = globalThis.crypto

  try {
    if (typeof browserCrypto?.randomUUID === 'function') return browserCrypto.randomUUID()
  } catch {
    // Fall through: some embedded browsers expose the function but reject it.
  }

  try {
    if (typeof browserCrypto?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16)
      browserCrypto.getRandomValues(bytes)
      return formatUuid(bytes)
    }
  } catch {
    // Fall through to the non-cryptographic correlation ID below.
  }

  fallbackSequence = (fallbackSequence + 1) >>> 0
  const bytes = new Uint8Array(16)
  let timestamp = Date.now()
  for (let index = 5; index >= 0; index--) {
    bytes[index] = timestamp % 256
    timestamp = Math.floor(timestamp / 256)
  }
  const random = Math.floor(Math.random() * 0x1_0000_0000) >>> 0
  bytes[6] = random >>> 24
  bytes[7] = random >>> 16
  bytes[8] = random >>> 8
  bytes[9] = random
  bytes[10] = fallbackSequence >>> 24
  bytes[11] = fallbackSequence >>> 16
  bytes[12] = fallbackSequence >>> 8
  bytes[13] = fallbackSequence
  bytes[14] = random >>> 8
  bytes[15] = random
  return formatUuid(bytes)
}
