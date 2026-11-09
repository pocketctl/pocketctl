import {canonicalJsonString,canonicalPayloadHash,parseAcceptedDeliveryProvenance,teamReaderProjectionKey,teamSourceSessionId,acceptedDeliverySourceSessionId,type SourceScope,type SourceRoot,type ResolvedSourceBody} from '@pocketctl/session-source'
type ObjectValue=Record<string,unknown>
interface Fact {semanticKey:string;businessDigest:string;semanticSessionId:string;semanticTurnId:string;eventType:string;core:ObjectValue;witness:TeamSemanticWitness}
export interface TeamSemanticWitness {witnessKey:string;scope:SourceScope;root:SourceRoot;canonicalKey:string;wireKey:string;sessionKey:string;turnKey:string;eventType:string;occurredAt:string;classification:ObjectValue;contentHash:string;provenance:ObjectValue}
export interface PreparedTeamSemanticGroup {readonly token:object;readonly semanticKey:string;readonly businessDigest:string;readonly semanticSessionId:string;readonly semanticTurnId:string;readonly eventType:string;readonly witnesses:readonly TeamSemanticWitness[];readonly publishReady:false}
const facts=new WeakMap<object,Fact>(),groups=new WeakMap<object,{core:ObjectValue;witnesses:TeamSemanticWitness[]}>()
const object=(v:unknown):ObjectValue|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as ObjectValue:undefined
const hash=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
const invalid=():never=>{throw Error('team_semantic_proof_invalid')}
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=1024
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0
/** Normalize only an already resolved native adapter body. Permission envelope
 * differences do not change a business role, but every original proof remains
 * a separate witness. This token does not authorize projection or disclosure. */
