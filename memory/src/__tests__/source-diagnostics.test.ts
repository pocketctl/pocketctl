import {test,expect} from 'vitest'
import {SourceUnavailableError} from '@pocketctl/session-source'
import {annotateSourceFailure} from '../sources/diagnostics.js'
import {workerErrorFields} from '../jobs/worker-diagnostics.js'
import {admitLifecycleSources} from '../episodes/source-admission.js'
import {lifecycleSourceEvent as event} from '../testing/lifecycle-fixture.js'

test('source diagnostics retain bounded stage and reason without arbitrary error text',()=>{
 const error=annotateSourceFailure(new SourceUnavailableError('processing_pin_expired_or_unavailable'),'pin_acquire','execution_invalid')
 expect(workerErrorFields(error)).toMatchObject({source_stage:'pin_acquire',source_reason:'execution_invalid'})
 expect(workerErrorFields(annotateSourceFailure(Error('private'),'private' as never,'secret' as never))).not.toHaveProperty('source_reason')
})
test('admission explains absent provenance and missing ancestor without admitting either',()=>{
 const absent={...event('e1','private'),source_provenance:{}}
 const missing=event('e2','private',{invocation_id:'separate',derived_from_event_ids:['absent']})
 const result=admitLifecycleSources({sessionId:'session-1',turnId:'turn-1',events:[absent,missing]})
 expect(result.events).toHaveLength(0)
 expect(result.diagnostics).toEqual({missing_provenance:1,missing_ancestor:1})
 expect(JSON.stringify(result.diagnostics)).not.toContain('private')
})

test('unknown metadata commit is a distinct bounded diagnostic, not a generic failure',async()=>{
 const {SelectedSourceTransactionUnavailable}=await import('../sources/processing-pins.js')
 expect(workerErrorFields(new SelectedSourceTransactionUnavailable('unknown'))).toMatchObject({code:'source_metadata_commit_outcome_unknown'})
})
