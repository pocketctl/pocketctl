import { describe, expect, test, vi } from 'vitest'
import { createInstallationsClient } from '../relay/installations.js'

const INSTALLATION_ID = '11111111-1111-4111-8111-111111111111'
const TEAM_ID = '22222222-2222-4222-8222-222222222222'
const ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333'

function inventoryRow(overrides: Record<string, unknown> = {}) {
  return {
    installation_id: INSTALLATION_ID,
    status: 'active',
    config_version: '1',
    granted_scopes: [],
    subscriptions: [],
    enabled_services: [],
    event_filter: {},
    snapshot_required: false,
    created_at: '2026-08-30T00:00:00.000Z',
    updated_at: '2026-08-30T00:00:00.000Z',
    owner_scope_kind: 'team',
    owner_scope_id: TEAM_ID,
    parent_organization_id: ORGANIZATION_ID,
    authorization_epoch: '3',
    ...overrides,
  }
}

function clientFor(row: Record<string, unknown>) {
  return createInstallationsClient({
    http: {
      request: vi.fn(async () => ({
        installations: [row],
        next_cursor: null,
        has_more: false,
      })),
    } as never,
    tokens: { get: vi.fn(async () => 'token'), invalidate: vi.fn() },
  })
}

describe('Relay v2 installation inventory parsing', () => {
  test('preserves a Team parent Organization needed for hierarchy and transfer checks', async () => {
    const page = await clientFor(inventoryRow()).listInstallationsV2()
    expect(page.installations[0]).toMatchObject({
      owner_scope_kind: 'team',
      owner_scope_id: TEAM_ID,
      parent_organization_id: ORGANIZATION_ID,
    })
  })

  test('fails closed when Team parent metadata is absent or malformed', async () => {
    await expect(clientFor(inventoryRow({ parent_organization_id: null })).listInstallationsV2())
      .rejects.toThrow(/malformed owner-scope metadata/)
    await expect(clientFor(inventoryRow({ parent_organization_id: 'not-a-uuid' })).listInstallationsV2())
      .rejects.toThrow(/malformed owner-scope metadata/)
  })

  test('requires a null parent for personal and Organization installations', async () => {
    const personal = await clientFor(inventoryRow({
      owner_scope_kind: 'personal',
      owner_scope_id: INSTALLATION_ID,
      parent_organization_id: null,
    })).listInstallationsV2()
    expect(personal.installations[0].parent_organization_id).toBeNull()

    await expect(clientFor(inventoryRow({
      owner_scope_kind: 'organization',
      owner_scope_id: ORGANIZATION_ID,
      parent_organization_id: TEAM_ID,
    })).listInstallationsV2()).rejects.toThrow(/malformed owner-scope metadata/)
  })
})
