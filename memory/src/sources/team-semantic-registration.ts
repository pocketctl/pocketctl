import {types} from 'node:util'
import {teamSemanticRegistrationTransaction} from './team-semantic-registration-transport.js'
import type pg from 'pg'
import {canonicalJsonString,type SourceRoot,type SourceScope,type SourceVersion} from '@pocketctl/session-source'
import {createObservedSourceReader} from './observed-reader.js'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
import {sourceExecutionBranchFor,sourceExecutionTokenFor,guardSourceExecutionCommit} from './source-execution.js'
import {normalizeTeamSemanticBody,groupTeamSemanticFacts,teamSemanticRegistrationMetadata} from './team-semantic.js'

type Context={scope:SourceScope;root:SourceRoot;version:SourceVersion}
type Metadata=ReturnType<typeof teamSemanticRegistrationMetadata>
interface Prepared {pool:pg.Pool;execution:object;installationId:string;contexts:Context[];groups:Metadata[]}
export interface TeamSemanticRegistration {readonly token:object;readonly count:number;readonly publishReady:false}
export interface TeamSemanticRegistrationResult {semanticRefId:string;semanticKey:string;witnessCount:number;publishReady:false}
const preparations=new WeakMap<object,Prepared>()
function requireExecution(pool:pg.Pool,installationId:string):object{
 if(sourceConnectionKey(pool)!==pool||sourcePoolContext(pool).namespace!=='memory')throw Error('team_semantic_registration_requires_physical_pool')
 const token=sourceExecutionTokenFor(pool,installationId)
 if(!token||sourceExecutionBranchFor(pool,installationId)!=='canonical-active')throw Error('team_semantic_registration_execution_required')
 return token
}
const invalidRequest=():never=>{throw Error('team_semantic_registration_request_invalid')}
/** Reject unknown keys, prototypes and accessors before reading caller values.
 * Reconstruction below is deliberately explicit: no body/config can enter a
 * persisted scope/root through a TypeScript structural extra property. */
function record(value:unknown,keys:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)return invalidRequest()
 const descriptors=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(value)
 if(own.some(key=>typeof key!=='string'||!keys.includes(key)||!('value'in descriptors[key])||!descriptors[key].enumerable)
  ||keys.some(key=>!optional.includes(key)&&!Object.hasOwn(descriptors,key)))return invalidRequest()
 return value as Record<string,unknown>
}
function array(value:unknown,min:number,max:number):unknown[]{
 if(!Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<min||value.length>max)return invalidRequest()
 const own=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value)
 if(own.length!==value.length+1||own.some(key=>typeof key!=='string'||key!=='length'&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length||!('value'in descriptors[key]))))return invalidRequest()
 return value
}
function requestsDto(value:unknown):{scope:SourceScope;root:SourceRoot;keys?:string[]}[]{
 const string=(v:unknown,max=1024):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v)
 const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(v)
 const positive=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n
 const scopeKeys=['installationId','principalUserId','ownerScopeKind','ownerScopeId','authorizationRevision','configVersion','modeGeneration','participantRevision','bindingRevision']
 return array(value,1,64).map(value=>{
  const request=record(value,['scope','root','keys'],['keys']),s=record(request.scope,scopeKeys),r=record(request.root,['kind','key'])
  if(!uuid(s.installationId)||!uuid(s.ownerScopeId)||!['personal','team','organization'].includes(s.ownerScopeKind as string)
   ||!positive(s.principalUserId)||!positive(s.authorizationRevision)||!positive(s.configVersion)||!positive(s.modeGeneration)||!positive(s.participantRevision)||!positive(s.bindingRevision)
   ||!['team_collaboration','team_delivery'].includes(r.kind as string)||!string(r.key))return invalidRequest()
  let keys:string[]|undefined
  if(Object.hasOwn(request,'keys')){keys=array(request.keys,1,64).map(key=>{if(!string(key))return invalidRequest();return key})}
  return {scope:{installationId:s.installationId,principalUserId:s.principalUserId,ownerScopeKind:s.ownerScopeKind as SourceScope['ownerScopeKind'],ownerScopeId:s.ownerScopeId,
   authorizationRevision:s.authorizationRevision,configVersion:s.configVersion,modeGeneration:s.modeGeneration,participantRevision:s.participantRevision,bindingRevision:s.bindingRevision},
   root:{kind:r.kind as SourceRoot['kind'],key:r.key},...(keys?{keys}:{})}
 })
}
/** Native IO and business normalization happen outside BEGIN. Supplied scopes
 * select native authority checks; no caller-supplied payload/proof is accepted.
 * This is a bounded set of witnesses, not a complete-current discovery seal. */
