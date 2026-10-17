import { ref } from 'vue'
import { describe, expect, test } from 'vitest'
import { createTeamAccessController } from '../useTeamAccess'
import type { TeamCapabilities } from '../../types/team'
import { TeamApiError } from '../../services/teamClient'

const allowed: TeamCapabilities = { schema_version: 1, contract_version: 'team-collaboration.v1', collaboration: true, autorun: true, memory_bridge: false, writes_enabled: true }
describe('Team account capability cache', () => {
  test('keeps authorized history visible when application writes are rolled back', async () => {
    const access = createTeamAccessController(ref('alice'), async () => ({ ...allowed, collaboration: false, reads_enabled: true, writes_enabled: false }))
    expect(await access.refresh()).toBe(true)
    expect(access.capabilities.value?.writes_enabled).toBe(false)
  })
  test('starts closed, reflects grant/revoke and retains a verified grant on transport failure', async () => {
    const token = ref('alice')
    let response: TeamCapabilities | Error = allowed
    const access = createTeamAccessController(token, async () => {
      if (response instanceof Error) throw response
      return response
    })
    expect(access.enabled.value).toBe(false)
    expect(await access.refresh()).toBe(true)
    expect(access.enabled.value).toBe(true)
    response = { ...allowed, collaboration: false, writes_enabled: false }
    expect(await access.refresh()).toBe(false)
    response = allowed
    await access.refresh()
    response = new Error('offline')
    expect(await access.refresh()).toBe(true)
    expect(access.enabled.value).toBe(true)
    expect(access.denied.value).toBe(false)
    response = new TeamApiError(403, { error: { code: 'forbidden', message: 'revoked' } })
    expect(await access.refresh()).toBe(false)
    expect(access.denied.value).toBe(true)
  })

  test('does not grant a new account or claim confirmed denial when the network is unavailable', async () => {
    const token = ref('alice')
    let offline = false
    const access = createTeamAccessController(token, async () => { if (offline) throw new Error('offline'); return allowed })
    await access.refresh()
    offline = true; token.value = 'bob'
    expect(await access.refresh()).toBe(false)
    expect(access.enabled.value).toBe(false)
    expect(access.denied.value).toBe(false)
    expect(access.capabilities.value).toBeNull()
  })

  test('never lets a late response or previous account authorize the current account', async () => {
    const token = ref('alice')
    let complete!: (value: TeamCapabilities) => void
    const access = createTeamAccessController(token, () => new Promise(resolve => { complete = resolve }))
    const pending = access.refresh()
    token.value = 'bob'
    complete(allowed)
    expect(await pending).toBe(false)
    expect(access.enabled.value).toBe(false)
    const bob = access.refresh()
    complete(allowed)
    expect(await bob).toBe(true)
    token.value = ''
    expect(access.enabled.value).toBe(false)
    expect(await access.refresh()).toBe(false)
  })
})
