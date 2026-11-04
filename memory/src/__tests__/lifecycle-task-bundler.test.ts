import {test,expect} from 'vitest'
import {validateTaskPartition,semanticDisposition} from '../curation/task-bundler.js'
const sources=[{id:'a',text:'Production timeout 60. I prefer trains.'}]
const spaces=['work-a','life']
test('AC-09 multiple_topics_one_source',()=>{
 const result=validateTaskPartition([{space_id:'work-a',task_id:null,spans:[{event_id:'a',start:0,end:22}]},{space_id:'life',task_id:null,spans:[{event_id:'a',start:23,end:39}]}],sources,spaces,[])
 expect(result.ok).toBe(true)
})
test('AC-11 foreign_space',()=>expect(validateTaskPartition([{space_id:'another-owner',task_id:null,spans:[{event_id:'a',start:0,end:10}]}],sources,spaces,[]).ok).toBe(false))
test('AC-10 cross_session_untrusted_task',()=>expect(validateTaskPartition([{space_id:'life',task_id:'foreign-task',spans:[{event_id:'a',start:0,end:10}]}],sources,spaces,[]).ok).toBe(false))
test('AC-13 overlapping_spans',()=>expect(validateTaskPartition([{space_id:'life',task_id:null,spans:[{event_id:'a',start:0,end:10},{event_id:'a',start:5,end:15}]}],sources,spaces,[]).ok).toBe(false))
test('AC-15 semantic_deadline',()=>expect(semanticDisposition('deferred_semantic',new Date('2026-11-10'),new Date('2026-11-10'))).toBe('skipped_unresolved'))
test('AC-15 operational_failure_not_expired',()=>expect(semanticDisposition('blocked',new Date('2026-11-10'),new Date('2026-12-10'))).toBe('blocked'))
test('AC-10 resume cannot move task to another space or reuse it twice',()=>{
 const part={space_id:'life',task_id:'prior',spans:[{event_id:'a',start:0,end:10}]}
 expect(validateTaskPartition([part],sources,spaces,[{id:'prior',space_id:'work-a'}]).ok).toBe(false)
 expect(validateTaskPartition([part,{...part,spans:[{event_id:'a',start:12,end:20}]}],sources,spaces,[{id:'prior',space_id:'life'}]).ok).toBe(false)
})