export function normalizeTeamSemanticBody(scope:SourceScope,root:SourceRoot,body:ResolvedSourceBody):object{
 const {head}=body,payload=object(body.payload),proof=object(head.provenance.team),access=object(proof?.read_scope)
 if(!['team_collaboration','team_delivery'].includes(root.kind)||head.kind!==root.kind||head.rootKey!==root.key||head.storage!=='team'
  ||head.provenance.state!=='known'||!payload||!proof||!access||proof.source_kind!=='team_session'
  ||canonicalJsonString(payload.team_source)!==canonicalJsonString(proof)||head.contentHash!==hash(payload)
  ||head.hashVersion!=='canonical-json-sha256-v1'||!text(head.occurredAt)||!Number.isFinite(Date.parse(head.occurredAt)))return invalid()
 const version=root.kind==='team_delivery'?2:1,role=({user_goal:'goal',agent_text:'reply',turn_status:'outcome'} as Record<string,string>)[head.eventType]
 if(proof.source_version!==version||!role||![proof.team_id,proof.team_session_id,proof.team_call_id,access.team_memory_binding_id].every(text)
  ||!integer(access.team_memory_binding_revision)||!integer(access.participant_user_id)||!integer(access.participant_revision)
  ||access.kind!=='team_session'||access.team_id!==proof.team_id||access.team_session_id!==proof.team_session_id
  ||!uuid(access.target_installation_id)||!uuid(access.target_owner_scope_id)||!['personal','team','organization'].includes(access.target_owner_scope_kind as string)
  // A personal receiver may consume another installation's binding. Native
  // authority and commit locks prove that relation; this helper cannot. Direct
  // shared-owner readers must still be the binding's exact target tuple.
  ||scope.ownerScopeKind!=='personal'&&(access.target_installation_id!==scope.installationId||access.target_owner_scope_kind!==scope.ownerScopeKind||access.target_owner_scope_id!==scope.ownerScopeId)
  ||String(access.participant_user_id)!==scope.principalUserId||String(access.participant_revision)!==scope.participantRevision||String(access.team_memory_binding_revision)!==scope.bindingRevision
  ||proof.reader_projection_id!==`${access.team_memory_binding_id}:${access.team_memory_binding_revision}:${access.participant_user_id}:${access.participant_revision}`)return invalid()
 let original:string,session:string,wire:string,identity:unknown[]
 if(version===1){
  original=`team:${proof.team_id}:${proof.team_session_id}:${proof.team_call_id}`
  session=teamSourceSessionId({teamSessionId:proof.team_session_id as string,bindingId:access.team_memory_binding_id as string,bindingRevision:access.team_memory_binding_revision,participantRevision:access.participant_revision})
  wire=`team:${proof.team_call_id}:${role}:u${access.participant_user_id}:b${access.team_memory_binding_revision}:v1`
  identity=[root.kind,'1',proof.team_id,proof.team_session_id,proof.team_call_id]
  if(head.turnKey!==`team-call:${proof.team_call_id}`||root.key!==proof.team_call_id||!Array.isArray(proof.team_event_ids)||!proof.team_event_ids.length||!Array.isArray(proof.team_event_seqs)||proof.team_event_ids.length!==proof.team_event_seqs.length)return invalid()
 }else{
  const delivery=parseAcceptedDeliveryProvenance(proof.accepted_delivery);if(!delivery)return invalid()
  original=`team-delivery:${delivery.submission_id}:${delivery.decision_id}`
  session=acceptedDeliverySourceSessionId({teamSessionId:proof.team_session_id as string,submissionId:delivery.submission_id,decisionId:delivery.decision_id,bindingId:access.team_memory_binding_id as string,bindingRevision:access.team_memory_binding_revision,userId:access.participant_user_id,participantRevision:access.participant_revision})
  wire=`${original}:${role}:${session}:v2`
  identity=[root.kind,'2',proof.team_id,proof.team_session_id,delivery.submission_id,delivery.decision_id]
  if(head.turnKey!==original||root.key!==session)return invalid()
 }
 const projectionKey=teamReaderProjectionKey(wire,proof as never)
 if(head.sessionKey!==session||![wire,projectionKey].includes(head.canonicalKey)||proof.original_source_id!==original)return invalid()
 const partition=[scope.installationId,scope.ownerScopeKind,scope.ownerScopeId,access.team_memory_binding_id,String(access.team_memory_binding_revision)]
 const stableAccess=structuredClone(access);delete stableAccess.participant_user_id;delete stableAccess.participant_revision
 const stableProof:ObjectValue={...structuredClone(proof),read_scope:stableAccess};delete stableProof.reader_projection_id
 const businessPayload=structuredClone(payload);delete businessPayload.team_source
 const core={identity:[...identity,role],partition,eventType:head.eventType,occurredAt:head.occurredAt,classification:structuredClone(head.classification),payload:businessPayload,
  provenance:{...structuredClone(head.provenance),team:stableProof}}
 if(Buffer.byteLength(canonicalJsonString(core))>2*1024*1024)return invalid()
 const group=hash([partition,identity]),semanticKey=hash([partition,identity,role])
 const witness:TeamSemanticWitness={witnessKey:hash([scope,root,projectionKey]),scope:structuredClone(scope),root:structuredClone(root),canonicalKey:projectionKey,wireKey:wire,sessionKey:head.sessionKey,turnKey:head.turnKey!,eventType:head.eventType,occurredAt:head.occurredAt!,classification:structuredClone(head.classification),contentHash:head.contentHash,provenance:structuredClone(head.provenance)}
 const token=Object.freeze({});facts.set(token,{semanticKey,businessDigest:hash(core),semanticSessionId:'team_semantic_'+group,semanticTurnId:'team-semantic:'+group,eventType:head.eventType,core,witness});return token
}
/** Registration groundwork only. A complete current witness set, durable
 * registration and semantic consumer/evidence guards are still required.
 * No caller-controlled DTO can mint a prepared body or silently rebind a UUID. */
