import {test,expect} from 'vitest'
import {syntheticConclusionRejections} from '../eval/lifecycle-model-diagnostics.js'
const source={id:'e1',text:'I prefer trains for personal travel.',role:'user'}
const conclusion={kind:'preference',assertion_mode:'user_asserted',subject:'self',predicate:'travel.transport',value:'trains',conditions:{},fact_at:null,valid_until:null,statement:'self prefers trains for personal travel.',confirmed:true,evidence:{subject:['e1'],predicate:['e1'],value:['e1']}}
const task={space_id:null,task_id:null,spans:[{event_id:'e1',start:0,end:36}],conclusions:[conclusion]}
test('AC-13 synthetic rejection preserves exact statement source and span',()=>{
 const result=syntheticConclusionRejections({sources:[source]},{tasks:[task]})
 expect(result).toEqual([{task_index:0,conclusion_index:0,reason:'statement_unsupported',statement:'self prefers trains for personal travel.',sources:[source],spans:task.spans}])
})
test('AC-13 synthetic diagnostics exclude accepted conclusions and nonfixture sources',()=>{
 expect(syntheticConclusionRejections({sources:[source]},{tasks:[{...task,conclusions:[{...conclusion,statement:source.text}]}]})).toEqual([])
 expect(syntheticConclusionRejections({sources:[{...source,text:'private user data'}]},{tasks:[task]})).toEqual([])
 expect(syntheticConclusionRejections({sources:[{...source,role:'assistant'}]},{tasks:[task]})).toEqual([])
})
test('AC-13 synthetic rejected diagnostics are bounded and schema checked',()=>{
 expect(syntheticConclusionRejections({sources:[source]},{tasks:Array.from({length:100},()=>({...task,conclusions:Array.from({length:100},()=>conclusion)}))})).toHaveLength(64)
 expect(syntheticConclusionRejections({sources:[source]},{tasks:[{...task,conclusions:[{...conclusion,statement:'x'.repeat(4001)}]}]})).toEqual([])
 expect(syntheticConclusionRejections({sources:[source]},{tasks:[{...task,spans:[{event_id:'e1',start:0,end:999}]}]})).toEqual([])
})
