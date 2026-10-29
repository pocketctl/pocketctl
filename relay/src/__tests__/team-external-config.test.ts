import { expect, test } from 'vitest'
import { resolveTeamCollaborationConfig, teamExternalExecutorEnabled } from '../team/config.js'

test('AgentTeams requires a separate explicit subset of delivery Teams and strict default-off switch', () => {
  expect(teamExternalExecutorEnabled(resolveTeamCollaborationConfig({}), 'a')).toBe(false)
  const base = { TEAM_COLLABORATION: 'on', TEAM_TASK_DELIVERY_V1: 'on', TEAM_TASK_DELIVERY_TEAMS: 'a,b', TEAM_EXTERNAL_EXECUTOR_V1: 'on', TEAM_EXTERNAL_EXECUTOR_TEAMS: 'a' }
  const config = resolveTeamCollaborationConfig(base)
  expect(teamExternalExecutorEnabled(config, 'a')).toBe(true)
  expect(teamExternalExecutorEnabled(config, 'b')).toBe(false)
  for (const override of [
    { TEAM_EXTERNAL_EXECUTOR_V1: 'true' }, { TEAM_EXTERNAL_EXECUTOR_TEAMS: '' },
    { TEAM_EXTERNAL_EXECUTOR_TEAMS: 'outside' }, { TEAM_TASK_DELIVERY_V1: 'off' },
  ]) expect(() => resolveTeamCollaborationConfig({ ...base, ...override })).toThrow('TEAM_EXTERNAL_EXECUTOR')
})
