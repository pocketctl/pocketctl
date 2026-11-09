import {ACTIONS,type Action,type CatalogObject,type ObjectPlan} from './classification.js'
import {TABLE_POLICY} from './table-policy.js'
import {JSON_COLUMN_POLICY} from './json-reference-policy.js'
import {canonicalJsonString} from '../../inbox/canonical-json.js'
export interface CatalogReviewProofs {
 internalTriggers:readonly {liveKey:string;liveDefinitionHash:string;baselineKey:string;baselineDefinitionHash:string}[]
 sequenceStateProofs:readonly {key:string;definitionHash:string;baselineConfigHash:string}[]
 extensionMembers:readonly string[]
 memoryDatabaseOwnerFingerprint?:string
 relayDatabaseOwnerFingerprint?:string
}
const digest=/^[a-f0-9]{64}$/
function normalizedAcl(object:CatalogObject):string|undefined{
 if(typeof object.ownerFingerprint!=='string'||!digest.test(object.ownerFingerprint)||!Array.isArray(object.grants))return undefined
 const normalized=[]
 for(const grant of object.grants){
  if(!grant||typeof grant!=='object'||typeof grant.grantorFingerprint!=='string'||typeof grant.granteeFingerprint!=='string'
   ||!digest.test(grant.grantorFingerprint)||!digest.test(grant.granteeFingerprint)||typeof grant.public!=='boolean'||typeof grant.grantable!=='boolean'||typeof grant.privilege!=='string')return undefined
  normalized.push([grant.grantorFingerprint===object.ownerFingerprint?'owner':grant.grantorFingerprint,
   grant.granteeFingerprint===object.ownerFingerprint?'owner':grant.public?'public':grant.granteeFingerprint,grant.privilege,grant.grantable])
 }
 return canonicalJsonString(normalized.sort((a,b)=>canonicalJsonString(a).localeCompare(canonicalJsonString(b))))
}
/** The baseline is a separately reproduced source-code schema, not a second
 * copy of the live catalog. Proofs bind exact definition hashes; parent/name
 * similarity cannot approve a changed or previously unknown Memory object.
 * These are dispositions only, never authority to copy/drop/activate data. */
