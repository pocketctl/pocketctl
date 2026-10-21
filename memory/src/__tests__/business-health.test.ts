import {expect,test} from 'vitest'
import {evaluateBusinessHealth} from '../reporting/business-health.js'
const healthy={installation_id:'i',local_status:'ready',relay_status:'active',feed_enabled:true,feed_lag_seconds:0,extraction_mode:'enabled',budget_deferred:0,oldest_extract_seconds:null,last_extract_seconds:null,evidence_gaps:0,last_error_code:null}
test('idle and successful empty polling stay healthy',()=>expect(evaluateBusinessHealth(healthy).state).toBe('ready'))
test('bounded reasons cover stalled feed, budget, extraction and evidence gaps',()=>expect(evaluateBusinessHealth({...healthy,feed_lag_seconds:301,budget_deferred:2,oldest_extract_seconds:3601,evidence_gaps:1}).reasons).toEqual(['feed_stalled','budget_blocked','extraction_stalled','evidence_gap']))
test('recent successful extraction avoids no-output alarm',()=>expect(evaluateBusinessHealth({...healthy,oldest_extract_seconds:4000,last_extract_seconds:10}).reasons).toEqual([]))
test('paused, revoking and disabled installations ignore work alarms',()=>{for(const relay_status of ['paused','revoking'])expect(evaluateBusinessHealth({...healthy,relay_status,feed_lag_seconds:500,budget_deferred:1,oldest_extract_seconds:4000}).reasons).toEqual([]);expect(evaluateBusinessHealth({...healthy,feed_enabled:false,extraction_mode:'off',feed_lag_seconds:500,budget_deferred:1,oldest_extract_seconds:4000}).reasons).toEqual([])})
test('integrity failure keeps priority and recovered input clears reasons',()=>{expect(evaluateBusinessHealth({...healthy,local_status:'integrity_error',last_error_code:'hash_mismatch',feed_lag_seconds:500})).toMatchObject({state:'error',primaryError:'hash_mismatch'});expect(evaluateBusinessHealth({...healthy,feed_lag_seconds:301}).state).toBe('degraded');expect(evaluateBusinessHealth(healthy).reasons).toEqual([])})

test('current failed packets alert independently of successful work elsewhere',()=>{
 expect(evaluateBusinessHealth({...healthy,last_extract_seconds:1,unresolved_extractions:1}).reasons).toEqual(['extraction_failed'])
 expect(evaluateBusinessHealth({...healthy,last_extract_seconds:1,unresolved_extractions:0,failed_extractions_24h:9}).reasons).toEqual([])
 expect(evaluateBusinessHealth({...healthy,extraction_mode:'off',unresolved_extractions:1}).reasons).toEqual([])
})
