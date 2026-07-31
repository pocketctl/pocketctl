import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { signAPNsJWT } from '../push.js'

describe('signAPNsJWT', () => {
  test('creates an ES256 JWT with a 64-byte IEEE-P1363 signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    })

    const token = signAPNsJWT(privateKey, 'KEY123', 'TEAM123', 1_700_000_000)
    const [header, payload, signature] = token.split('.')

    expect(Buffer.from(signature, 'base64url')).toHaveLength(64)
    expect(verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    )).toBe(true)
  })
})
