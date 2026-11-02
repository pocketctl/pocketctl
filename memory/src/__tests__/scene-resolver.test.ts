import {describe,expect,test} from 'vitest'
import {selectScene,type SceneSpace} from '../context/scene-resolver.js'
const spaces:SceneSpace[]=[{spaceId:'oss',domain:'personal_project',destinations:['personal'],repositoryKeys:['git:oss']},{spaceId:'job',domain:'work',destinations:['work'],repositoryKeys:['git:job']},{spaceId:'trip',domain:'life',destinations:['personal'],repositoryKeys:[]}]
describe('routing over server-authorized spaces',()=>{
 test('explicit topic switch overrides stale repository',()=>expect(selectScene({spaces,destination:'personal',explicitSpaceId:'trip',repositoryKey:'git:oss'})).toEqual({status:'resolved',spaceId:'trip',reason:'explicit'}))
 test('invalid explicit scope never falls back',()=>{
  for(const explicitSpaceId of ['job','missing'])expect(selectScene({spaces,destination:'personal',explicitSpaceId,repositoryKey:'git:oss'}).status).toBe('unresolved')
 })
 test('ambiguous repository needs disambiguation',()=>expect(selectScene({spaces:[...spaces,{...spaces[0],spaceId:'fork'}],destination:'personal',repositoryKey:'git:oss'}).status).toBe('unresolved'))
 test('unknown never means global',()=>expect(selectScene({spaces,destination:'personal'}).status).toBe('unresolved'))
 test('destination filters before matching repository',()=>{
  expect(selectScene({spaces,destination:'personal',repositoryKey:'git:oss'}).spaceId).toBe('oss')
  expect(selectScene({spaces,destination:'personal',repositoryKey:'git:job'}).status).toBe('unresolved')
 })
})
