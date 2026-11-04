import type pg from 'pg'
import {retentionTransaction} from './transaction.js'
import {lockLifecycleScope,lifecycleFacts} from '../claims/lifecycle-service.js'
import {evaluateClaimLifecycle} from '../claims/lifecycle-evaluator.js'
import type {LifecycleMode} from '../claims/lifecycle-policy.js'
import {lifecycleObservationAvailableSql} from '../claims/lifecycle-observation.js'

export interface HistoryVersion {versionId:string;versionNumber:number;createdAt:Date;current:boolean;protected:boolean;dependent:boolean;bodyState:string}
/** Union, not intersection: a fourth recent version or an old dependency stays. */
export function selectHistoryReclamation(versions:readonly HistoryVersion[],now:Date):string[]{
 const newest=new Set([...versions].sort((a,b)=>b.versionNumber-a.versionNumber).slice(0,3).map(v=>v.versionId))
 return versions.filter(v=>v.bodyState==='present'&&!v.current&&!v.protected&&!v.dependent&&!newest.has(v.versionId)
  &&v.createdAt.getTime()<now.getTime()-90*86_400_000).map(v=>v.versionId)
}

// Evidence and index projections are reclaimed with the body. Immutable audit
// identities do not pin prose forever; active proposals are checked separately.
const disposableVersionRefs=new Set(['knowledge_claims','knowledge_evidence','knowledge_evidence_capsules','claim_search_documents',
 'memory_feedback','memory_retrieval_candidates','memory_curation_decisions','memory_lifecycle_maintenance_receipts','memory_lifecycle_assessment_runs','memory_version_retention_protections','memory_automation_authority_records'])
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"'
async function hasDependencies(client:pg.PoolClient,installationId:string,versionId:string):Promise<boolean>{
 const constraints=(await client.query<{table_name:string;local_column:string;target_table:string}>(`SELECT c.conrelid::regclass::text AS table_name,a.attname AS local_column,c.confrelid::regclass::text AS target_table
  FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey,c.confkey) keys(local_key,foreign_key)
  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=keys.local_key
  JOIN pg_attribute target ON target.attrelid=c.confrelid AND target.attnum=keys.foreign_key
  WHERE c.contype='f' AND c.confrelid IN('knowledge_versions'::regclass,'knowledge_evidence'::regclass,'knowledge_evidence_capsules'::regclass)
    AND target.attname IN('version_id','evidence_id','capsule_id')`)).rows
 for(const ref of constraints){
  if(ref.target_table==='knowledge_versions'&&disposableVersionRefs.has(ref.table_name))continue
  if(ref.target_table==='knowledge_evidence_capsules'&&ref.table_name==='knowledge_evidence')continue
  const rhs=ref.target_table==='knowledge_versions'?'SELECT $2::uuid':`SELECT ${ref.target_table==='knowledge_evidence'?'evidence_id':'capsule_id'} FROM ${ref.target_table} WHERE installation_id=$1 AND version_id=$2`
  if((await client.query(`SELECT 1 FROM ${quote(ref.table_name)} WHERE installation_id=$1 AND ${quote(ref.local_column)} IN(${rhs}) LIMIT 1`,[installationId,versionId])).rowCount)return true
 }
 return !!(await client.query(`SELECT 1 WHERE
  EXISTS(SELECT 1 FROM memory_curation_decisions WHERE installation_id=$1 AND state='proposed' AND (version_id=$2 OR expected_version_id=$2)) OR
  EXISTS(SELECT 1 FROM memory_wiki_build_sources WHERE installation_id=$1 AND
   ((source_kind='claim_version' AND source_ref_id=$2) OR(source_kind='evidence' AND source_ref_id IN(SELECT evidence_id FROM knowledge_evidence WHERE installation_id=$1 AND version_id=$2))))`,[installationId,versionId])).rowCount
}

export async function planClaimHistoryRetention(client:pg.PoolClient,input:{installationId:string;claimId:string;now?:Date}):Promise<string[]>{
 const rows=(await client.query(`SELECT v.version_id,v.version_number,v.created_at,v.body_state,c.current_version_id=v.version_id AS current,
  (l.protection<>'none' OR EXISTS(SELECT 1 FROM memory_version_retention_protections p WHERE p.installation_id=v.installation_id AND p.version_id=v.version_id AND(p.expires_at IS NULL OR p.expires_at>clock_timestamp()))) AS protected
  FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id)
  LEFT JOIN memory_claim_lifecycle l USING(installation_id,claim_id)
  WHERE v.installation_id=$1 AND v.claim_id=$2 ORDER BY v.version_number DESC`,[input.installationId,input.claimId])).rows
 const versions:HistoryVersion[]=[]
 for(const r of rows)versions.push({versionId:r.version_id,versionNumber:r.version_number,createdAt:r.created_at,bodyState:r.body_state,current:r.current,protected:!!r.protected,dependent:await hasDependencies(client,input.installationId,r.version_id)})
 return selectHistoryReclamation(versions,input.now??new Date())
}