export function reviewMemoryObjects(live:readonly CatalogObject[],baseline:readonly CatalogObject[],proofs:CatalogReviewProofs){
 for(const key of ['internalTriggers','sequenceStateProofs','extensionMembers'] as const)
  if(!Object.hasOwn(proofs,key)||!Array.isArray(proofs[key]))throw Error('invalid_catalog_review_proofs')
 for(const key of ['memoryDatabaseOwnerFingerprint','relayDatabaseOwnerFingerprint'] as const)
  if(Object.hasOwn(proofs,key)&&!digest.test(proofs[key]??''))throw Error('invalid_catalog_review_proofs')
 const counts=new Map<string,number>(),baseCounts=new Map<string,number>(),base=new Map(baseline.map(o=>[o.key,o]))
 for(const o of live)counts.set(o.key,(counts.get(o.key)??0)+1)
 for(const o of baseline)baseCounts.set(o.key,(baseCounts.get(o.key)??0)+1)
 const usedProofs=new Map<string,number>()
 for(const proof of proofs.internalTriggers)usedProofs.set(proof.baselineKey,(usedProofs.get(proof.baselineKey)??0)+1)
 const plan:ObjectPlan=Object.create(null),reviewed:{key:string;action:Action;definitionHash:string;evidence:string}[]=[],unreviewed:{key:string;reason:string}[]=[]
 const extensionKeys=new Set(proofs.extensionMembers)
 for(const object of live){
  let action:Action|undefined,evidence=''
  const original=base.get(object.key),exact=original?.kind===object.kind&&original.definitionHash===object.definitionHash&&(baseCounts.get(object.key)===1)
  const knownParent=typeof object.parent==='string'&&Object.hasOwn(TABLE_POLICY,object.parent)
  if((counts.get(object.key)??0)!==1){unreviewed.push({key:object.key,reason:'catalog_identity_collision'});continue}
  if(original&&baseCounts.get(object.key)!==1){unreviewed.push({key:object.key,reason:'baseline_identity_collision'});continue}
  if(!digest.test(object.definitionHash)){unreviewed.push({key:object.key,reason:'invalid_definition_hash'});continue}
  if(object.valid===false||object.ready===false){unreviewed.push({key:object.key,reason:'invalid_object'});continue}
  if(object.schema==='public')switch(object.kind){
   case 'table':
    if(exact&&Object.hasOwn(TABLE_POLICY,object.name)){const value=TABLE_POLICY[object.name];if(ACTIONS.includes(value as Action)){action=value as Action;evidence='reproduced_source_table'}}
    break
   case 'json-column':
    if(exact&&knownParent&&Object.hasOwn(JSON_COLUMN_POLICY,object.name)){action=JSON_COLUMN_POLICY[object.name].action;evidence='reproduced_typed_json_column'}
    break
   case 'function':
    if(exact){action=extensionKeys.has(object.key)?'retain-relay':'transform';evidence='reproduced_source_function'}
    break
   case 'constraint':case 'foreign-key':
    if(exact&&knownParent&&(object.kind!=='foreign-key'||object.referencedSchema==='public'&&typeof object.referencedTable==='string'&&Object.hasOwn(TABLE_POLICY,object.referencedTable))){action='transform';evidence='reproduced_constraint'}
    break
   case 'index':
    if(exact&&knownParent){action=TABLE_POLICY[object.parent as string]==='retire-after-gate'?'retire-after-gate':'derived-rebuild';evidence='reproduced_source_index'}
    break
   case 'trigger':
    if(exact&&knownParent){action=object.internal?'derived-rebuild':'transform';evidence='reproduced_source_trigger'}
    else if(object.internal===true&&knownParent){
     const matches=proofs.internalTriggers.filter(p=>p.liveKey===object.key)
     if(matches.length===1){const p=matches[0],b=base.get(p.baselineKey)
      if(usedProofs.get(p.baselineKey)===1&&b?.kind==='trigger'&&b.internal===true&&b.parent===object.parent&&baseCounts.get(b.key)===1
       &&p.baselineDefinitionHash===b.definitionHash&&p.liveDefinitionHash===object.definitionHash){action='derived-rebuild';evidence='reproduced_fk_trigger_exact_ddl_except_generated_name'}
     }
    }
    break
   case 'sequence':case 'sequence-ownership':
    if(exact){action='migrate-as-is';evidence='reproduced_sequence_definition'}
    break
   case 'sequence-state':{
    const matches=proofs.sequenceStateProofs.filter(p=>p.key===object.key)
    if(original?.kind==='sequence-state'&&matches.length===1&&digest.test(matches[0].baselineConfigHash)&&matches[0].definitionHash===object.definitionHash
     &&object.stateReadable===true&&typeof object.lastValue==='string'&&/^-?(0|[1-9][0-9]*)$/.test(object.lastValue)&&BigInt(object.lastValue).toString()===object.lastValue&&BigInt(object.lastValue)>=-9223372036854775808n&&BigInt(object.lastValue)<=9223372036854775807n&&typeof object.isCalled==='boolean'){
     action='migrate-as-is';evidence='reproduced_sequence_config_with_exact_decimal_live_state'
    }
    break
   }
   case 'schema':
    if(exact&&object.name==='public'){action='transform';evidence='reproduced_memory_namespace'}
    break
   case 'type':
    if(exact&&extensionKeys.has(object.key)){action='retain-relay';evidence='reproduced_extension_type'}
    break
  }
  if(object.kind==='extension'&&exact){action='retain-relay';evidence='reproduced_extension'}
  if(object.kind==='permission'){
   const acl=normalizedAcl(object),before=original&&normalizedAcl(original)
   if(original&&acl!==undefined&&before===acl){
    const target=object.key.replace(/^permission:([^.]*)\.function\./,'function:$1.').replace(/^permission:([^.]*)\.type\./,'type:$1.')
    action=extensionKeys.has(target)?'retain-relay':'transform';evidence='exact_acl_bits_with_owner_role_substitution'
   }else if(object.schema==='*'&&object.key.startsWith('permission:*.database.')&&object.ownerFingerprint===proofs.memoryDatabaseOwnerFingerprint&&Array.isArray(object.grants)
     &&object.grants.length===3&&object.grants.every(g=>g&&g.grantorFingerprint===object.ownerFingerprint&&g.granteeFingerprint===object.ownerFingerprint&&g.public===false&&g.grantable===false)
     &&canonicalJsonString(object.grants.map(g=>g.privilege).sort())===canonicalJsonString(['CONNECT','CREATE','TEMPORARY'])){
    action='audit-archive';evidence='legacy_database_owner_acl_not_imported_to_shared_target'
   }
  }
  if(object.kind==='role'){
   if(exact){action='retain-relay';evidence='unchanged_platform_role'}
   else if([proofs.memoryDatabaseOwnerFingerprint,proofs.relayDatabaseOwnerFingerprint].includes(object.name)
    &&object.superuser===false&&object.createRole===false&&object.createDatabase===false&&object.bypassRls===false&&object.replication===false
    &&typeof object.inherit==='boolean'&&typeof object.canLogin==='boolean'&&Array.isArray(object.memberships)&&object.memberships.length===0
    &&typeof object.settingsFingerprint==='string'&&digest.test(object.settingsFingerprint)){
    action=object.name===proofs.memoryDatabaseOwnerFingerprint&&object.name!==proofs.relayDatabaseOwnerFingerprint?'retire-after-gate':'retain-relay'
    evidence='explicit_scoped_service_role_never_copies_privileges_or_settings'
   }
  }
  if(!action){unreviewed.push({key:object.key,reason:'independent_definition_or_disposition_proof_required'});continue}
  plan[object.key]={action,definitionHash:object.definitionHash};reviewed.push({key:object.key,action,definitionHash:object.definitionHash,evidence})
 }
 return {schemaVersion:1,reportType:'memory-source-object-review',reviewScope:'provided_object_set',providedObjects:live.length,sourceTableRosterComplete:Object.keys(TABLE_POLICY).every(name=>live.some(o=>o.kind==='table'&&o.schema==='public'&&o.name===name)),plan,reviewed,unreviewed,allObjectsReviewed:unreviewed.length===0,
  migrationAuthorized:false,mappingExecuted:false,bodyExported:false}
}

