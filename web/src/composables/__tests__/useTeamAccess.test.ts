import { ref } from 'vue'
import { describe, expect, test } from 'vitest'
import { createTeamAccessController } from '../useTeamAccess'
import type { TeamCapabilities } from '../../types/team'

const allowed: TeamCapabilities = { schema_version: 1, contract_version: 'team-collaboration.v1', collaboration: true, autorun: true, memory_bridge: false, writes_enabled: true }
describe('Team account capability cache', () => {
  test('starts closed, reflects grant/revoke and fails closed on a network error', async () => {
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
    expect(await access.refresh()).toBe(false)
    expect(access.enabled.value).toBe(false)
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
