import { describe, expect, test } from 'vitest'
import { evaluateLifecycle } from '../session-lifecycle/policy.js'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'
import type { LifecycleInput } from '../session-lifecycle/types.js'

const config = sessionLifecycleConfig({ SESSION_LIFECYCLE_MODE: 'observe' })
const session: LifecycleInput = {
  ownerUserId: 1,
  scope: 'personal',
  activityVerified: true,
  activityAt: '2026-01-01T00:00:00.000000Z',
  status: 'exited',
  archiveReason: null,
  contentState: 'hot',
  blockers: [],
}
describe('session lifecycle policy', () => {
  test.each([
    ['2026-03-12T00:00:00Z', null, false],
    ['2026-03-12T00:00:00Z', 'manual', true],
    ['2026-06-01T00:00:00Z', null, true],
  ] as const)('demo scope is excluded before activity validation at %s (%s, %s)', (now, archiveReason, activityVerified) => {
    expect(evaluateLifecycle({ ...session, scope: 'demo', archiveReason, activityVerified }, now, config))
      .toMatchObject({ action: null, archiveAt: null, purgeAt: null, blockedReasons: ['demo_excluded'] })
  })
  test.each([
    ['2026-03-02T00:00:00.000000Z', null],
    ['2026-03-02T00:00:00.000001Z', 'archive'],
    ['2026-04-01T00:00:00.000000Z', 'archive'],
    ['2026-04-01T00:00:00.000001Z', 'purge'],
  ])('strict microsecond threshold %s', (now, action) => {
    expect(evaluateLifecycle(session, now, config).action).toBe(action)
  })
  test('manual archive and pin do not extend retention or change archive intent', () => {
    expect(
      evaluateLifecycle(
        { ...session, archiveReason: 'manual', pinned: true },
        '2026-03-02T00:00:00.000001Z',
        config,
      ).action,
    ).toBe('cool')
    expect(
      evaluateLifecycle(
        { ...session, archiveReason: 'manual', pinned: true },
        '2026-04-01T00:00:00.000001Z',
        config,
      ).action,
    ).toBe('purge')
  })
  test('cold archived history is stable; mixed history resumes remaining hot bodies', () => {
    for (const contentState of ['cold', 'mixed'] as const) {
      expect(
        evaluateLifecycle(
          { ...session, archiveReason: 'inactivity', contentState },
          '2026-03-03T00:00:00Z',
          config,
        ).action,
      ).toBe(contentState==='mixed'?'cool':null)
    }
  })
  test.each([
    [{ activityAt: null }, 'activity_unknown'],
    [{ activityVerified: false }, 'activity_unverified'],
    [{ activityAt: '2026-12-01T00:00:00Z' }, 'activity_future'],
    [{ activityAt: '2026-02-30T00:00:00Z' }, 'activity_invalid'],
    [{ ownerUserId: null }, 'owner_unknown'],
    [{ scope: 'team' }, 'scope_excluded'],
    [{ scope: 'unknown' }, 'scope_excluded'],
    [{ status: 'unrecognized' }, 'status_unknown'],
    [{ status: 'running' }, 'session_active'],
    [{ contentState: 'deleting' }, 'session_deleting'],
  ])('blocks unsafe input %j', (changes, reason) => {
    const result = evaluateLifecycle(
      { ...session, ...changes } as LifecycleInput,
      '2026-06-01T00:00:00Z',
      config,
    )
    expect(result.action).toBeNull()
    expect(result.blockedReasons).toContain(reason)
  })
  test('max activity in the dependency closure protects an old root', () => {
    expect(
      evaluateLifecycle(
        { ...session, dependencyActivityAt: ['2026-05-31T00:00:00Z'] },
        '2026-06-01T00:00:00Z',
        config,
      ).action,
    ).toBeNull()
    expect(
      evaluateLifecycle(
        { ...session, dependencyActivityAt: [null] },
        '2026-06-01T00:00:00Z',
        config,
      ).blockedReasons,
    ).toContain('activity_unknown')
  })
  test('protection blocks even when overdue', () => {
    const blockers = [
      'admission_pending',
      'outbox_pending',
      'dependency_unknown',
    ] as const
    expect(
      evaluateLifecycle(
        { ...session, blockers: [...blockers] },
        '2026-06-01T00:00:00Z',
        config,
      ),
    ).toMatchObject({ action: null, blockedReasons: [...blockers] })
  })
  test('history transition and policy effective dates constrain the actual purge time', () => {
    const policy = sessionLifecycleConfig({
      SESSION_LIFECYCLE_MODE: 'observe',
      SESSION_LIFECYCLE_EFFECTIVE_AT: '2026-04-01T00:00:00Z',
      SESSION_LIFECYCLE_TRANSITION_DEADLINE: '2026-05-01T00:00:00Z',
    })
    expect(
      evaluateLifecycle(
        { ...session, historical: true },
        '2026-05-01T00:00:00Z',
        policy,
      ),
    ).toMatchObject({
      action: 'archive',
      purgeAt: '2026-05-01T00:00:00.000000Z',
    })
    expect(
      evaluateLifecycle(
        { ...session, historical: true },
        '2026-05-01T00:00:00.000001Z',
        policy,
      ).action,
    ).toBe('purge')
    expect(
      evaluateLifecycle(session, '2026-03-31T00:00:00Z', policy).blockedReasons,
    ).toContain('policy_not_effective')
  })
  test('timezone offsets give the same precise result', () => {
    expect(
      evaluateLifecycle(session, '2026-03-02T08:00:00.000001+08:00', config)
        .action,
    ).toBe('archive')
  })
  test('explicit off has no predicted action', () => {
    expect(
      evaluateLifecycle(
        session,
        '2026-06-01T00:00:00Z',
        sessionLifecycleConfig({SESSION_LIFECYCLE_MODE:'off'}),
      ),
    ).toMatchObject({ action: null, blockedReasons: ['policy_disabled'] })
  })
})
