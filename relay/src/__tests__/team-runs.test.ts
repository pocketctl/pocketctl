import Fastify from 'fastify'
import { describe, expect, test, vi } from 'vitest'

import { resolveTeamCollaborationConfig } from '../team/config.js'
import { parseTeamRunDecision, TeamRunDecisionError } from '../team/run-decision.js'
import { registerTeamRunRoutes } from '../team/run-routes.js'
import { normalizeTeamRunBudget, type TeamRunService } from '../team/run-service.js'
import { TeamRunWorker } from '../team/run-worker.js'
import type { TeamEvent, TeamRun } from '../team/types.js'

const run: TeamRun = {
  id: 'crn_1', team_session_id: 'css_1', initiator_user_id: 7, coordinator_offer_id: 'cao_coordinator',
  context_version: 3, state: 'running', stop_requested: false,
  budget: { max_calls: 12, max_concurrent_calls: 2, max_duration_seconds: 1_800 },
  calls_used: 1, next_step: 2, processed_call_step: 0, revision: 2,
  waiting_question: null, terminal_reason: null, started_at: '2026-09-25T00:00:00.000Z',
  deadline_at: '2099-09-25T00:00:00.000Z', finished_at: null,
  created_at: '2026-09-25T00:00:00.000Z', updated_at: '2026-09-25T00:00:00.000Z',
}

const event: TeamEvent = {
  id: 'cev_1', team_session_id: 'css_1', event_seq: 1, kind: 'run', author_user_id: null,
  author_offer_id: null, target_mode: null, target_offer_ids: [], reference: null,
  context_version: 3, call_id: null, content: 'state changed', created_at: '2026-09-25T00:00:00.000Z',
}

function workerRepository(snapshot: Record<string, unknown>) {
  return {
    claimNext: vi.fn(async () => ({ run, leaseToken: 4 })),
    loadWork: vi.fn(async () => snapshot),
    scheduleCall: vi.fn(async () => ({ callId: 'ccl_2', teamSessionId: 'css_1', event, participantUserIds: [7] })),
    transition: vi.fn(async (input: { state: TeamRun['state']; terminalReason?: string }) => ({
      run: { ...run, state: input.state, terminal_reason: input.terminalReason ?? null }, event, participantUserIds: [7],
    })),
    cancelPending: vi.fn(async () => 0),
    defer: vi.fn(async () => undefined),
  }
}

