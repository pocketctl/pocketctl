import { describe, expect, test, vi } from 'vitest'
import { registerDaemonConnection, type DaemonSocketIdentity } from '../daemon-registration.js'

describe('registerDaemonConnection', () => {
  test('installs provisional identity before awaiting Router and cleans activation if the socket closes', async () => {
    let finishRegistration!: (registered: boolean) => void
    const router = {
      registerDaemon: vi.fn(() => new Promise<boolean>(resolve => { finishRegistration = resolve })),
      unregisterDaemon: vi.fn(),
    }
    const socket = {}
    const identities = new Map<object, DaemonSocketIdentity>()
    const registering = registerDaemonConnection(
      router, identities, socket, { daemon_id: 'daemon-1', started_at: 100 }, null,
    )

    const provisional = identities.get(socket)
    expect(provisional).toEqual({ daemonId: 'daemon-1', startedAt: 100 })
    router.unregisterDaemon(provisional!.daemonId, socket)
    identities.delete(socket)
    finishRegistration(true)

    await expect(registering).resolves.toBe(false)
    expect(router.unregisterDaemon).toHaveBeenLastCalledWith('daemon-1', socket)
    expect(identities.has(socket)).toBe(false)
  })

  test('identity-guards cleanup when registration fails after the socket is reused', async () => {
    const replacement = { daemonId: 'daemon-2', startedAt: 200 }
    const socket = {}
    const identities = new Map<object, DaemonSocketIdentity>()
    const router = {
      registerDaemon: vi.fn(async () => {
        identities.set(socket, replacement)
        return false
      }),
      unregisterDaemon: vi.fn(),
    }

    await expect(registerDaemonConnection(
      router, identities, socket, { daemon_id: 'daemon-1', started_at: 100 }, null,
    )).resolves.toBe(false)
    expect(identities.get(socket)).toBe(replacement)
  })

  test('releases handshake admission after Router registration settles', async () => {
    const router = {
      registerDaemon: vi.fn(async () => true),
      unregisterDaemon: vi.fn(),
    }
    const release = vi.fn()

    await expect(registerDaemonConnection(
      router, new Map(), {}, { daemon_id: 'daemon-1', started_at: 100 }, null, undefined, undefined, release,
    )).resolves.toBe(true)

    expect(release).toHaveBeenCalledOnce()
  })
})
