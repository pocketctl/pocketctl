import {describe,expect,test} from 'vitest'
import {logicalIdentity,logicalIdentitySchema} from '../claims/logical-identity.js'
const base={installationId:'11111111-1111-4111-8111-111111111111',spaceId:'22222222-2222-4222-8222-222222222222',subjectEntityId:'33333333-3333-4333-8333-333333333333',predicateId:'service.default_timeout',variant:{environment:'production'},cardinality:'single' as const}
describe('stable logical identity',()=>{
 test('answer cannot enter identity',()=>{
  expect(logicalIdentity({...base})).toEqual(logicalIdentity({...base,variant:{environment:'production'}}))
  expect(()=>logicalIdentitySchema.parse({...base,value:60})).toThrow()
 })
 test('canonical ordering preserves scope and case',()=>{
  expect(logicalIdentity({...base,variant:{b:'x',a:'y'}})).toBe(logicalIdentity({...base,variant:{a:'y',b:'x'}}))
  for(const changes of [{installationId:base.subjectEntityId},{spaceId:base.subjectEntityId},{subjectEntityId:base.spaceId},{predicateId:'service.retry_limit'},{variant:{environment:'test'}},{variant:{environment:'Production'}}])expect(logicalIdentity({...base,...changes})).not.toBe(logicalIdentity(base))
 })
 test('set members and events require distinct member identity',()=>{
  expect(()=>logicalIdentity({...base,cardinality:'event'})).toThrow()
  expect(()=>logicalIdentity({...base,cardinality:'set'})).toThrow()
  expect(()=>logicalIdentity({...base,memberKey:'unexpected'})).toThrow()
  expect(logicalIdentity({...base,cardinality:'event',memberKey:'trip-1'})).not.toBe(logicalIdentity({...base,cardinality:'event',memberKey:'trip-2'}))
 })
 test('unknown identities and prototype keys fail closed',()=>{
  expect(()=>logicalIdentity({...base,subjectEntityId:''})).toThrow()
  expect(()=>logicalIdentity({...base,predicateId:'默认超时'})).toThrow()
  expect(()=>logicalIdentity({...base,variant:JSON.parse('{"__proto__":"x"}')})).toThrow()
 })
})
