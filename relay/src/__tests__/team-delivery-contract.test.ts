import { describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { artifactDigest, stableDigest, validateSubmission, validateReviewPolicy, validateAcceptance, type PrepareSubmission } from '../team/delivery-contract.js'
import { registerTeamDeliveryRoutes, type DeliveryRouteService } from '../team/delivery-routes.js'
import { resolveTeamCollaborationConfig, teamDeliveryEnabled } from '../team/config.js'
import { TeamRepositoryError } from '../team/repository.js'

function submission(): PrepareSubmission {
  return { request_id: 'prepare', expected_revision: 1, spec_revision: 1, source_call_id: 'call-1', summary: 'Fix and report', code_revision: 'abc', publish_scope: 'team', contribution_ids: [],
    artifacts: [{ id: 'report', name: 'report.md', mime_type: 'text/markdown', byte_size: 3, sha256: artifactDigest(Buffer.from('abc')), required: true }],
    evidence: [{ check_id: 'unit', result: 'passed', artifact_id: 'report', code_revision: 'abc', source_kind: 'agent_claim' }] }
}
describe('Task delivery contracts', () => {
  test('requires explicit review policy and team scope, never infers trust from Agent claims', () => {
    validateReviewPolicy({ reviewer_user_id: 2, primary_offer_id: 'offer-1', required_checks: ['unit'] })
    validateSubmission(submission())
    expect(() => validateSubmission({ ...submission(), publish_scope: 'private' } as never)).toThrow('scope')
    expect(() => validateSubmission({ ...submission(), evidence: [{ ...submission().evidence[0], source_kind: 'trusted_ci' }] } as never)).toThrow('trusted evidence')
    expect(() => validateReviewPolicy({ reviewer_user_id: 2, required_checks: [] })).toThrow('primary_offer_id')
  })
  test('rejects mutable/ambiguous identities and unsafe filenames', () => {
    expect(() => validateSubmission({ ...submission(), artifacts: [...submission().artifacts, ...submission().artifacts] })).toThrow('unique')
    expect(() => validateSubmission({ ...submission(), artifacts: [{ ...submission().artifacts[0], name: '../../private.md' }] })).toThrow('path')
    expect(() => validateSubmission({ ...submission(), evidence: [{ ...submission().evidence[0], code_revision: 'other' }] })).toThrow('version mismatch')
    expect(() => validateSubmission({ ...submission(), artifacts: [{ ...submission().artifacts[0], byte_size: 2 ** 30 }] })).toThrow('byte limit')
  })
  test('requires modification reason and prevents duplicate human check confirmation', () => {
    const input = { request_id: 'd', expected_revision: 2, submission_id: '00000000-0000-0000-0000-000000000001', spec_revision: 1, decision: 'changes_requested' as const, reason: '', verified_checks: [] }
    expect(() => validateAcceptance({ ...input, submission_id: 'invalid' })).toThrow('submission ID')
    expect(() => validateAcceptance(input)).toThrow('reason')
    expect(() => validateAcceptance({ ...input, reason: 'more proof', verified_checks: ['unit', 'unit'] })).toThrow('unique')
  })
  test('canonical fingerprints tolerate JSON key order, not changed content', () => {
    expect(stableDigest({ a: 1, b: { x: 3, y: 4 } })).toBe(stableDigest({ b: { y: 4, x: 3 }, a: 1 }))
    expect(stableDigest({ a: 1 })).not.toBe(stableDigest({ a: 2 }))
  })
  test('rollout requires explicit allowlist and leaves default configuration unchanged', () => {
    expect(() => resolveTeamCollaborationConfig({ TEAM_TASK_DELIVERY_V1: 'on', TEAM_COLLABORATION: 'on' })).toThrow('explicit')
    const config = resolveTeamCollaborationConfig({ TEAM_TASK_DELIVERY_V1: 'on', TEAM_COLLABORATION: 'on', TEAM_TASK_DELIVERY_TEAMS: 'team-1' })
    expect(teamDeliveryEnabled(config, 'team-1')).toBe(true)
    expect(teamDeliveryEnabled(config, 'team-2')).toBe(false)
    expect(teamDeliveryEnabled(resolveTeamCollaborationConfig({}), 'team-1')).toBe(false)
  })
})
describe('Delivery HTTP boundaries', () => {
  test('source locks return a retryable unavailable response, not a rejected CAS', async () => {
    const prepare = vi.fn(async () => { throw new TeamRepositoryError('source_busy', 'source is changing') })
    const app = Fastify()
    registerTeamDeliveryRoutes(app, { service: { prepare } as unknown as DeliveryRouteService, verifyAccessToken: async () => ({ userId: 9 }), getDatabaseReady: () => true })
    try {
      const result = await app.inject({ method: 'POST', url: '/api/team/tasks/task-1/delivery/submissions', headers: { authorization: 'Bearer valid' }, payload: submission() })
      expect(result.statusCode).toBe(503)
      expect(result.json()).toEqual({ error: { code: 'source_busy', message: 'source is changing', retryable: true } })
      expect(prepare).toHaveBeenCalledExactlyOnceWith('task-1', 9, submission())
    } finally { await app.close() }
  })
  test('receipt lookup uses authenticated actor and explicit absence without cache', async () => {
    const lookupReceipt = vi.fn(async (task: string, _actor: number, key: string) => ({ task_id: task, request_id: key, found: false, receipt: null }))
    const app = Fastify()
    registerTeamDeliveryRoutes(app, { service: { lookupReceipt } as unknown as DeliveryRouteService, verifyAccessToken: async t => t === 'valid' ? { userId: 9 } : null, getDatabaseReady: () => true })
    try {
      const url = '/api/team/tasks/task-1/delivery/receipt-lookup/key-1'
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
      expect(lookupReceipt).not.toHaveBeenCalled()
      const result = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer valid' } })
      expect(result.statusCode).toBe(200)
      expect(result.headers['cache-control']).toBe('no-store')
      expect(result.json()).toEqual({ task_id: 'task-1', request_id: 'key-1', found: false, receipt: null })
      expect(lookupReceipt).toHaveBeenCalledExactlyOnceWith('task-1', 9, 'key-1')
    } finally { await app.close() }
  })
  test('rejects identity injection, malformed identifiers and non-canonical base64 before service writes', async () => {
    const prepare = vi.fn(), uploadArtifact = vi.fn()
    const app = Fastify()
    registerTeamDeliveryRoutes(app, { service: { prepare, uploadArtifact } as unknown as DeliveryRouteService, verifyAccessToken: async t => t === 'valid' ? { userId: 9 } : null, getDatabaseReady: () => true })
    try {
      const base = '/api/team/tasks/task-1/delivery'
      expect((await app.inject({ method: 'POST', url: `${base}/submissions`, payload: submission() })).statusCode).toBe(401)
      expect((await app.inject({ method: 'POST', url: `${base}/submissions`, headers: { authorization: 'Bearer valid' }, payload: { ...submission(), actor_user_id: 8 } })).statusCode).toBe(400)
      const url = `${base}/submissions/00000000-0000-0000-0000-000000000001/artifacts/report`
      for (const content of ['YW Jj', 'YWJj!', 'YR==', '']) {
        expect((await app.inject({ method: 'PUT', url, headers: { authorization: 'Bearer valid' }, payload: { content_base64: content } })).statusCode).toBe(400)
      }
      expect((await app.inject({ method: 'PUT', url: url.replace('00000000-0000-0000-0000-000000000001', 'invalid'), headers: { authorization: 'Bearer valid' }, payload: { content_base64: 'YWJj' } })).statusCode).toBe(400)
      expect(prepare).not.toHaveBeenCalled(); expect(uploadArtifact).not.toHaveBeenCalled()
    } finally { await app.close() }
  })
})
