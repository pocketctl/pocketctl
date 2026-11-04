import type pg from 'pg'
import {createHash} from 'node:crypto'
import {canonicalPayloadHash} from '../inbox/canonical-json.js'
import {sanitizeText} from '../episodes/content-policy.js'

/** Read-only inspection; never transfers authority or normalizes ledger state. */
export async function shadowReviewQueue(pool:pg.Pool,input:{installationId:string;limit?:number;cursor?:string}){
 const limit=Math.min(Math.max(1,input.limit??50),100)
 if(input.cursor&&!(await pool.query("SELECT 1 FROM memory_candidates WHERE installation_id=$1 AND candidate_id=$2::uuid AND source_kind='task_bundle' AND status='shadow'",[input.installationId,input.cursor])).rowCount)throw new Error('invalid_cursor')
 const result=await pool.query(`WITH eligible AS(
  SELECT c.candidate_id::text,c.claim_type,c.statement,c.structured_content,c.scope_kind,c.scope_key,
   c.confidence::text,c.freshness_at,c.status,c.revision::text,c.created_at,c.source_kind,
   c.curation_run_id::text,c.bundle_id::text,b.spans
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
 const sources=ids.length?(await pool.query(`SELECT s.source_event_id::text,s.payload,s.payload_hash,s.body_reclaimed_at,m.bundle_id::text,m.source_digest
  FROM source_events s JOIN memory_task_bundle_sources m USING(installation_id,source_event_id)
  WHERE s.installation_id=$1 AND s.source_event_id=ANY($2::uuid[]) AND m.bundle_id=ANY($3::uuid[])`,[input.installationId,ids,page.map(r=>r.bundle_id)])).rows:[]
 return {total_count:result.rows[0]?.total_count??0,next_cursor:rows.length>limit?page.at(-1)!.candidate_id:null,
  candidates:page.map(({spans,...row})=>{
   let available=true
   const evidence=(spans as Array<{event_id:string;start:number;end:number}>).flatMap(span=>{
    const s=sources.find(s=>s.source_event_id===span.event_id&&s.bundle_id===row.bundle_id)
    const text=s?sanitizeText(typeof s.payload.text==='string'?s.payload.text:'',4000).text:''
    if(!s||s.body_reclaimed_at||!canonicalPayloadHash(s.payload).equals(s.payload_hash)||!s.source_digest.equals(s.payload_hash)||!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end<=span.start||span.end>text.length){available=false;return[]}
    return[{handle:`h-${createHash('sha256').update(s.source_event_id).digest('hex').slice(0,8)}:${span.start}-${span.end}`,excerpt:text.slice(span.start,span.end)}]
   })
   return {...row,read_only:true,evidence_state:available?'available':'unavailable',evidence:available?evidence:[],repository_id:null,repo_snapshot_id:null,branch:null,episode_id:null,duplicate_of_claim_id:null}
  })}
}
