import {expect,test,vi} from 'vitest'
import {extractConclusions} from '../curation/conclusion-extractor.js'
import type {TextGenerator} from '../ports/text-generator.js'
const task=(spans:unknown[])=>({space_id:null,task_id:null,spans,conclusions:[]})
async function run(text:string,tasks:unknown[]){
 const generateJson=vi.fn(async()=>({ok:true,value:{tasks},usage:{inputTokens:1,outputTokens:1,model:'test'}}))
 const result=await extractConclusions({generateJson} as TextGenerator,{sources:[{id:'e1',text,role:'user'}],spaces:[],tasks:[],requestKey:'test',signal:new AbortController().signal,now:new Date('2026-11-04')})
 return {result,request:generateJson.mock.calls[0] as unknown as [{schema:unknown;system:string}]}
}
test('literal quotes resolve Unicode offsets deterministically',async()=>{
 const text='开头😀。API timeout is 30 seconds.结束。',quote='API timeout is 30 seconds.'
 const {result,request}=await run(text,[task([{event_id:'e1',quote}])]);expect(result.ok).toBe(true)
 if(result.ok)expect(result.tasks[0].spans).toEqual([{event_id:'e1',start:text.indexOf(quote),end:text.indexOf(quote)+quote.length}])
 expect(JSON.stringify(request[0].schema)).toContain('quote');expect(JSON.stringify(request[0].schema)).not.toContain('"start"')
})
test.each(['invented','same',''])('rejects absent, ambiguous or empty quote %s',async quote=>{
 expect((await run('same same',[task([{event_id:'e1',quote}])])).result.ok).toBe(false)
})
test('rejects overlapping literal partitions',async()=>{
 expect((await run('abcdef',[task([{event_id:'e1',quote:'abcd'}]),task([{event_id:'e1',quote:'cdef'}])])).result.ok).toBe(false)
})
test('accepts disjoint partitions from a single source',async()=>{
 expect((await run('alpha beta',[task([{event_id:'e1',quote:'alpha'}]),task([{event_id:'e1',quote:'beta'}])])).result.ok).toBe(true)
})
test('never clamps an invalid legacy numeric span',async()=>{
 expect((await run('API timeout is 30 seconds.',[task([{event_id:'e1',start:0,end:99}])])).result.ok).toBe(false)
})
test('cannot use a quote from a different event',async()=>{
 expect((await run('alpha',[task([{event_id:'foreign',quote:'alpha'}])])).result.ok).toBe(false)
})