export interface ClaimBodyRetentionSettings {lifecycleMode?:LifecycleMode;readerCompatible?:boolean;limit?:number}
export async function reclaimClaimHistory(pool:pg.Pool,input:{installationId:string;claimId:string},settings:ClaimBodyRetentionSettings={}){
 if(settings.lifecycleMode!=='enabled'||!settings.readerCompatible)return {versions:0,bodyBytes:0,skipped:'disabled'}
 const limit=settings.limit??20
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('invalid_history_retention_batch')
 return retentionTransaction(pool,async client=>{
  await lockLifecycleScope(client,input.installationId)
  const claim=(await client.query(`SELECT c.claim_id FROM knowledge_claims c JOIN memory_claim_lifecycle l USING(installation_id,claim_id)
   JOIN memory_curation_policies p ON p.installation_id=c.installation_id JOIN memory_installations i ON i.installation_id=c.installation_id
   WHERE c.installation_id=$1 AND c.claim_id=$2 AND l.protection='none' AND p.reclaim_mode='enabled'
    AND i.local_status='ready' AND i.relay_status='active' FOR UPDATE OF c,l FOR SHARE OF p,i`,[input.installationId,input.claimId])).rows[0]
  if(!claim)return {versions:0,bodyBytes:0,skipped:'policy_or_protection'}
  await client.query('SELECT version_id FROM knowledge_versions WHERE installation_id=$1 AND claim_id=$2 ORDER BY version_number FOR UPDATE',[input.installationId,input.claimId])
  const ids=(await planClaimHistoryRetention(client,input)).slice(0,limit)
  let bodyBytes=0
  for(const id of ids)bodyBytes+=await reclaimVersion(client,input,id,'reclaim_history')
  return {versions:ids.length,bodyBytes,skipped:null}
 })
}

export async function reclaimColdClaimBody(pool:pg.Pool,input:{installationId:string;claimId:string},settings:ClaimBodyRetentionSettings={}){
 if(settings.lifecycleMode!=='enabled'||!settings.readerCompatible)return {versions:0,bodyBytes:0,skipped:'disabled'}
 return retentionTransaction(pool,async client=>{
  await lockLifecycleScope(client,input.installationId)
  const row=(await client.query(`SELECT l.*,CASE WHEN ${lifecycleObservationAvailableSql()} THEN l.observation_state ELSE 'unknown' END AS observation_state,c.state,c.created_at,c.consumption_hold_reason,v.authority,v.valid_until,v.version_id,
   p.cold_mode,p.reclaim_mode,clock_timestamp() AS now,memory_delivery_version_available(v.installation_id,v.version_id) AS source_available
   FROM memory_claim_lifecycle l JOIN knowledge_claims c USING(installation_id,claim_id)
   JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id
   JOIN memory_curation_policies p ON p.installation_id=c.installation_id JOIN memory_installations i ON i.installation_id=c.installation_id
   WHERE l.installation_id=$1 AND l.claim_id=$2 AND i.local_status='ready' AND i.relay_status='active'
   FOR UPDATE OF c,l,v FOR SHARE OF p,i`,[input.installationId,input.claimId])).rows[0]
  if(!row||row.consumption_hold_reason||evaluateClaimLifecycle(lifecycleFacts(row,'enabled')).action!=='reclaim_eligible'||await hasDependencies(client,input.installationId,row.version_id))return {versions:0,bodyBytes:0,skipped:'not_eligible'}
  const protectedVersion=await client.query(`SELECT 1 FROM memory_version_retention_protections WHERE installation_id=$1 AND version_id=$2 AND(expires_at IS NULL OR expires_at>clock_timestamp())`,[input.installationId,row.version_id])
  if(protectedVersion.rowCount)return {versions:0,bodyBytes:0,skipped:'protected'}
  const bodyBytes=await reclaimVersion(client,input,row.version_id,'reclaim_body')
  await client.query("UPDATE memory_claim_lifecycle SET body_state='reclaimed' WHERE installation_id=$1 AND claim_id=$2",[input.installationId,input.claimId])
  return {versions:1,bodyBytes,skipped:null}
 })
}
async function reclaimVersion(client:pg.PoolClient,input:{installationId:string;claimId:string},versionId:string,action:string):Promise<number>{
 const before=(await client.query(`SELECT octet_length(statement)+octet_length(structured_content::text) AS body_bytes FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2 AND body_state='present'`,[input.installationId,versionId])).rows[0]
 const row=(await client.query(`UPDATE knowledge_versions SET body_hash=encode(sha256(convert_to(jsonb_build_object('statement',statement,'structured_content',structured_content)::text,'UTF8')),'hex'),
  statement='[content reclaimed]',structured_content='{}',body_state='reclaimed',body_reclaimed_at=clock_timestamp()
  WHERE installation_id=$1 AND version_id=$2 AND body_state='present' RETURNING body_hash`,[input.installationId,versionId])).rows[0]
 if(!row)return 0
 // Exact stored prose bytes are measured before clearing, separately from
 // index storage and database filesystem reclamation (which this cannot infer).
 await client.query('DELETE FROM claim_search_documents WHERE installation_id=$1 AND version_id=$2',[input.installationId,versionId])
 await client.query('DELETE FROM knowledge_evidence WHERE installation_id=$1 AND version_id=$2',[input.installationId,versionId])
 await client.query('DELETE FROM knowledge_evidence_capsules WHERE installation_id=$1 AND version_id=$2',[input.installationId,versionId])
 const revision=(await client.query('UPDATE memory_claim_lifecycle SET revision=revision+1 WHERE installation_id=$1 AND claim_id=$2 RETURNING revision',[input.installationId,input.claimId])).rows[0].revision
 await client.query(`INSERT INTO memory_lifecycle_maintenance_receipts(installation_id,claim_id,version_id,action,lifecycle_revision,body_bytes) VALUES($1,$2,$3,$4,$5,$6)`,[input.installationId,input.claimId,versionId,action,revision,before.body_bytes])
 return Number(before.body_bytes)
}
