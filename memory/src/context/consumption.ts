import {lifecycleFrameFenceSql,type LifecycleFrame} from './lifecycle-frame.js'
import type {CurationMode} from '../curation/contracts.js'
import {currentClaimVersionSql,revisionTimeSql} from '../claims/version-selection.js'
import { deliveryVersionAvailableSql } from '../episodes/delivery-withdrawal.js'
import type {SelectedScopeProof} from './selected-scope-dependencies.js'
import {ORIGIN_POLICY_REQUIRED_SQL,originPolicyCorpusVersionsSql,originPolicyDecisions,type OriginPolicyDecision} from '../governance/origin-policy.js'
import type pg from 'pg'
import {claimConsumptionDecision,type ClaimConsumptionFacts} from '../governance/applicability.js'
import {canonicalRepositoryRemotes} from '../governance/publication-applicability.js'
export interface ContextQueryFrame {lifecycle?:LifecycleFrame;repositoryId:string|null;repoSnapshotId:string|null;branch:string|null;taskScopeKey:string|null;commitSha?:string|null;originPolicyStamp?:string|null;selectedScopeProof?:SelectedScopeProof}
export class ContextConsumptionChangedError extends Error{constructor(){super('context_consumption_changed')}}
export async function consumptionGeneration(pool:pg.Pool|pg.PoolClient,installationId:string):Promise<string>{
 return(await pool.query<{generation:string}>(`SELECT COALESCE((SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=$1),1)::text AS generation`,[installationId])).rows[0]?.generation??'1'
}
/** Caller acquires source/FK dependencies first. Never acquire source locks after this fence. */
export async function fenceConsumptionGeneration(client:pg.PoolClient,installationId:string,expected?:string,options:{
 directPack?:{packId:string;lifecycleMode:CurationMode}
}={}):Promise<string>{
 const directPack=options.directPack
 // Admission already locks this pack. Read its current frame and absent
 // origin policy in the same snapshot as the generation fence.
 const select = () => client.query<{generation:string;origin_absent?:boolean;frame_current?:boolean}>(`SELECT generation::text
  ${directPack?`,NOT EXISTS (${originPolicyCorpusVersionsSql('$1')}) AS origin_absent,
   EXISTS(SELECT 1 FROM memory_context_packs p WHERE p.installation_id=$1 AND p.pack_id=$2
    AND (p.query_context->'lifecycle' IS NULL OR p.query_context->'lifecycle'='null'::jsonb
      OR jsonb_typeof(p.query_context#>'{lifecycle,consume}')='boolean')
    AND ${lifecycleFrameFenceSql('p',directPack.lifecycleMode,'memory')}) AS frame_current`:''}
  FROM memory_scope_consumption_generations WHERE installation_id=$1 FOR SHARE`,
  directPack?[installationId,directPack.packId]:[installationId])
 let row=(await select()).rows[0]
 if(!row){
  await client.query('INSERT INTO memory_scope_consumption_generations(installation_id) VALUES($1) ON CONFLICT DO NOTHING',[installationId])
  row=(await select()).rows[0]
 }
 const generation=row.generation
 if(expected!==undefined&&generation!==expected
  ||directPack&&(row.origin_absent!==true||row.frame_current!==true))throw new ContextConsumptionChangedError()
 return generation
}
export function contextClaimEligible(facts:ClaimConsumptionFacts,frame:ContextQueryFrame):boolean{
 return claimConsumptionDecision(facts,{repositoryId:frame.repositoryId,snapshotId:frame.repoSnapshotId,branch:frame.branch,taskScopeKey:frame.taskScopeKey}).eligible
}
export interface ContextClaimFacts extends ClaimConsumptionFacts {
 versionId:string;claimId:string;lifecycle?:{assertionMode?:string;hot:boolean;spaceId:string|null;destinations:string[];spaceActive:boolean;consume:boolean};current:boolean;timeEligible:boolean;sourceMetadataOwned:boolean;canonicalRemote:string|null;originPolicy?:OriginPolicyDecision
 evidenceIds?:string[]
}
export async function contextClaimFacts(pool:pg.Pool|pg.PoolClient,installationId:string,versionIds:readonly string[],options:{lock?:boolean;includeEvidenceIds?:boolean}={}):Promise<Map<string,ContextClaimFacts>>{
 if(!versionIds.length)return new Map()
 const rows=(await pool.query(`SELECT l.storage_tier,l.body_state,l.assertion_mode,logical.space_id::text,space.destinations,space.state AS space_state,cp.consume_mode,${ORIGIN_POLICY_REQUIRED_SQL} AS origin_policy_required,v.version_id::text,c.claim_id::text,c.scope_kind,c.scope_key,v.repository_id::text,v.repo_snapshot_id::text,v.branch,
   to_jsonb(v)->'applicability' AS applicability,to_jsonb(c)->>'consumption_hold_reason' AS consumption_hold_reason,
   to_jsonb(c)->>'canonical_repository_key' AS canonical_repository_key,r.canonical_remote,
   (c.state='active' AND ${currentClaimVersionSql()}) AS current,
   ((v.valid_from IS NULL OR v.valid_from<=clock_timestamp()) AND (v.valid_until IS NULL OR v.valid_until>clock_timestamp())) AS time_eligible,
   ((v.repository_id IS NULL OR (r.repository_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id)))
     AND (v.repo_snapshot_id IS NULL OR (s.repo_snapshot_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=s.installation_id AND t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha)))) AS source_metadata_owned
   ${options.includeEvidenceIds?`, ARRAY(
     SELECT e.evidence_id::text FROM knowledge_evidence e
     WHERE e.installation_id=v.installation_id AND e.version_id=v.version_id
     ORDER BY e.ordinal ASC LIMIT 4
   ) AS evidence_ids`:''}
   FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id)
   LEFT JOIN memory_claim_lifecycle l ON l.installation_id=c.installation_id AND l.claim_id=c.claim_id
   LEFT JOIN memory_logical_claims logical ON logical.installation_id=c.installation_id AND logical.claim_id=c.claim_id
   LEFT JOIN memory_spaces space ON space.installation_id=logical.installation_id AND space.space_id=logical.space_id
   LEFT JOIN memory_curation_policies cp ON cp.installation_id=c.installation_id
   LEFT JOIN repositories r ON r.installation_id=v.installation_id AND r.repository_id=v.repository_id
   LEFT JOIN repo_snapshots s ON s.installation_id=v.installation_id AND s.repository_id=v.repository_id AND s.repo_snapshot_id=v.repo_snapshot_id
   WHERE v.installation_id=$1 AND v.version_id=ANY($2::uuid[]) ${options.lock?'FOR SHARE OF c,v':''}`,[installationId,versionIds])).rows
 const origin=await originPolicyDecisions(pool,installationId,rows.filter(row=>row.origin_policy_required).map(row=>row.version_id))
 return new Map(rows.map(row=>[row.version_id,{versionId:row.version_id,claimId:row.claim_id,scopeKind:row.scope_kind,scopeKey:row.scope_key,
  repositoryId:row.repository_id,snapshotId:row.repo_snapshot_id,branch:row.branch,applicability:row.applicability,
  canonicalRepositoryKey:row.canonical_repository_key,consumptionHoldReason:row.consumption_hold_reason,canonicalRemote:row.canonical_remote,
  lifecycle:{assertionMode:row.assertion_mode,hot:(!row.storage_tier||row.storage_tier==='hot')&&(!row.body_state||row.body_state==='present'),spaceId:row.space_id,destinations:row.destinations??[],spaceActive:row.space_state==='active',consume:row.consume_mode==='enabled'},
  ...(options.includeEvidenceIds?{evidenceIds:row.evidence_ids}:{}),
  current:row.current,timeEligible:row.time_eligible,sourceMetadataOwned:row.source_metadata_owned,...(row.origin_policy_required?{originPolicy:origin.get(row.version_id)??{eligible:false,reason:'origin_policy_requires_review' as const,stamp:null}}:{})}]))
}
export function eligibleContextFacts(facts:ContextClaimFacts,frame:ContextQueryFrame):boolean{
 if(facts.lifecycle){const l=facts.lifecycle;if(!l.hot||l.assertionMode==='planned')return false;if(l.spaceId&&(!frame.lifecycle?.consume||!l.consume||!l.spaceActive||l.spaceId!==frame.lifecycle.spaceId||!l.destinations.includes(frame.lifecycle.destination)))return false}
 if(facts.originPolicy&&!facts.originPolicy.eligible)return false
 if(!facts.current||!facts.timeEligible||!contextClaimEligible(facts,frame))return false
 if(facts.applicability!=null&&(!facts.sourceMetadataOwned||(['repository','snapshot','branch'].includes(facts.scopeKind)
  &&!canonicalRepositoryRemotes(facts.canonicalRepositoryKey??'').includes(facts.canonicalRemote??''))))return false
 return true
}

/** Derived Wiki citations keep their original own-installation references.
 * Resolving a citation never grants foreign read or broadens applicability. */
export async function contextWikiBuildSourcesEligible(pool:pg.Pool|pg.PoolClient,installationId:string,runId:string|null,frame:ContextQueryFrame):Promise<boolean>{
 if(!runId)return true // Legacy code-only Wiki has no Claim source registry.
 const refs=(await pool.query(`SELECT CASE WHEN bs.source_kind='claim_version' THEN v.version_id ELSE e.version_id END::text AS version_id
  FROM memory_wiki_build_sources bs
  LEFT JOIN knowledge_versions v ON v.installation_id=bs.installation_id AND v.version_id=bs.source_ref_id AND bs.source_kind='claim_version'
  LEFT JOIN knowledge_evidence e ON e.installation_id=bs.installation_id AND e.evidence_id=bs.source_ref_id AND bs.source_kind='evidence'
  WHERE bs.installation_id=$1 AND bs.run_id=$2 AND bs.source_kind IN('claim_version','evidence')`,[installationId,runId])).rows
 if(refs.some(r=>!r.version_id))return false
 const ids=[...new Set(refs.map(r=>String(r.version_id)))],facts=await contextClaimFacts(pool,installationId,ids)
 return ids.every(id=>{const fact=facts.get(id);return !!fact&&eligibleContextFacts(fact,frame)})
}

/** Wiki items are external pack items; their exact cited Version clocks must
 * still be checked atomically when a nonce hands the frozen derived bytes out. */
export const WIKI_SOURCE_TIME_INVALID_SQL=`EXISTS(SELECT 1 FROM jsonb_to_recordset(COALESCE(p.selected_references,'[]'::jsonb))
 ref(source_kind text,source_version uuid,installation_id uuid)
 JOIN memory_wiki_versions wv ON wv.installation_id=p.installation_id AND wv.wiki_version_id=ref.source_version
 JOIN memory_wiki_build_sources bs ON bs.installation_id=wv.installation_id AND bs.run_id=wv.build_run_id AND bs.source_kind IN('claim_version','evidence')
 LEFT JOIN knowledge_evidence we ON we.installation_id=bs.installation_id AND we.evidence_id=bs.source_ref_id AND bs.source_kind='evidence'
 JOIN knowledge_versions cited ON cited.installation_id=bs.installation_id AND cited.version_id=CASE WHEN bs.source_kind='claim_version' THEN bs.source_ref_id ELSE we.version_id END
 WHERE ref.source_kind='wiki_section' AND ref.installation_id=p.installation_id
  AND (NOT ${deliveryVersionAvailableSql('cited')} OR NOT ${revisionTimeSql('cited')} OR (cited.valid_from IS NOT NULL AND cited.valid_from>clock_timestamp()) OR (cited.valid_until IS NOT NULL AND cited.valid_until<=clock_timestamp())))`
