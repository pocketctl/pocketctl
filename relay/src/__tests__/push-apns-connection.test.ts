import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }))

vi.mock('node:http2', () => ({ connect: connectMock }))

describe('APNs HTTP/2 connection failures', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    connectMock.mockReset()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('contains a session-level connection error instead of rejecting the push caller', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pocketctl-apns-test-'))
    temporaryDirectories.push(directory)
    const keyPath = join(directory, 'AuthKey.p8')
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))

    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('APNS_KEY_PATH', keyPath)
    vi.stubEnv('APNS_KEY_ID', 'KEY123')
    vi.stubEnv('APNS_TEAM_ID', 'TEAM123')
    vi.stubEnv('APNS_BUNDLE_ID', 'com.pocketctl.app')
    vi.stubEnv('APNS_ENVIRONMENT', 'development')

    const session = new EventEmitter() as EventEmitter & {
      request: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
    }
    const request = new EventEmitter() as EventEmitter & {
      setEncoding: ReturnType<typeof vi.fn>
      write: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
    }
    session.close = vi.fn()
    session.request = vi.fn(() => request)
    request.setEncoding = vi.fn()
    request.write = vi.fn()
    let emitSessionError = () => {}
    request.end = vi.fn(() => {
      request.emit('error', new Error('The pending stream has been canceled'))
      emitSessionError = () => {
        session.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND api.sandbox.push.apple.com'), {
          code: 'ENOTFOUND',
        }))
      }
    })
    connectMock.mockReturnValue(session)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { sendPushNotification } = await import('../push.js')

    await expect(sendPushNotification(
      {} as never,
      'device-token',
      'ios',
      { title: 'Approval needed', body: 'Open PocketCtl' },
    )).resolves.toBeUndefined()
    expect(emitSessionError).not.toThrow()
    expect(session.close).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})