export function groupTeamSemanticFacts(tokens:readonly object[]):PreparedTeamSemanticGroup[]{
 if(tokens.length>4096)throw Error('team_semantic_limit')
 const combined=new Map<string,{fact:Fact;witnesses:Map<string,TeamSemanticWitness>}>();let bytes=0
 for(const token of tokens){
  const fact=facts.get(token);if(!fact)return invalid()
  bytes+=Buffer.byteLength(canonicalJsonString(fact.core));if(bytes>32*1024*1024)throw Error('team_semantic_limit')
  const previous=combined.get(fact.semanticKey)
  if(previous&&previous.fact.businessDigest!==fact.businessDigest)throw Error('team_semantic_conflict')
  const group=previous??{fact,witnesses:new Map<string,TeamSemanticWitness>()}
  const priorWitness=group.witnesses.get(fact.witness.witnessKey)
  if(priorWitness&&canonicalJsonString(priorWitness)!==canonicalJsonString(fact.witness))throw Error('team_semantic_conflict')
  group.witnesses.set(fact.witness.witnessKey,fact.witness);combined.set(fact.semanticKey,group)
 }
 return [...combined.values()].sort((a,b)=>a.fact.semanticKey.localeCompare(b.fact.semanticKey)).map(({fact,witnesses})=>{
  const all=[...witnesses.values()].sort((a,b)=>a.witnessKey.localeCompare(b.witnessKey)),token=Object.freeze({})
  groups.set(token,{core:structuredClone(fact.core),witnesses:structuredClone(all)})
  return Object.freeze({token,semanticKey:fact.semanticKey,businessDigest:fact.businessDigest,semanticSessionId:fact.semanticSessionId,semanticTurnId:fact.semanticTurnId,eventType:fact.eventType,
   get witnesses(){return structuredClone(all)},publishReady:false as const})
 })
}

/** Private proof accessor for preparatory metadata persistence. It accepts only
 * our WeakMap token and never exposes normalized business payload. */
export function teamSemanticRegistrationMetadata(token:object){
 const prepared=groups.get(token);if(!prepared)return invalid()
 const {core}=prepared,partition=core.partition as string[],identity=core.identity as string[]
 const group=hash([partition,identity.slice(0,-1)])
 return {semanticKey:hash([partition,identity.slice(0,-1),identity.at(-1)]),businessDigest:hash(core),
  semanticSessionId:'team_semantic_'+group,semanticTurnId:'team-semantic:'+group,
  identity:structuredClone(identity),partition:structuredClone(partition),eventType:core.eventType as string,occurredAt:core.occurredAt as string,
  classification:structuredClone(core.classification),provenance:structuredClone(core.provenance),witnesses:structuredClone(prepared.witnesses)}
}

/** Internal publication/resolution accessor. The token was produced only by
 * native body normalization and same-business grouping in this module. */
export function teamSemanticPreparedRole(token:object){
 const prepared=groups.get(token);if(!prepared)return invalid()
 const metadata=teamSemanticRegistrationMetadata(token),identity=metadata.identity,partition=metadata.partition
 const native=object(object(metadata.provenance)?.team);if(!native)return invalid()
 const proof={source_kind:'team_semantic',source_version:1,normalization_version:'team-semantic-v1',native_kind:identity[0],structured_identity:identity,
  receiving_installation_id:partition[0],owner_scope_kind:partition[1],owner_scope_id:partition[2],binding_id:partition[3],binding_revision:partition[4],
  semantic_session_id:metadata.semanticSessionId,semantic_turn_id:metadata.semanticTurnId,role:identity.at(-1),business_digest:metadata.businessDigest,native}
 const payload={...(structuredClone(prepared.core.payload) as ObjectValue),team_source:proof}
 return {...metadata,provenance:proof,payload,payloadHash:hash(payload)}
}


/** Separate semantic descriptor; native decimal SourceVersion is unchanged. */
export function parseTeamSemanticSourceVersion(value:unknown):{normalization:'team-semantic-v1';businessDigest:string;originalSupportDigest:string}|null{
 const v=object(value)
 if(!v||Object.keys(v).sort().join(',')!=='businessDigest,normalization,originalSupportDigest'||v.normalization!=='team-semantic-v1'
  ||typeof v.businessDigest!=='string'||!/^[a-f0-9]{64}$/.test(v.businessDigest)
  ||typeof v.originalSupportDigest!=='string'||!/^[a-f0-9]{64}$/.test(v.originalSupportDigest)||Buffer.byteLength(canonicalJsonString(v))>512)return null
 return {normalization:'team-semantic-v1',businessDigest:v.businessDigest,originalSupportDigest:v.originalSupportDigest}
}
