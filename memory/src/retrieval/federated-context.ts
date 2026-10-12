import {createHash,randomUUID} from 'node:crypto'
import type pg from 'pg'
import type {ValidatedV2Grant} from '../governance/authorization.js'
import {confirmedCanonicalRepositoryKey} from '../governance/applicability.js'
import {canonicalRepositoryRemotes} from '../governance/publication-applicability.js'
import type {SelectedScope,FederatedSearchPage} from './federated-search-service.js'
import type {RecallResult} from './recall-service.js'
export interface RepositoryContextProof {installationId:string;repositoryId:string;repoSnapshotId:string|null;commitSha:string|null}
export interface ScopeQueryContext {
 repositoryId:string|null;repoSnapshotId:string|null;branch:string|null;taskScopeKey:string|null
 canonicalRepositoryKey?:string|null;snapshotCommitSha?:string|null;requireUniqueCanonicalRepository?:boolean;repositoryContextValidated?:boolean
 sourceRepositoryContext?:RepositoryContextProof
}
export type ResolvedScopeContext={context:ScopeQueryContext;reason:null}|{context:null;reason:string}

/** Only exact recorded transport forms establish host/path identity; cwd/name never does. */
export function repositoryKeyFromRecordedRemote(remote:string|null):string|null {
 if(!remote)return null
 let key:string
 if(/^https?:\/\//.test(remote))key=remote.replace(/^https?:\/\//,'')
 else if(remote.startsWith('ssh://git@'))key=remote.slice('ssh://git@'.length)
 else {
  const scp=/^git@([a-z0-9.-]+):(.+)$/.exec(remote)
  if(!scp)return null
  key=scp[1]+'/'+scp[2]
 }
 if(key.endsWith('.git'))key=key.slice(0,-4)
 return confirmedCanonicalRepositoryKey(key)&&canonicalRepositoryRemotes(key).includes(remote)?key:null
}

/** Resolve inside the readable primary/explicitly selected scopes; never look up a foreign UUID. */
export async function resolveFederatedScopeContexts(pool:pg.Pool,input:{
 grant:ValidatedV2Grant;scopes:readonly SelectedScope[];repositoryId?:string|null;repoSnapshotId?:string|null
 branch?:string|null;taskScopeKey?:string|null
}):Promise<{contexts:Map<string,ResolvedScopeContext>;fingerprint?:string}> {
 const context:ScopeQueryContext={repositoryId:input.repositoryId??null,repoSnapshotId:input.repoSnapshotId??null,
  branch:input.branch??null,taskScopeKey:input.taskScopeKey??null}
 const contexts=new Map<string,ResolvedScopeContext>()
 const scoped=Object.values(context).some(value=>value!==null)
 if(!scoped){for(const scope of input.scopes)contexts.set(scope.installationId,{context:{...context},reason:null});return{contexts}}
 const selected=new Set(input.scopes.map(s=>s.installationId))
 const readable=input.grant.scopeBindings.filter(b=>b.permissions.includes('read')
  &&(selected.has(b.installation_id)||b.installation_id===input.grant.primaryInstallationId)).map(b=>b.installation_id)
 const deny=(scope:string,reason:string)=>contexts.set(scope,{context:null,reason})
 type RepositoryContext={installation_id:string;repository_id:string;canonical_remote:string|null;repo_snapshot_id:string|null;commit_sha:string|null}
 let source:RepositoryContext|undefined,sourceReason='repository_context_required'
 if(context.repositoryId||context.repoSnapshotId){
  if(!readable.length)sourceReason='source_context_forbidden'
  else{
   const rows=(await pool.query<RepositoryContext>(`SELECT r.installation_id::text,r.repository_id::text,r.canonical_remote,s.repo_snapshot_id::text,s.commit_sha
    FROM repositories r LEFT JOIN repo_snapshots s ON s.installation_id=r.installation_id AND s.repository_id=r.repository_id AND s.repo_snapshot_id=$3
    WHERE r.installation_id=ANY($1::uuid[])
     AND (($2::uuid IS NOT NULL AND r.repository_id=$2) OR ($2::uuid IS NULL AND s.repo_snapshot_id=$3))
     AND ($3::uuid IS NULL OR s.repo_snapshot_id IS NOT NULL)
     AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id)
     AND ($3::uuid IS NULL OR NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id AND t.commit_sha=s.commit_sha))
    ORDER BY r.installation_id,r.repository_id LIMIT 2`,[readable,context.repositoryId,context.repoSnapshotId])).rows
   if(rows.length===1){source=rows[0];sourceReason='repository_mapping_required'}
   else sourceReason=readable.includes(input.grant.primaryInstallationId)?'source_context_unavailable':'source_context_forbidden'
  }
 }
 const canonical=repositoryKeyFromRecordedRemote(source?.canonical_remote??null)
 await Promise.all(input.scopes.map(async scope=>{
  const id=scope.installationId
  if(context.taskScopeKey&&id!==input.grant.primaryInstallationId){deny(id,'task_mapping_required');return}
  if(!context.repositoryId&&!context.repoSnapshotId){
   if(id===input.grant.primaryInstallationId)contexts.set(id,{context:{...context},reason:null})
   else deny(id,sourceReason)
   return
  }
  if(!source){deny(id,sourceReason);return}
  if(context.repoSnapshotId&&(!source.commit_sha||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit_sha))){deny(id,'snapshot_proof_requires_review');return}
  if(id===source.installation_id){
   contexts.set(id,{context:{...context,repositoryId:source.repository_id,repoSnapshotId:source.repo_snapshot_id,
    canonicalRepositoryKey:canonical,snapshotCommitSha:source.commit_sha,repositoryContextValidated:true},reason:null});return
  }
  if(!canonical){deny(id,'repository_mapping_required');return}
  const repositories=(await pool.query<{repository_id:string}>(`SELECT r.repository_id::text FROM repositories r
   WHERE r.installation_id=$1 AND r.canonical_remote=ANY($2::text[])
    AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id)
   ORDER BY r.repository_id LIMIT 2`,[id,canonicalRepositoryRemotes(canonical)])).rows
  if(repositories.length!==1){deny(id,repositories.length?'repository_mapping_ambiguous':'repository_mapping_required');return}
  const repositoryId=repositories[0].repository_id
  let repoSnapshotId:string|null=null
  if(context.repoSnapshotId){
   const snapshots=(await pool.query<{repo_snapshot_id:string}>(`SELECT s.repo_snapshot_id::text FROM repo_snapshots s
    WHERE s.installation_id=$1 AND s.repository_id=$2 AND s.commit_sha=$3
     AND NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=s.installation_id AND t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha)
    ORDER BY s.repo_snapshot_id LIMIT 2`,[id,repositoryId,source.commit_sha])).rows
   if(snapshots.length!==1){deny(id,snapshots.length?'snapshot_mapping_ambiguous':'snapshot_mapping_required');return}
   repoSnapshotId=snapshots[0].repo_snapshot_id
  }
  contexts.set(id,{context:{...context,repositoryId,repoSnapshotId,canonicalRepositoryKey:canonical,
   snapshotCommitSha:source.commit_sha,requireUniqueCanonicalRepository:true,repositoryContextValidated:true,
   sourceRepositoryContext:{installationId:source.installation_id,repositoryId:source.repository_id,repoSnapshotId:source.repo_snapshot_id,commitSha:source.commit_sha}},reason:null})
 }))
 // Selection order is stable even though independent target lookups finish out of order.
 const fingerprint=createHash('sha256').update(JSON.stringify(input.scopes.map(s=>[s.installationId,contexts.get(s.installationId)]))).digest('hex')
 return{contexts,fingerprint}
}
export function unavailableScopeSearchPage<T>(reason:string):FederatedSearchPage<T>{
 return{hits:[],nextCursor:null,degradedComponents:['scope_context_unavailable',reason],poolSizes:{}}
}
export function unavailableScopeRecall(reason:string):RecallResult{
 return{requestId:randomUUID(),degradedComponents:['scope_context_unavailable',reason],claims:[],conflicts:[],relatedEpisodes:[],coverageGaps:[reason],totalChars:0}
}
