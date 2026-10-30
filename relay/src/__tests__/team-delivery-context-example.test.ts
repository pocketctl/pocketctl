import {expect,test,vi} from 'vitest'
import type pg from 'pg'
import {TeamContextDeliveryService} from '../team/context-delivery.js'

test('frozen delivery example covers every required check once with a valid artifact reference',async()=>{
 const query=vi.fn().mockResolvedValueOnce({rows:[{call_id:'call',binding_id:'binding',context_version:0,history_through_event_seq:0,team_session_id:'session',delivery_task_id:'task',delivery_spec_revision:1,required_checks:['Markdown 三项内容正确','JSON 求和正确','两份真实文件已发布'],reviewer_user_id:33}]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{delivery_id:'delivery'}]})
 const result=await new TeamContextDeliveryService({query} as unknown as pg.Pool).prepare('call')
 const spec=JSON.parse(result.stable_text.split('\n')[1])
 const example=spec.delivery_output.example
 expect(example.evidence.map((e:any)=>e.check_id)).toEqual(['Markdown 三项内容正确','JSON 求和正确','两份真实文件已发布'])
 expect(new Set(example.evidence.map((e:any)=>e.check_id)).size).toBe(3)
 for(const evidence of example.evidence){expect(example.artifacts.some((a:any)=>a.id===evidence.artifact_id)).toBe(true);expect(evidence.result).toBe('unverified');expect(evidence.source_kind).toBe('agent_claim')}
})