/** Relay objects are outside the Memory import/delete scope. This frozen
 * preservation roster is deliberately separate from the independently rebuilt
 * Memory schema. Any subsequent definition or roster drift needs a new review. */
export function reviewRelayObjects(live:readonly CatalogObject[],frozen:readonly CatalogObject[],memoryOwner?:string){
 const counts=new Map<string,number>(),beforeCounts=new Map<string,number>(),before=new Map(frozen.map(o=>[o.key,o]))
 for(const o of live)counts.set(o.key,(counts.get(o.key)??0)+1)
 for(const o of frozen)beforeCounts.set(o.key,(beforeCounts.get(o.key)??0)+1)
 const plan:ObjectPlan=Object.create(null),unreviewed:{key:string;reason:string}[]=[]
 for(const o of live){
  const b=before.get(o.key)
  if(counts.get(o.key)!==1||beforeCounts.get(o.key)!==1||!b||b.kind!==o.kind||b.definitionHash!==o.definitionHash||!digest.test(o.definitionHash)||o.valid===false||o.ready===false){
   unreviewed.push({key:o.key,reason:'retained_relay_roster_or_definition_changed'});continue
  }
  plan[o.key]={action:o.kind==='role'&&o.name===memoryOwner?'retire-after-gate':'retain-relay',definitionHash:o.definitionHash}
 }
 const missing=frozen.filter(o=>!counts.has(o.key)).map(o=>o.key)
 return {schemaVersion:1,reportType:'relay-preservation-object-review',providedObjects:live.length,plan,unreviewed,missing,
  allObjectsReviewed:unreviewed.length===0&&missing.length===0,migrationAuthorized:false,relayMutationAuthorized:false,bodyExported:false}
}