export async function prepareTeamSemanticRegistration(pool:pg.Pool,requests:readonly {scope:SourceScope;root:SourceRoot;keys?:readonly string[]}[]):Promise<TeamSemanticRegistration>{
 const input=requestsDto(requests),installationId=input[0].scope.installationId,execution=requireExecution(pool,installationId)
 const reader=createObservedSourceReader(pool,sourcePoolContext(pool).archive),facts:object[]=[],contexts:Context[]=[]
 let bodyCount=0,metadataBytes=0
 for(const request of [...input].sort((a,b)=>canonicalJsonString(a).localeCompare(canonicalJsonString(b)))){
  if(request.scope.installationId!==installationId||!['team_collaboration','team_delivery'].includes(request.root.kind)
   ||request.keys&&(!request.keys.length||request.keys.length>64))throw Error('team_semantic_registration_request_invalid')
  const page=request.keys?await reader.getHeads(request.scope,request.root,request.keys):await reader.listHeads(request.scope,request.root,{limit:64})
  if('nextCursor'in page&&page.nextCursor)throw Error('team_semantic_registration_limit')
  bodyCount+=page.heads.length;if(bodyCount>192)throw Error('team_semantic_registration_limit')
  const bodies=await reader.resolveBodies(request.scope,request.root,page.heads,page.version)
  if(bodies.length!==page.heads.length)throw Error('team_semantic_proof_invalid')
  for(const body of bodies)facts.push(normalizeTeamSemanticBody(request.scope,request.root,body))
  const context={scope:request.scope,root:request.root,version:page.version}
  metadataBytes+=Buffer.byteLength(canonicalJsonString(context));if(metadataBytes>1024*1024)throw Error('team_semantic_registration_limit')
  if(!contexts.some(c=>canonicalJsonString(c)===canonicalJsonString(context)))contexts.push(context)
 }
 const groups=groupTeamSemanticFacts(facts).map(g=>teamSemanticRegistrationMetadata(g.token))
 for(const group of groups){metadataBytes+=Buffer.byteLength(canonicalJsonString(group));if(metadataBytes>2*1024*1024)throw Error('team_semantic_registration_limit')}
 if(sourceExecutionTokenFor(pool,installationId)!==execution)throw Error('team_semantic_registration_execution_changed')
 const token=Object.freeze({});preparations.set(token,{pool,execution,installationId,contexts,groups})
 return Object.freeze({token,count:groups.length,publishReady:false as const})
}

/** Registration does not create turns, projection receipts, jobs, or usable
 * source evidence. The semantic UUID belongs only to this metadata adapter. */
