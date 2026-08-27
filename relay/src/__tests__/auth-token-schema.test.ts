import jwt from 'jsonwebtoken'
import { beforeAll, describe, expect, test, vi } from 'vitest'

const secret = 'auth-token-schema-test-secret'
let signAccessToken: typeof import('../auth.js').signAccessToken
let signRefreshToken: typeof import('../auth.js').signRefreshToken
let verifyAccessToken: typeof import('../auth.js').verifyAccessToken
let verifyRefreshToken: typeof import('../auth.js').verifyRefreshToken
let resolveRefreshMachineId: typeof import('../auth.js').resolveRefreshMachineId

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', secret)
  const auth = await import('../auth.js')
  signAccessToken = auth.signAccessToken
  signRefreshToken = auth.signRefreshToken
  verifyAccessToken = auth.verifyAccessToken
  verifyRefreshToken = auth.verifyRefreshToken
  resolveRefreshMachineId = auth.resolveRefreshMachineId
})

describe('authentication token schema cutover', () => {
  test('rejects access and refresh tokens issued before the verified-email cutover', () => {
    const legacyAccess = jwt.sign({
      userId: 7,
      email: 'victim@example.test',
      type: 'access',
      jti: 'legacy-access-jti',
      machine_id: 'legacy-machine',
    }, secret, { expiresIn: '1h' })
    const legacyRefresh = jwt.sign({
      userId: 7,
      type: 'refresh',
      jti: 'legacy-refresh-jti',
    }, secret, { expiresIn: '1h' })

    expect(verifyAccessToken(legacyAccess)).toBeNull()
    expect(verifyRefreshToken(legacyRefresh)).toBeNull()
  })

  test('accepts tokens issued by the current authentication schema', async () => {
    const access = await signAccessToken(7, 'owner@example.test')
    const refresh = await signRefreshToken(7)

    expect(verifyAccessToken(access)).toMatchObject({ userId: 7, email: 'owner@example.test' })
    expect(verifyRefreshToken(refresh)).toMatchObject({ userId: 7 })
  })

  test('retains a bound machine identity across refresh rotation and safely migrates legacy tokens', async () => {
    const boundMachine = 'daemon-622f9090'
    const differentMachine = 'machine-0123456789abcdef0123456789abcdef'
    const access = await signAccessToken(7, 'owner@example.test', undefined, boundMachine)
    const refresh = await signRefreshToken(7, boundMachine)
    const payload = verifyRefreshToken(refresh)

    expect(verifyAccessToken(access)).toMatchObject({ userId: 7, machine_id: boundMachine })
    expect(payload).toMatchObject({ userId: 7, machine_id: boundMachine })
    expect(resolveRefreshMachineId(payload?.machine_id, differentMachine)).toBe(boundMachine)
    expect(resolveRefreshMachineId(undefined, boundMachine)).toBe(boundMachine)
    expect(resolveRefreshMachineId(undefined, 'unknown')).toBeUndefined()
  })
})
