import {describe,test,expect,vi} from 'vitest'
import {sessionTransportConsumerPolicyEnabled} from '../shared-source/headers.js'
import {readSessionTransportConsumerPolicy} from '../shared-source/consumer-policy.js'
import {createExtensionJournalSinkFromEnv} from '../extensions/journal.js'
describe('explicit versioned Session transport policy',()=>{
 test('legacy stays the default and policy requires the existing native headers contract',()=>{
  expect(sessionTransportConsumerPolicyEnabled({})).toBe(false)
  expect(()=>sessionTransportConsumerPolicyEnabled({RELAY_SHARED_SESSION_TRANSPORT:'consumer-policy-v1'})).toThrow('shared_session_transport_headers_required')
  expect(sessionTransportConsumerPolicyEnabled({RELAY_SHARED_SOURCE_HEADERS:'enabled',RELAY_SHARED_SESSION_TRANSPORT:'consumer-policy-v1'})).toBe(true)
  expect(()=>sessionTransportConsumerPolicyEnabled({RELAY_SHARED_SESSION_TRANSPORT:'future'})).toThrow('invalid_shared_session_transport_mode')
  expect(createExtensionJournalSinkFromEnv({RELAY_EXTENSIONS:'enabled',RELAY_SHARED_SOURCE_HEADERS:'enabled',RELAY_SHARED_SESSION_TRANSPORT:'consumer-policy-v1'})).not.toBeNull()
 })
 test.each([{version:2,revision:'1',bodyRequired:false,scope:'retired-personal'},{version:1,revision:'0',bodyRequired:false,scope:'retired-personal'},{version:1,revision:'1',scope:'retired-personal'},{version:1,revision:'1',bodyRequired:false,scope:'unknown'}])('unknown or incomplete decisions cannot silently suppress bodies',async policy=>{
  await expect(readSessionTransportConsumerPolicy({query:vi.fn(async()=>({rows:[{policy}]}))} as never,3)).rejects.toThrow('invalid_session_transport_consumer_policy')
 })
})