export async function persistTeamSemanticRegistration(pool:pg.Pool,page:TeamSemanticRegistration):Promise<TeamSemanticRegistrationResult[]>{
 const prepared=preparations.get(page.token)
 if(!prepared||prepared.pool!==pool)throw Error('team_semantic_registration_token_invalid')
 const {installationId,contexts,groups}=prepared
 if(requireExecution(pool,installationId)!==prepared.execution)throw Error('team_semantic_registration_execution_changed')
 return teamSemanticRegistrationTransaction(pool,async client=>{
 const query=client.query.bind(client)
  await guardSourceExecutionCommit(client,installationId)
  // Every native authority/root fence precedes all Memory metadata row locks.
  for(const context of contexts){
   const locked=(await query('SELECT shared.lock_memory_team_source_commit($1::jsonb,$2,$3,$4::jsonb,FALSE) AS locked',
    [JSON.stringify(context.scope),context.root.kind,context.root.key,JSON.stringify(context.version)])).rows[0]?.locked
   if(locked!==true)throw Error('team_semantic_registration_changed')
  }
  if((await query("SELECT pg_try_advisory_xact_lock(hashtextextended('team-semantic-registration:'||$1,0)) AS locked",[installationId])).rows[0]?.locked!==true)throw Error('team_semantic_registration_busy')
  const versions=new Map(contexts.map(c=>[canonicalJsonString([c.scope,c.root]),c.version]))
  const result:TeamSemanticRegistrationResult[]=[]
  for(const g of groups){
   const metadata={adapter_version:'team-semantic-registration-v1',source_kind:g.identity[0],owner_scope_kind:g.partition[1],owner_scope_id:g.partition[2],binding_id:g.partition[3],binding_revision:g.partition[4],
    structured_identity:g.identity,semantic_session_id:g.semanticSessionId,semantic_turn_id:g.semanticTurnId,event_type:g.eventType,classification:g.classification,semantic_provenance:g.provenance}
   let row=(await query('SELECT *,business_digest=$3::bytea AS digest_matches,occurred_at=$4::timestamptz AS time_matches FROM memory_team_semantic_groups WHERE installation_id=$1 AND semantic_key=$2 FOR UPDATE NOWAIT',
    [installationId,g.semanticKey,Buffer.from(g.businessDigest,'hex'),g.occurredAt])).rows[0]
   if(row){
    if(!row.digest_matches||!row.time_matches||Object.entries(metadata).some(([key,value])=>canonicalJsonString(row[key])!==canonicalJsonString(value))
     ||!['preparatory','published'].includes(row.registration_state)||row.provenance_state!=='provenance_unknown')throw Error('team_semantic_registration_conflict')
   }else{
    row=(await query(`INSERT INTO memory_team_semantic_groups(installation_id,semantic_key,adapter_version,source_kind,owner_scope_kind,owner_scope_id,binding_id,binding_revision,
     structured_identity,semantic_session_id,semantic_turn_id,event_type,occurred_at,business_digest,classification,semantic_provenance)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::timestamptz,$14,$15::jsonb,$16::jsonb) RETURNING semantic_ref_id`,
     [installationId,g.semanticKey,metadata.adapter_version,metadata.source_kind,metadata.owner_scope_kind,metadata.owner_scope_id,metadata.binding_id,metadata.binding_revision,
      JSON.stringify(metadata.structured_identity),g.semanticSessionId,g.semanticTurnId,g.eventType,g.occurredAt,Buffer.from(g.businessDigest,'hex'),JSON.stringify(g.classification),JSON.stringify(g.provenance)])).rows[0]
   }
   for(const w of g.witnesses){
    const version=versions.get(canonicalJsonString([w.scope,w.root]))
    if(!version)throw Error('team_semantic_registration_changed')
    const hash=Buffer.from(w.contentHash,'hex')
    const old=(await query(`SELECT canonical_key,wire_key,source_scope,source_root,raw_content_hash,
     COALESCE(original_provenance->'team',original_provenance) AS proof FROM memory_team_semantic_witnesses
     WHERE semantic_ref_id=$1 AND witness_key=$2 FOR UPDATE NOWAIT`,[row.semantic_ref_id,w.witnessKey])).rows[0]
    if(old){
     // Original audit UUIDs and the version observed at first registration
     // survive renewal of the native grant/root. A changed identity never does.
     if(old.canonical_key!==w.canonicalKey||old.wire_key!==w.wireKey||!hash.equals(old.raw_content_hash)
       ||canonicalJsonString(old.proof)!==canonicalJsonString(w.provenance.team)
       ||canonicalJsonString(old.source_scope)!==canonicalJsonString(w.scope)
       ||canonicalJsonString(old.source_root)!==canonicalJsonString(w.root))throw Error('team_semantic_registration_conflict')
    }else await query(`INSERT INTO memory_team_semantic_witnesses(installation_id,semantic_ref_id,witness_key,canonical_key,
      wire_key,raw_canonical_key,source_scope,source_root,source_version,raw_content_hash,original_provenance)
     VALUES($1,$2,$3,$4,$5,$4,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10::jsonb)`,[installationId,row.semantic_ref_id,
      w.witnessKey,w.canonicalKey,w.wireKey,JSON.stringify(w.scope),JSON.stringify(w.root),JSON.stringify(version),hash,JSON.stringify(w.provenance.team)])

   }
   result.push({semanticRefId:row.semantic_ref_id,semanticKey:g.semanticKey,witnessCount:g.witnesses.length,publishReady:false})
  }
  await guardSourceExecutionCommit(client,installationId);return result
 })
}
