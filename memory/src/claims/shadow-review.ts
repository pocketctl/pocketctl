import {lockCurrentRelayAuthority} from '../sources/current-grant.js'
import {requireCurrentScopePermission,requireCurrentInstallationAuthority,assertCurrentGrantClock,TargetBindingError,type V2GrantFacts} from '../governance/authorization.js'
import {sourcePoolContext} from '../sources/pool-context.js'
import {prepareSourceReferences,preparedSourceUnavailable} from '../sources/prepared-sources.js'
import {canonicalJsonString} from '@pocketctl/session-source'
import type pg from 'pg'
import {createHash} from 'node:crypto'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import {sanitizeText} from '../episodes/content-policy.js'

/** Read-only inspection; never transfers authority or normalizes ledger state. */
export interface ShadowReviewInput {installationId:string;limit?:number;cursor?:string;authorityGrant?:V2GrantFacts|{installationId:string;configVersion?:string;expiresAt?:number;userId?:number}}
export async function shadowReviewQueue(pool:pg.Pool,input:ShadowReviewInput){
 const shared=sourcePoolContext(pool).namespace==='memory'
 const unavailable=()=>({total_count:0,next_cursor:null,candidates:[]})
 if(shared&&(!input.authorityGrant||(!('scopeBindings' in input.authorityGrant)&&typeof input.authorityGrant.configVersion!=='string')))return unavailable()
 const limit=Math.min(Math.max(1,input.limit??50),100)
 if(input.cursor&&!(await pool.query("SELECT 1 FROM memory_candidates WHERE installation_id=$1 AND candidate_id=$2::uuid AND source_kind='task_bundle' AND status='shadow'",[input.installationId,input.cursor])).rowCount)throw new Error('invalid_cursor')
 const result=await pool.query(`WITH eligible AS(
  SELECT c.candidate_id::text,c.claim_type,c.statement,c.structured_content,c.scope_kind,c.scope_key,
   c.confidence::text,c.freshness_at,c.status,c.revision::text,c.created_at,c.source_kind,
   c.curation_run_id::text,c.bundle_id::text,b.spans,b.session_id AS _session_id,
   c.xmin::text AS _candidate_stamp,b.xmin::text AS _bundle_stamp,parent.xmin::text AS _parent_stamp,r.xmin::text AS _run_stamp,owner.xmin::text AS _owner_stamp
  FROM memory_candidates c JOIN memory_task_bundles b USING(installation_id,bundle_id)
  JOIN memory_task_bundles parent ON parent.installation_id=b.installation_id AND parent.bundle_id=b.parent_bundle_id
  JOIN memory_curation_runs r ON r.installation_id=c.installation_id AND r.run_id=c.curation_run_id
  JOIN memory_owner_scopes owner ON owner.installation_id=c.installation_id
  WHERE c.installation_id=$1 AND c.source_kind='task_bundle' AND c.status='shadow'
   AND owner.owner_scope_kind='personal' AND owner.state='active'
   AND r.mode='shadow' AND r.state='completed' AND r.bundle_revision=b.revision AND r.source_digest=b.source_digest
   AND c.bundle_revision=b.revision AND b.parent_revision=parent.revision
   AND b.body_state='present' AND parent.body_state='present'
 ),page AS(SELECT * FROM eligible WHERE($3::uuid IS NULL OR created_at<(SELECT created_at FROM memory_candidates WHERE installation_id=$1 AND candidate_id=$3::uuid)
  OR(created_at=(SELECT created_at FROM memory_candidates WHERE installation_id=$1 AND candidate_id=$3::uuid) AND candidate_id::uuid>$3::uuid))
  ORDER BY created_at DESC,candidate_id::uuid LIMIT $2)
 SELECT totals.total_count,page.* FROM(SELECT count(*)::int total_count FROM eligible)totals LEFT JOIN page ON true ORDER BY created_at DESC,candidate_id::uuid`,[input.installationId,limit+1,input.cursor??null])
 const rows=result.rows.filter(r=>r.candidate_id),page=rows.slice(0,limit),ids=[...new Set(page.flatMap(r=>(r.spans as Array<{event_id:string}>).map(s=>s.event_id)))]
 const bindings=ids.length?(await pool.query(`SELECT s.source_event_id::text,${shared?'':'s.payload,'}s.payload_hash,s.body_reclaimed_at,s.session_id,m.bundle_id::text,m.source_digest
  FROM source_events s JOIN memory_task_bundle_sources m USING(installation_id,source_event_id)
  WHERE s.installation_id=$1 AND s.source_event_id=ANY($2::uuid[]) AND m.bundle_id=ANY($3::uuid[])`,[input.installationId,ids,page.map(r=>r.bundle_id)])).rows:[]
 let prepared:Awaited<ReturnType<typeof prepareSourceReferences>>|undefined
 if(shared){try{prepared=await prepareSourceReferences(pool,input.installationId,[...new Set(bindings.filter(r=>!r.body_reclaimed_at).map(r=>r.source_event_id))])}catch(error){if(preparedSourceUnavailable(error))return unavailable();throw error}}
 const canonical=new Map(prepared?.events.map(e=>[e.source_event_id,e.payload])??[])
 const sources=bindings.map(r=>({...r,payload:shared?canonical.get(r.source_event_id):r.payload}))
 const response={total_count:result.rows[0]?.total_count??0,next_cursor:rows.length>limit?page.at(-1)!.candidate_id:null,
  candidates:page.map(({spans,_session_id,_candidate_stamp,_bundle_stamp,_parent_stamp,_run_stamp,_owner_stamp,...row})=>{
   let available=true
   const evidence=(spans as Array<{event_id:string;start:number;end:number}>).flatMap(span=>{
    const s=sources.find(s=>s.source_event_id===span.event_id&&s.bundle_id===row.bundle_id)
    const text=s?sanitizeText(typeof s.payload?.text==='string'?s.payload.text:'',4000).text:''
    if(!s||s.session_id!==_session_id||!s.payload||s.body_reclaimed_at||!canonicalPayloadHash(s.payload).equals(s.payload_hash)||!s.source_digest.equals(s.payload_hash)||!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end<=span.start||span.end>text.length){available=false;return[]}
    return[{handle:`h-${createHash('sha256').update(s.source_event_id).digest('hex').slice(0,8)}:${span.start}-${span.end}`,excerpt:text.slice(span.start,span.end)}]
   })
   return {...row,read_only:true,evidence_state:available?'available':'unavailable',evidence:available?evidence:[],repository_id:null,repo_snapshot_id:null,branch:null,episode_id:null,duplicate_of_claim_id:null}
  })}
 if(!prepared)return response
 const client=await pool.connect()
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'")
  const grant=input.authorityGrant!
  const bindings='scopeBindings' in grant?grant.scopeBindings:[]
  if(!await lockCurrentRelayAuthority(client,bindings.length?bindings.map(b=>b.installation_id):[input.installationId],bindings.flatMap(b=>b.membership_id?[b.membership_id]:[])))throw new TargetBindingError('scope authority busy')
  for(const session of [...new Set(page.map(r=>r._session_id))].sort())await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:session:'||$1||':'||$2,0))",[input.installationId,session])
  if('scopeBindings' in grant)await requireCurrentScopePermission({client,grant,targetInstallationId:input.installationId,permission:'read'})
  else{if(grant.installationId!==input.installationId)throw new TargetBindingError('installation authority mismatch');await requireCurrentInstallationAuthority(client,grant,{readOnly:true})}
  await prepared.assertCurrent(client)
  const current=(await client.query(`SELECT c.candidate_id::text,c.xmin::text AS _candidate_stamp,b.xmin::text AS _bundle_stamp,parent.xmin::text AS _parent_stamp,r.xmin::text AS _run_stamp,owner.xmin::text AS _owner_stamp
   FROM memory_candidates c JOIN memory_task_bundles b USING(installation_id,bundle_id)
   JOIN memory_task_bundles parent ON parent.installation_id=b.installation_id AND parent.bundle_id=b.parent_bundle_id
   JOIN memory_curation_runs r ON r.installation_id=c.installation_id AND r.run_id=c.curation_run_id
   JOIN memory_owner_scopes owner ON owner.installation_id=c.installation_id
   WHERE c.installation_id=$1 AND c.candidate_id=ANY($2::uuid[]) ORDER BY c.candidate_id FOR SHARE OF c,b,parent,r,owner NOWAIT`,[input.installationId,page.map(r=>r.candidate_id)])).rows
  const witness=(r:any)=>[r.candidate_id,r._candidate_stamp,r._bundle_stamp,r._parent_stamp,r._run_stamp,r._owner_stamp]
  if(canonicalJsonString(current.map(witness))!==canonicalJsonString([...page].sort((a,b)=>a.candidate_id.localeCompare(b.candidate_id)).map(witness)))throw Error('source_reference_changed')
  await prepared.assertCurrent(client,{forCommit:true})
  await assertCurrentGrantClock(client,grant,[input.installationId])
  await client.query('COMMIT');return response
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);if(error instanceof TargetBindingError||preparedSourceUnavailable(error)||(error as {code?:string}).code==='55P03')return unavailable();throw error}finally{client.release()}
}
