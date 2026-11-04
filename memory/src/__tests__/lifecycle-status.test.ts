import {describe,expect,test,vi} from 'vitest'
import type pg from 'pg'
import {lifecycleReason,lifecycleStatus,LIFECYCLE_REASONS} from '../curation/status.js'

describe('lifecycle diagnostics',()=>{
  test('AC-47 closed_reason_vocabulary',()=>{
    for(const value of ['owner-123','/private/project/file','Bearer credential-canary','{"statement":"secret"}',...Array.from({length:1000},(_,i)=>`owner-${i}`)])expect(lifecycleReason(value)).toBe('unknown')
    for(const value of LIFECYCLE_REASONS)expect(lifecycleReason(value)).toBe(value)
    expect(lifecycleReason(null)).toBe('none')
  })
  test('AC-46 bounded_failure_zero_result_and_blocked_diagnostics',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{mode:'enabled',consume_mode:'enabled',cold_mode:'enabled',reclaim_mode:'enabled',owner_scope_kind:'personal',revision:'2'}]})
      .mockResolvedValueOnce({rows:[{key:'blocked',count:'2'},{key:'failed',count:'3'}]})
      .mockResolvedValueOnce({rows:[{key:'provider_result_unknown',count:'1'}]})
      .mockResolvedValueOnce({rows:[{key:'skip',count:'4'}]})
      .mockResolvedValueOnce({rows:[{key:'no_durable_conclusion',count:'5'},{key:'provenance_unknown',count:'6'}]})
      .mockResolvedValueOnce({rows:[{seconds:320}]}).mockResolvedValueOnce({rows:[{input_tokens:'10',output_tokens:'20'}]})
      .mockResolvedValueOnce({rows:[{job_type:'record_context_delivery',state:'dead',count:'2',oldest_seconds:null}]})
      .mockResolvedValueOnce({rows:[{key:'value_unsupported',count:'3'},{key:'secret-rejection',count:'2'}]})
      .mockResolvedValueOnce({rows:[{key:'provider_result_unknown',count:'1',input_tokens:'8',output_tokens:'2'}]})
      .mockResolvedValueOnce({rows:Array.from({length:51},(_,i)=>({bundle_id:`id-${i}`,state:'blocked',reason_code:'secret-canary',run_reason:'provider secret',decision_reason:'private/owner/path'}))})
    const result=await lifecycleStatus({query} as unknown as pg.Pool,'installation','shadow')
    expect(result).toMatchObject({mode:'shadow',consume_mode:'shadow',cold_mode:'shadow',reclaim_mode:'shadow',bundles:{blocked:2,failed:3,completed:0},runs:{provider_result_unknown:1},receipts:{no_durable_conclusion:5,provenance_unknown:6},has_more:true})
    expect(result.stage_jobs).toEqual([{stage:'record_context_delivery',state:'dead',count:2,oldest_seconds:null}])
    expect(result.validation_rejections).toEqual({value_unsupported:3,unknown:2})
    expect(result).toMatchObject({assessments:{provider_result_unknown:1},assessment_usage:{input_tokens:8,output_tokens:2},usage:{input_tokens:18,output_tokens:22}})
    expect(result.records).toHaveLength(50)
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('private/owner')
    for(const call of query.mock.calls)expect(call[1]).toEqual(['installation'])
  })
  test('AC-48 global_off_wins_over_owner_policy',async()=>{
    const query=vi.fn().mockImplementation(async(sql:string)=>({rows:sql.includes('owner_scope_kind')?[{mode:'enabled',consume_mode:'enabled',cold_mode:'enabled',reclaim_mode:'enabled',owner_scope_kind:'personal'}]:[]}))
    expect(await lifecycleStatus({query} as unknown as pg.Pool,'installation')).toMatchObject({mode:'off',consume_mode:'off',cold_mode:'off',reclaim_mode:'off'})
  })
})

test('AC-42 machine authority compatibility never becomes human approved',async()=>{
 const {versionAuthorityCompatibility}=await import('../claims/types.js')
 expect(versionAuthorityCompatibility('machine_concluded')).toEqual({recognized:true,human_approved:false})
 expect(versionAuthorityCompatibility('future_machine')).toEqual({recognized:false,human_approved:false})
 expect(versionAuthorityCompatibility('user_corrected')).toEqual({recognized:true,human_approved:true})
})
