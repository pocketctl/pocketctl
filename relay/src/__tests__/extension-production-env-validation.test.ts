import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  parseSystemdEnvironmentFile,
  validateExtensionProductionEnvironment,
} from '../extensions/validate-production-env.js'

function validProductionEnv(): Record<string, string> {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return {
    NODE_ENV: 'production',
    RELAY_EXTENSIONS: 'enabled',
    EXTENSION_PROVIDER_JWT_SECRET: 'provider-jwt-secret-0123456789abcdef',
    EXTENSION_CURSOR_SECRET: 'cursor-secret-0123456789abcdef012345',
    EXTENSION_GRANT_PRIVATE_KEY_B64: Buffer.from(privateKey).toString('base64'),
    EXTENSION_GRANT_PUBLIC_KEY_B64: Buffer.from(publicKey).toString('base64'),
    EXTENSION_PROVIDER_PUBLIC_ORIGINS: '{"pocketctl-memory": "https://memory.example"}',
    RELAY_EXTENSION_RATE_LIMIT_FEED: '120',
  }
}

describe('extension production EnvironmentFile validation', () => {
  test('accepts the same valid RSA pair and extension values used at Relay startup', () => {
    expect(() => validateExtensionProductionEnvironment(validProductionEnv())).not.toThrow()
  })

  test('rejects canonical base64 that is not a usable RSA keypair', () => {
    expect(() => validateExtensionProductionEnvironment({
      ...validProductionEnv(),
      EXTENSION_GRANT_PRIVATE_KEY_B64: Buffer.from('not-a-private-key'.repeat(3)).toString('base64'),
      EXTENSION_GRANT_PUBLIC_KEY_B64: Buffer.from('not-a-public-key'.repeat(3)).toString('base64'),
    })).toThrow('not valid PEM keys')
  })

  test('parses generated EnvironmentFile values without truncating base64 padding', () => {
    expect(parseSystemdEnvironmentFile([
      '# generated',
      'NODE_ENV=production',
      'EXTENSION_GRANT_PUBLIC_KEY_B64=YWJjZA==',
      '',
    ].join('\n'))).toEqual({
      NODE_ENV: 'production',
      EXTENSION_GRANT_PUBLIC_KEY_B64: 'YWJjZA==',
    })
  })

  test('enabled production requires provider public origins for every catalog provider', () => {
    const withoutOrigins = { ...validProductionEnv() }
    delete withoutOrigins.EXTENSION_PROVIDER_PUBLIC_ORIGINS
    expect(() => validateExtensionProductionEnvironment(withoutOrigins))
      .toThrow(/EXTENSION_PROVIDER_PUBLIC_ORIGINS/)
  })

  test('enabled production rejects malformed or non-HTTPS provider origins', () => {
    for (const bad of [
      'not-json',
      '{"unknown-provider": "https://x.example"}',
      '{"pocketctl-memory": "http://memory.example"}',
      '{"pocketctl-memory": "https://memory.example/path"}',
    ]) {
      expect(() => validateExtensionProductionEnvironment({
        ...validProductionEnv(),
        EXTENSION_PROVIDER_PUBLIC_ORIGINS: bad,
      })).toThrow()
    }
  })
})