describe('Team automatic collaboration', () => {
  test('accepts only strict coordinator decisions for the frozen context and allowed offers', () => {
    expect(parseTeamRunDecision('```json\n{"action":"call_agent","context_version":3,"target_offer_id":"cao_worker","instruction":"Inspect logs"}\n```', {
      contextVersion: 3, allowedOfferIds: new Set(['cao_worker']),
    })).toMatchObject({ action: 'call_agent', target_offer_id: 'cao_worker' })
    expect(() => parseTeamRunDecision('{"action":"call_agent","context_version":3,"target_offer_id":"cao_other","instruction":"go"}', {
      contextVersion: 3, allowedOfferIds: new Set(['cao_worker']),
    })).toThrow(TeamRunDecisionError)
    expect(() => parseTeamRunDecision('{"action":"complete","context_version":2,"summary":"done"}', {
      contextVersion: 3, allowedOfferIds: new Set(),
    })).toThrow(/context version/)
    expect(() => parseTeamRunDecision('{"action":"complete","context_version":3,"summary":"done","user_id":9}', {
      contextVersion: 3, allowedOfferIds: new Set(),
    })).toThrow(/fields/)
  })

  test('freezes bounded defaults and rejects unbounded client budgets', () => {
    expect(normalizeTeamRunBudget()).toEqual({ max_calls: 12, max_concurrent_calls: 2, max_duration_seconds: 1_800 })
    expect(normalizeTeamRunBudget({ max_calls: 4, max_concurrent_calls: 1 })).toEqual({
      max_calls: 4, max_concurrent_calls: 1, max_duration_seconds: 1_800,
    })
    expect(() => normalizeTeamRunBudget({ max_calls: 101 })).toThrow(/max_calls/)
    expect(() => normalizeTeamRunBudget({ max_calls: 1, max_concurrent_calls: 2 })).toThrow(/cannot exceed/)
  })

  test('uses a completed coordinator decision to finish without triggering another Agent', async () => {
    const repository = workerRepository({
      run,
      bindings: [{ bindingId: 'cab_1', offerId: 'cao_coordinator', callable: true }],
      latestCall: {
        callId: 'ccl_1', runStep: 1, runRole: 'coordinator', offerId: 'cao_coordinator', state: 'completed',
        outcome: 'completed', response: '{"action":"complete","context_version":3,"summary":"Final synthesis"}',
      },
      latestMemberInput: null,
    })
    await new TeamRunWorker({ repository: repository as any, workerId: 'worker-1' }).runOnce()
    expect(repository.scheduleCall).not.toHaveBeenCalled()
    expect(repository.transition).toHaveBeenCalledWith(expect.objectContaining({
      state: 'completed', terminalReason: 'coordinator_completed', processedCallStep: 1, content: 'Final synthesis',
    }))
  })

  test('routes only to an allowed cross-provider Agent and can request participant input', async () => {
    const routed = workerRepository({
      run,
      bindings: [
        { bindingId: 'cab_1', offerId: 'cao_coordinator', callable: true },
        { bindingId: 'cab_2', offerId: 'cao_claude_worker', callable: true },
      ],
      latestCall: {
        callId: 'ccl_1', runStep: 1, runRole: 'coordinator', offerId: 'cao_coordinator', state: 'completed',
        outcome: 'completed', response: '{"action":"call_agent","context_version":3,"target_offer_id":"cao_claude_worker","instruction":"Verify independently"}',
      },
      latestMemberInput: null,
    })
    await new TeamRunWorker({ repository: routed as any, workerId: 'worker-1' }).runOnce()
    expect(routed.scheduleCall).toHaveBeenCalledWith(expect.objectContaining({
      offerId: 'cao_claude_worker', role: 'worker', content: 'Verify independently', processedCallStep: 1,
    }))

    const waiting = workerRepository({
      run,
      bindings: [{ bindingId: 'cab_1', offerId: 'cao_coordinator', callable: true }],
      latestCall: {
        callId: 'ccl_1', runStep: 1, runRole: 'coordinator', offerId: 'cao_coordinator', state: 'completed',
        outcome: 'completed', response: '{"action":"request_input","context_version":3,"question":"Which environment?"}',
      },
      latestMemberInput: null,
    })
    await new TeamRunWorker({ repository: waiting as any, workerId: 'worker-2' }).runOnce()
    expect(waiting.transition).toHaveBeenCalledWith(expect.objectContaining({
      state: 'waiting_input', waitingQuestion: 'Which environment?', processedCallStep: 1,
    }))
  })

  test('blocks unknown outcomes and an unavailable coordinator without retries or replacement', async () => {
    const uncertain = workerRepository({
      run,
      bindings: [{ bindingId: 'cab_1', offerId: 'cao_coordinator', callable: true }],
      latestCall: { callId: 'ccl_1', runStep: 1, runRole: 'coordinator', offerId: 'cao_coordinator', state: 'uncertain', outcome: 'dispatch_timeout', response: null },
      latestMemberInput: null,
    })
    await new TeamRunWorker({ repository: uncertain as any, workerId: 'worker-1' }).runOnce()
    expect(uncertain.scheduleCall).not.toHaveBeenCalled()
    expect(uncertain.transition).toHaveBeenCalledWith(expect.objectContaining({ state: 'blocked', terminalReason: 'dispatch_uncertain' }))

    const offline = workerRepository({
      run,
      bindings: [
        { bindingId: 'cab_1', offerId: 'cao_coordinator', callable: false },
        { bindingId: 'cab_2', offerId: 'cao_worker', callable: true },
      ],
      latestCall: null,
      latestMemberInput: null,
    })
    await new TeamRunWorker({ repository: offline as any, workerId: 'worker-2' }).runOnce()
    expect(offline.scheduleCall).not.toHaveBeenCalled()
    expect(offline.transition).toHaveBeenCalledWith(expect.objectContaining({ state: 'blocked', terminalReason: 'coordinator_unavailable' }))
  })

  test('keeps automatic collaboration routes disabled unless TEAM_AUTORUN is on', async () => {
    const create = vi.fn()
    const app = Fastify()
    registerTeamRunRoutes(app, {
      config: resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'on' }),
      service: { create } as unknown as TeamRunService,
      verifyAccessToken: async () => ({ userId: 7 }),
      getDatabaseReady: () => true,
    })
    const response = await app.inject({
      method: 'POST', url: '/api/team/sessions/css_1/runs', headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'run-create', coordinator_offer_id: 'cao_1', context_version: 1 },
    })
    expect(response.statusCode).toBe(503)
    expect(create).not.toHaveBeenCalled()
    await app.close()
  })
})
