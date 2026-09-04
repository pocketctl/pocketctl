import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

describe('extension capability grant runtime wiring', () => {
  test('HTTP and daemon WebSocket grants share one startup key material instance', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../server.ts', import.meta.url)),
      'utf8',
    )

    expect(source.match(/resolveGrantKeyMaterial\(process\.env/g)).toHaveLength(1)
    expect(source).toContain('const extensionGrantKeys = resolveGrantKeyMaterial(process.env')
    expect(source).toMatch(/createMemoryMcpGrantBroker\([\s\S]*?grantKeys: extensionGrantKeys/)
    expect(source).toMatch(/registerCapabilityRoutes\(app,[\s\S]*?grantKeys: extensionGrantKeys/)
    expect(source).toMatch(/registerCapabilityV2GrantRoutes\(app,[\s\S]*?grantKeys: extensionGrantKeys/)
    expect(source).toMatch(/registerCapabilityV2GrantRoutes\(app,[\s\S]*?providerPublicOrigins: extensionConfig\.providerPublicOrigins/)
  })
})
