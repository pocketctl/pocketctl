import {describe,test,expect,beforeAll} from 'vitest'
import {randomUUID} from 'node:crypto'
import {task8ConsumerFixture} from './task8-team-semantic-consumer-fixture.js'
import {task8ConsumerFixFixture} from './task8-team-semantic-consumer-fix-fixture.js'
import {prepareCanonicalReferencePage,persistCanonicalReferencePage} from '../../sources/canonical-references.js'
import {discoverTeamSemanticGroup} from '../../sources/team-semantic-discovery.js'
import {collectTeamSemanticLegacyAudit} from '../../sources/team-semantic-legacy-audit.js'
import {prepareSourceReferences} from '../../sources/prepared-sources.js'
import {assertTeamSemanticLegacyFunction} from '../../migrations/shared-db/team-semantic-contract.js'
import {teamSemanticOriginalExecution} from '../../sources/source-execution.js'
import {prepareTeamSemanticPublication,persistTeamSemanticPublication} from '../../sources/team-semantic-publication.js'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
suite('Task8 immutable legacy Team business disposition',()=>{
 beforeAll(async()=>{if(process.env.TASK8_S15_FRESH_FIXTURE==='1'){if(!value)throw Error('explicit_task8_fixture_required');const f=await task8ConsumerFixture(JSON.parse(value));await f.close()}},30000)
 async function setup(){
  if(!value)throw Error('explicit_task8_fixture_required')
  const f=await task8ConsumerFixFixture(JSON.parse(value)),g=await f.group()
  await f.sealAll(g.installation,[g.root])
  await f.execution(g.installation,async()=>{for(const c of (await f.scopes(g.installation,g.root)).filter(c=>c.state==='current')){
   const page=await prepareCanonicalReferencePage(f.runtime,c.scope,g.root,{limit:64})
   await persistCanonicalReferencePage(f.runtime,page,{project:true,checkpoint:true,stabilizationMs:0})
  }})
  const raw=(await f.runtime.query("SELECT source_event_id,session_id,turn_id,source_provenance,payload_hash FROM source_events WHERE installation_id=$1 AND source_kind='team_collaboration' ORDER BY source_event_id",[g.installation])).rows
  expect(raw).toHaveLength(6)
  return {f,g,raw}
 }
 async function publish(f:Awaited<ReturnType<typeof task8ConsumerFixFixture>>,g:any){
  return f.execution(g.installation,async()=>{
   const page=await prepareTeamSemanticPublication(f.runtime,g.installation,g.root)
   expect(page).toBeTruthy();await persistTeamSemanticPublication(f.runtime,page!,0)
   return (await f.runtime.query('SELECT * FROM memory_team_semantic_publications WHERE installation_id=$1',[g.installation])).rows[0]
  })
 }
 for(const state of ['turn','paid_unknown','accepted_purged_turn'] as const)test('records '+state+' without duplicating old business or losing original audit',async()=>{
  const {f,g,raw}=await setup()
  try{
   const turn=raw[0].turn_id,episode=randomUUID(),run=randomUUID(),claim=randomUUID(),version=randomUUID(),evidence=randomUUID(),capsule=randomUUID(),digest=Buffer.alloc(32,9)
   if(state!=='accepted_purged_turn'){
    await f.runtime.query("INSERT INTO source_turns(installation_id,turn_id,session_id,state,first_source_event_id,last_source_event_id,event_count) VALUES($1,$2,$3,'completed',$4,$5,6)",[g.installation,turn,raw[0].session_id,raw[0].source_event_id,raw.at(-1)!.source_event_id])
    await f.runtime.query("INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,source_digest,document,evidence_manifest) VALUES($1,$2,$3,$4,'ready','task8-legacy', $5,'{}',$6::jsonb)",[g.installation,episode,raw[0].session_id,turn,digest,JSON.stringify({old:{kind:'event',source_event_id:raw[0].source_event_id,source_provenance:raw[0].source_provenance}})])
   }
   if(state==='paid_unknown'){
    await f.runtime.query("INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model,cost_micros,error_code) VALUES($1,$2,$3,$4,'task8-old','task8-old',$4,$4,'enabled','running','synthetic','never-called',19,'provider_result_unknown')",[run,g.installation,episode,digest])
    await f.runtime.query("INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,cost_micros,occurred_at) VALUES($1,$2,'extract_candidates',19,clock_timestamp())",[g.installation,'extraction:'+run])
   }
   if(state==='accepted_purged_turn'){
    await f.runtime.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1::uuid,$2::uuid,'test_invariant','installation',$2::text,$1::text,'active')",[claim,g.installation])
    await f.runtime.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence) VALUES($1,$2,$3,1,'Old independently accepted knowledge','{}','user_accepted',1)",[version,g.installation,claim])
    await f.runtime.query("INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',$4)",[capsule,g.installation,version,digest])
    await f.runtime.query("INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,evidence_kind,locator,excerpt,excerpt_hash,occurred_at,ordinal) VALUES($1,$2,$3,$4,'accepted_excerpt',$5::jsonb,'Original bounded accepted excerpt',$6,clock_timestamp(),0)",[evidence,g.installation,version,capsule,JSON.stringify({source_provenance:raw[0].source_provenance}),digest])
   }
   const before=(await f.runtime.query('SELECT source_event_id,encode(payload_hash,\'hex\') AS hash,source_provenance FROM source_events WHERE installation_id=$1 ORDER BY source_event_id',[g.installation])).rows
   const p=await publish(f,g)
   expect(p.disposition).toBe('legacy_related')
   expect(p.legacy_relation_audit).toMatchObject({version:1,disposition:'related',identityDigest:expect.stringMatching(/^[a-f0-9]{64}$/)})
   expect(p.legacy_relation_digest).toHaveLength(32)
   expect((await f.runtime.query("SELECT count(*)::int AS n FROM source_turns WHERE installation_id=$1 AND turn_id LIKE 'team-semantic:%'",[g.installation])).rows[0].n).toBe(0)
   expect((await f.runtime.query("SELECT count(*)::int AS n FROM memory_jobs WHERE installation_id=$1 AND job_type='compile_episode'",[g.installation])).rows[0].n).toBe(0)
   expect((await f.runtime.query("SELECT source_event_id,encode(payload_hash,'hex') AS hash,source_provenance FROM source_events WHERE installation_id=$1 AND source_kind<>'team_semantic' ORDER BY source_event_id",[g.installation])).rows).toEqual(before)
   if(state==='paid_unknown')expect((await f.runtime.query('SELECT cost_micros::int,error_code,state FROM memory_extraction_runs WHERE run_id=$1',[run])).rows[0]).toEqual({cost_micros:19,error_code:'provider_result_unknown',state:'running'})
   if(state==='accepted_purged_turn')expect((await f.runtime.query('SELECT source_content_hash FROM knowledge_evidence_capsules WHERE capsule_id=$1',[capsule])).rows[0].source_content_hash).toEqual(digest)
  }finally{await f.close()}
 })
 test('unbound global reservation blocks fresh business without assigning its ID to this installation',async()=>{
  const {f,g}=await setup(),reservation=randomUUID()
  try{
   await f.runtime.query("INSERT INTO memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,state,reserved_input_tokens,reserved_output_tokens) VALUES($1,'task8-opaque-global','text','reserved',10,10)",[reservation])
   const original=(await f.runtime.query('SELECT to_jsonb(b) AS row FROM memory_provider_budget_reservations b WHERE reservation_id=$1',[reservation])).rows[0].row
   const p=await publish(f,g)
   expect(p.disposition).toBe('legacy_unproven')
   expect(JSON.stringify(p.legacy_relation_audit)).not.toContain(reservation)
   expect(p.legacy_relation_audit.reasons).toContain('global_accounting_unbound')
   expect(p.goal_ref_id).toBeNull()
   expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1 AND source_kind=\'team_semantic\'',[g.installation])).rows[0].n).toBe(0)
   expect((await f.runtime.query('SELECT to_jsonb(b) AS row FROM memory_provider_budget_reservations b WHERE reservation_id=$1',[reservation])).rows[0].row).toEqual(original)
  }finally{await f.runtime.query('DELETE FROM memory_provider_budget_reservations WHERE reservation_id=$1',[reservation]);await f.close()}
 })
 test('bounded empty snapshot remains unusable until independent global writer fence exists',async()=>{
  const {f,g}=await setup()
  try{const p=await publish(f,g);expect(p.disposition).toBe('legacy_unproven');expect(p.legacy_relation_audit).toMatchObject({version:1,closure:'snapshot_only',disposition:'fresh_candidate',reasons:[]});expect(p.goal_ref_id).toBeNull();expect((await f.runtime.query("SELECT count(*)::int AS n FROM source_turns WHERE installation_id=$1 AND turn_id LIKE 'team-semantic:%'",[g.installation])).rows[0].n).toBe(0)}finally{await f.close()}
 })
 test('incomplete own-installation paid closure stays unproven without manufacturing refs',async()=>{
  const {f,g}=await setup()
  try{
   await f.runtime.query("INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,cost_micros,occurred_at) VALUES($1,$2,'extract_candidates',21,clock_timestamp())",[g.installation,'task8-unlinked-'+randomUUID()])
   const p=await publish(f,g)
   expect(p.disposition).toBe('legacy_unproven');expect(p.legacy_relation_audit.reasons).toContain('relation_unknown');expect(p.goal_ref_id).toBeNull()
  }finally{await f.close()}
 })
 test('mutable job payload cannot supply an original group link for a private accounting attempt',async()=>{
  const {f,g}=await setup()
  try{await f.execution(g.installation,async()=>{
   const original=teamSemanticOriginalExecution(f.runtime,g.installation)
   const job=(await f.admin.query('SELECT job_id FROM shared.memory_source_executions WHERE execution_id=$1',[original.executionId])).rows[0].job_id
   const roster=await discoverTeamSemanticGroup(f.runtime,g.installation,g.root),c=await f.runtime.connect(),reservation=randomUUID()
   try{
    await c.query('BEGIN')
    await c.query("UPDATE memory_jobs SET payload=jsonb_build_object('root',$2::jsonb) WHERE job_id=$1",[job,JSON.stringify(g.root)])
    await c.query("INSERT INTO memory_provider_budget_reservations(reservation_id,budget_key,provider_kind,state,reserved_input_tokens,reserved_output_tokens) VALUES($1,'task8-mutated-job','text','reserved',10,10)",[reservation])
    expect((await c.query('SELECT shared.start_memory_source_provider($1,$2,$3) AS valid',[original.executionId,reservation,'e'.repeat(64)])).rows[0].valid).toBe(true)
    const audit=await collectTeamSemanticLegacyAudit(c,roster)
    expect(audit.disposition).toBe('unproven');expect(audit.accounting.unprovenCount).toBe(1)
   }finally{await c.query('ROLLBACK');c.release()}
  })}finally{await f.close()}
 })
 test('late own-history change is rejected at real physical COMMIT after publication INSERT',async()=>{
  const {f,g,raw}=await setup()
  try{
   await f.runtime.query("INSERT INTO source_turns(installation_id,turn_id,session_id,state,first_source_event_id,last_source_event_id,event_count) VALUES($1,$2,$3,'completed',$4,$5,6)",[g.installation,raw[0].turn_id,raw[0].session_id,raw[0].source_event_id,raw.at(-1)!.source_event_id])
   let injected=false
   await f.execution(g.installation,async()=>{
    const page=await prepareTeamSemanticPublication(f.runtime,g.installation,g.root),writer=await f.runtime.connect(),connect=f.runtime.connect.bind(f.runtime)
    f.runtime.connect=(async()=>{
     const client=await connect()
     return new Proxy(client,{get(target,key){
      if(key==='query')return async(sql:any,...args:any[])=>{
       if(sql==='COMMIT'&&!injected){injected=true;await writer.query("INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,cost_micros,occurred_at) VALUES($1,$2,'extract_candidates',7,clock_timestamp())",[g.installation,'task8-late-'+randomUUID()])}
       return (target.query.bind(target) as any)(sql,...args)
      }
      const result=Reflect.get(target,key);return typeof result==='function'?result.bind(target):result
     }})
    }) as typeof f.runtime.connect
    try{await expect(persistTeamSemanticPublication(f.runtime,page!,0)).rejects.toThrow('team_semantic_legacy_audit_changed')}
    finally{f.runtime.connect=connect;writer.release()}
   })
   expect(injected).toBe(true)
   expect((await f.runtime.query('SELECT count(*)::int AS n FROM memory_team_semantic_publications WHERE installation_id=$1',[g.installation])).rows[0].n).toBe(0)
   expect((await f.runtime.query("SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1 AND source_kind='team_semantic'",[g.installation])).rows[0].n).toBe(0)
  }finally{await f.close()}
 })
 test('late fees preserve immutable first audit and current semantic body authority',async()=>{
  const {f,g,raw}=await setup()
  try{
   await f.runtime.query("INSERT INTO source_turns(installation_id,turn_id,session_id,state,first_source_event_id,last_source_event_id,event_count) VALUES($1,$2,$3,'completed',$4,$5,6)",[g.installation,raw[0].turn_id,raw[0].session_id,raw[0].source_event_id,raw.at(-1)!.source_event_id])
   const p=await publish(f,g),audit=JSON.stringify(p.legacy_relation_audit),digest=p.legacy_relation_digest
   await f.runtime.query("INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,cost_micros,occurred_at) VALUES($1,$2,'extract_candidates',29,clock_timestamp())",[g.installation,'task8-late-fee-'+randomUUID()])
   const prepared=await prepareSourceReferences(f.runtime,g.installation,[p.goal_ref_id,p.reply_ref_id,p.outcome_ref_id])
   expect(prepared.events).toHaveLength(3)
   const after=(await f.runtime.query('SELECT * FROM memory_team_semantic_publications WHERE installation_id=$1',[g.installation])).rows[0]
   expect(JSON.stringify(after.legacy_relation_audit)).toBe(audit);expect(after.legacy_relation_digest).toEqual(digest)
   await expect(f.runtime.query("UPDATE memory_team_semantic_publications SET legacy_relation_audit=jsonb_set(legacy_relation_audit,'{disposition}','\"fresh_candidate\"') WHERE installation_id=$1",[g.installation])).rejects.toThrow('team_semantic_publication_immutable')
  }finally{await f.close()}
 })
 test('controlled audit has exact owner/ACL and independently rejects caller group forgeries',async()=>{
  const {f,g}=await setup()
  try{
   const roster=await discoverTeamSemanticGroup(f.runtime,g.installation,g.root)
   for(const group of [{...roster,installationId:randomUUID()},{...roster,scope:'forged'},{...roster,bindingRevision:'999'}])await expect(f.runtime.query('SELECT shared.read_memory_team_legacy_audit($1,$2::jsonb)',[g.installation,JSON.stringify(group)])).rejects.toThrow()
   await expect(f.publisher.query('SELECT shared.read_memory_team_legacy_audit($1,$2::jsonb)',[g.installation,JSON.stringify(roster)])).rejects.toThrow('permission denied')
   for(const db of [f.runtime,f.publisher])await expect(db.query('SELECT 1 FROM shared.memory_source_provider_attempts LIMIT 1')).rejects.toThrow('permission denied')
   const c=await f.admin.connect(),config=JSON.parse(value!)
   try{
    await assertTeamSemanticLegacyFunction(c)
    for(const drift of ['GRANT EXECUTE ON FUNCTION shared.read_memory_team_legacy_audit(uuid,jsonb) TO PUBLIC',`GRANT EXECUTE ON FUNCTION shared.read_memory_team_legacy_audit(uuid,jsonb) TO ${config.roles.relayRole}`,`ALTER FUNCTION shared.read_memory_team_legacy_audit(uuid,jsonb) OWNER TO ${config.roles.memoryRole}`]){
     try{await c.query('BEGIN');await c.query(drift);await expect(assertTeamSemanticLegacyFunction(c)).rejects.toThrow('team_semantic_legacy_function_incompatible')}finally{await c.query('ROLLBACK')}
     await assertTeamSemanticLegacyFunction(c)
    }
   }finally{c.release()}
  }finally{await f.close()}
 })
 test.skip('OPEN global writer fence: fresh publication records explicit empty bounded legacy closure',async()=>{
  const {f,g}=await setup()
  try{const p=await publish(f,g);expect(p.disposition).toBe('published');expect(p.legacy_relation_audit).toMatchObject({version:1,disposition:'fresh',reasons:[]});expect(p.legacy_relation_digest).toHaveLength(32)}finally{await f.close()}
 })
})
