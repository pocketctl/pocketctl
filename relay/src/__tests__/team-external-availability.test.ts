import {describe,expect,test} from 'vitest'
import {candidateForProvider} from '../team/agent-offers.js'
import {resolveTeamCollaborationConfig,teamExternalExecutorEnabled} from '../team/config.js'
const daemon={daemon_id:'external',hostname:'local',status:'online',agents:[{type:'agentteams',manageable:true},{type:'claude-code',manageable:true}],collaboration_capabilities:['team_collaboration_dispatch_v1','team_collaboration_context_v1','team_external_agentteams_v1']}
describe('external availability respects the Relay gate',()=>{
 test('daemon installation alone cannot advertise a callable external executor',()=>{
  expect(candidateForProvider(daemon,'agentteams','allowed')).toMatchObject({installed:true,online:true,dispatch_supported:false,managed_callable:false,availability:'unsupported'})
 })
 test('enabled only for the exact delivery and external allowlist intersection',()=>{
  const config=resolveTeamCollaborationConfig({TEAM_COLLABORATION:'on',TEAM_TASK_DELIVERY_V1:'on',TEAM_TASK_DELIVERY_TEAMS:'allowed',TEAM_EXTERNAL_EXECUTOR_V1:'on',TEAM_EXTERNAL_EXECUTOR_TEAMS:'allowed'})
  for(const team of ['allowed','other','']){
   const enabled=teamExternalExecutorEnabled(config,team)
   expect(candidateForProvider(daemon,'agentteams',team,enabled)).toMatchObject({managed_callable:team==='allowed',availability:team==='allowed'?'online':'unsupported'})
  }
 })
 test('external gate does not disable a native provider',()=>{
  expect(candidateForProvider(daemon,'claude-code','allowed',false)).toMatchObject({managed_callable:true,availability:'online'})
 })
})
