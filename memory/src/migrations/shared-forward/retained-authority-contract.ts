/** Untrusted, body-free transport shapes only. Structural validity is never
 * current authority, v4 settlement, or permission to promote global readiness.
 * No DB, filesystem, runtime verifier, or activation API belongs in this file. */
import {createHash} from 'node:crypto'

export const RETAINED_AUTHORITY_KIND='memory-retained-current-authority' as const
export const RETAINED_AUTHORITY_MAX_ROWS=1024
export const RETAINED_AUTHORITY_MAX_BYTES=8*1024*1024
const hashPattern=/^[a-f0-9]{64}$/
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const decimalPattern=/^(0|[1-9][0-9]{0,29})$/
const bindingHashes=['databaseIdentityHash','configHash','catalogHash','keyringHash','sourcePolicyHash','roleIdentityHash','unitsHash','referenceContractHash'] as const
export interface RetainedAuthorityBinding {
 schemaVersion:1;kind:typeof RETAINED_AUTHORITY_KIND;installationIds:readonly string[];
 databaseIdentityHash:string;configHash:string;catalogHash:string;keyringHash:string;
 sourcePolicyHash:string;roleIdentityHash:string;unitsHash:string;referenceContractHash:string;
}
function fail():never{throw Error('retained_authority_contract')}
function exact(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail()
 const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(value)
 if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k))||keys.some(k=>!descriptors[k]||!('value' in descriptors[k])||!descriptors[k].enumerable))fail()
}
function array(value:unknown,min:number,max:number):asserts value is unknown[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<min||value.length>max||Reflect.ownKeys(value).length!==value.length+1)fail()
 for(let n=0;n<value.length;n++){const d=Object.getOwnPropertyDescriptor(value,String(n));if(!d||!('value' in d)||!d.enumerable)fail()}
}
function digest(value:unknown):asserts value is string{if(typeof value!=='string'||!hashPattern.test(value))fail()}
function uuid(value:unknown):asserts value is string{if(typeof value!=='string'||!uuidPattern.test(value))fail()}
function decimal(value:unknown):asserts value is string{if(typeof value!=='string'||!decimalPattern.test(value))fail()}
export function validateRetainedAuthorityBinding(value:unknown):asserts value is RetainedAuthorityBinding{
 exact(value,['schemaVersion','kind','installationIds',...bindingHashes])
 if(value.schemaVersion!==1||value.kind!==RETAINED_AUTHORITY_KIND)fail()
 array(value.installationIds,1,16)
 let previous=''
 for(const id of value.installationIds){uuid(id);if(id<=previous)fail();previous=id}
 for(const key of bindingHashes)digest(value[key])
}
const families=['root','reference','capsule','delivery','authority','v4-original','graph'] as const
const policies=['personal-raw-v1','team-raw-v1','team-raw-v2','independent-accepted-v1','verified-legacy-v1'] as const
const blockers=['source_authority_unproven','source_cleanup_pending','owner_lifecycle_adapter_required','installation_revoked_adapter_required','mixed_team_adapter_required','alias_adapter_required','legacy_custody_adapter_required','job_graph_adapter_required','active_extraction_adapter_required','retained_reference_unclassified','independent_retention_unproved','global_delivery_withdrawn','global_final_capacity_unproved','v4_current_verifier_unavailable'] as const
type Schema='memory'|'public'|'shared'
export interface RetainedAuthorityStream {
 installationId:string;family:typeof families[number];schema:Schema;table:string;column:string|null;
 keyColumns:readonly {name:string;type:'uuid'|'decimal'|'text'}[];
}
export interface RetainedAuthorityCursor {key:readonly string[];occurrence:string}
export interface RetainedAuthorityIdentity extends RetainedAuthorityCursor {
 installationId:string;schema:Schema;table:string;column:string|null;rowVersion:string;metadataFingerprint:string;
}
export interface RetainedV4Original {
 manifestHash:string;table:string;fullPrimaryKey:readonly string[];firstPage:string;firstIndex:string;originalFingerprint:string;
}
export interface RetainedV4Settlement {
 manifestHash:string;immutableManifestChainHash:string;receiptTailHash:string;completedPages:string;totalPages:string;
 originalMembershipHash:string;currentExpectedStateHash:string;nativeOutputHash:string;accountingInvariantHash:string;
 exactNegativeCheckHash:string;currentNativeRestrictionHash:string;skeletonPolicy:'native-personal-minimal-v4';
}
/** These are untrusted observations. No variant is a grant or trusted proof. */
export type RetainedAuthorityRecord=
 |{kind:'positive';item:RetainedAuthorityIdentity;policy:typeof policies[number];currentFactsHash:string;dependencySetHash:string}
 |{kind:'settled-negative-v4';item:RetainedAuthorityIdentity;original:RetainedV4Original;settlement:RetainedV4Settlement}
 |{kind:'blocked';item:RetainedAuthorityIdentity;code:typeof blockers[number];relatedIdentityHashes:readonly string[]}
export interface RetainedAuthorityPage {
 schemaVersion:1;kind:typeof RETAINED_AUTHORITY_KIND;bindingHash:string;streamHash:string;
 ordinal:string;previousHash:string;from:RetainedAuthorityCursor|null;to:RetainedAuthorityCursor|null;
 records:readonly RetainedAuthorityRecord[];recordCount:string;terminal:boolean;membershipHash:string;pageHash:string;
 globalRetainedAuthorityVerified:false;reopeningReady:false;activationAuthorized:false;
}
/** A transport checkpoint, never a database-current or authenticated seal. */
export interface RetainedAuthorityCheckpoint {
 bindingHash:string;streamHash:string;nextOrdinal:string;tailHash:string;records:string;
 cursor:RetainedAuthorityCursor|null;terminal:boolean;
}
const settlementHashes=['manifestHash','immutableManifestChainHash','receiptTailHash','originalMembershipHash','currentExpectedStateHash','nativeOutputHash','accountingInvariantHash','exactNegativeCheckHash','currentNativeRestrictionHash'] as const
function oneOf(value:unknown,choices:readonly string[]):void{if(typeof value!=='string'||!choices.includes(value))fail()}
function identifier(value:unknown):asserts value is string{
 if(typeof value!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(value)||/(^|_)(body|payload|document|statement|excerpt|password|secret|credential|credentials|token|url)(_|$)/.test(value))fail()
}
function textIdentity(value:unknown):asserts value is string{
 if(typeof value!=='string'||!value.length||Buffer.byteLength(value)>512||/[\u0000-\u001f\u007f]/.test(value)||Buffer.from(value,'utf8').toString('utf8')!==value)fail()
}
/** Only called after bounded exact-shape validation; never serializes arbitrary
 * user metadata. PostgreSQL collation/order is not inferred from this encoding. */
function canonical(value:unknown):string{
 if(value===null||typeof value!=='object'){const result=JSON.stringify(value);if(result===undefined)fail();return result}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 const row=value as Record<string,unknown>
 return '{'+Object.keys(row).sort().map(k=>JSON.stringify(k)+':'+canonical(row[k])).join(',')+'}'
}
function encoded(value:unknown):string{const result=canonical(value);if(Buffer.byteLength(result)>RETAINED_AUTHORITY_MAX_BYTES)fail();return result}
function hash(value:unknown):string{return createHash('sha256').update(encoded(value)).digest('hex')}
function same(a:unknown,b:unknown):boolean{return canonical(a)===canonical(b)}
function validateStream(value:unknown,binding:RetainedAuthorityBinding):asserts value is RetainedAuthorityStream{
 exact(value,['installationId','family','schema','table','column','keyColumns'])
 uuid(value.installationId);if(!binding.installationIds.includes(value.installationId))fail()
 oneOf(value.family,families);oneOf(value.schema,['memory','public','shared']);identifier(value.table)
 if(value.column!==null)identifier(value.column)
 array(value.keyColumns,1,16);const names=new Set<string>()
 for(const part of value.keyColumns){exact(part,['name','type']);identifier(part.name);oneOf(part.type,['uuid','decimal','text']);if(names.has(part.name))fail();names.add(part.name)}
}
function context(binding:unknown,stream:unknown){
 validateRetainedAuthorityBinding(binding);validateStream(stream,binding)
 const bindingHash=hash(binding),streamHash=hash({bindingHash,stream})
 return {binding,stream,bindingHash,streamHash}
}
function validateKey(value:unknown,stream:RetainedAuthorityStream):asserts value is string[]{
 array(value,stream.keyColumns.length,stream.keyColumns.length)
 for(let n=0;n<value.length;n++){
  const type=stream.keyColumns[n].type
  if(type==='uuid')uuid(value[n]);else if(type==='decimal')decimal(value[n]);else textIdentity(value[n])
 }
}
function validateCursor(value:unknown,stream:RetainedAuthorityStream):asserts value is RetainedAuthorityCursor|null{
 if(value===null)return
 exact(value,['key','occurrence']);validateKey(value.key,stream);decimal(value.occurrence)
}
function validateItem(value:unknown,stream:RetainedAuthorityStream):asserts value is RetainedAuthorityIdentity{
 exact(value,['installationId','schema','table','column','key','occurrence','rowVersion','metadataFingerprint'])
 for(const field of ['installationId','schema','table','column'] as const)if(value[field]!==stream[field])fail()
 validateKey(value.key,stream);decimal(value.occurrence);decimal(value.rowVersion);digest(value.metadataFingerprint)
}
function cursor(item:RetainedAuthorityIdentity):RetainedAuthorityCursor{return {key:[...item.key],occurrence:item.occurrence}}
function member(item:RetainedAuthorityIdentity){
 return {installationId:item.installationId,schema:item.schema,table:item.table,column:item.column,key:item.key,occurrence:item.occurrence}
}
function validateRecord(value:unknown,stream:RetainedAuthorityStream):asserts value is RetainedAuthorityRecord{
 // Inspect kind without invoking a caller getter before choosing exact shape.
 if(!value||typeof value!=='object')fail()
 const kind=Object.getOwnPropertyDescriptor(value,'kind')
 if(!kind||!('value' in kind))fail()
 if(kind.value==='positive'){
  exact(value,['kind','item','policy','currentFactsHash','dependencySetHash']);validateItem(value.item,stream)
  oneOf(value.policy,policies);digest(value.currentFactsHash);digest(value.dependencySetHash)
 }else if(kind.value==='settled-negative-v4'){
  exact(value,['kind','item','original','settlement']);validateItem(value.item,stream)
  const original=value.original,settlement=value.settlement
  exact(original,['manifestHash','table','fullPrimaryKey','firstPage','firstIndex','originalFingerprint'])
  digest(original.manifestHash);digest(original.originalFingerprint);validateKey(original.fullPrimaryKey,stream)
  if(original.table!==value.item.table||!same(original.fullPrimaryKey,value.item.key))fail()
  decimal(original.firstPage);decimal(original.firstIndex);if(BigInt(original.firstIndex)>=1024n)fail()
  exact(settlement,[...settlementHashes,'completedPages','totalPages','skeletonPolicy'])
  for(const field of settlementHashes)digest(settlement[field])
  decimal(settlement.completedPages);decimal(settlement.totalPages)
  if(settlement.skeletonPolicy!=='native-personal-minimal-v4'||settlement.manifestHash!==original.manifestHash||settlement.totalPages==='0'||settlement.completedPages!==settlement.totalPages||BigInt(original.firstPage)>=BigInt(settlement.totalPages))fail()
 }else if(kind.value==='blocked'){
  exact(value,['kind','item','code','relatedIdentityHashes']);validateItem(value.item,stream);oneOf(value.code,blockers)
  array(value.relatedIdentityHashes,0,32);const seen=new Set<string>()
  for(const related of value.relatedIdentityHashes){digest(related);if(seen.has(related))fail();seen.add(related)}
 }else fail()
}
/** Numeric/UUID keys have an unambiguous native order. Different text keys
 * require the SQL adapter's reviewed native collation; never sort them in JS.
 * Same-key occurrence order is checked for every key type. */
function advances(before:RetainedAuthorityCursor|null,after:RetainedAuthorityCursor,stream:RetainedAuthorityStream):void{
 if(before===null)return
 for(let n=0;n<before.key.length;n++){
  if(before.key[n]===after.key[n])continue
  const type=stream.keyColumns[n].type
  if(type==='decimal'&&BigInt(after.key[n])<=BigInt(before.key[n])||type==='uuid'&&after.key[n]<=before.key[n])fail()
  return
 }
 if(BigInt(after.occurrence)<=BigInt(before.occurrence))fail()
}
function validateRecords(value:unknown,stream:RetainedAuthorityStream,from:RetainedAuthorityCursor|null):asserts value is RetainedAuthorityRecord[]{
 array(value,0,RETAINED_AUTHORITY_MAX_ROWS);const seen=new Set<string>();let previous=from
 for(const record of value){
  validateRecord(record,stream);const identity=canonical(member(record.item))
  if(seen.has(identity))fail();seen.add(identity)
  const next=cursor(record.item);advances(previous,next,stream);previous=next
 }
}
function pageBody(page:RetainedAuthorityPage){const {pageHash:_,...body}=page;return body}
function validatePage(value:unknown,ctx:ReturnType<typeof context>):asserts value is RetainedAuthorityPage{
 exact(value,['schemaVersion','kind','bindingHash','streamHash','ordinal','previousHash','from','to','records','recordCount','terminal','membershipHash','pageHash','globalRetainedAuthorityVerified','reopeningReady','activationAuthorized'])
 if(value.schemaVersion!==1||value.kind!==RETAINED_AUTHORITY_KIND||value.bindingHash!==ctx.bindingHash||value.streamHash!==ctx.streamHash||value.globalRetainedAuthorityVerified!==false||value.reopeningReady!==false||value.activationAuthorized!==false||typeof value.terminal!=='boolean')fail()
 decimal(value.ordinal);decimal(value.recordCount);digest(value.previousHash);digest(value.membershipHash);digest(value.pageHash)
 validateCursor(value.from,ctx.stream);validateCursor(value.to,ctx.stream);validateRecords(value.records,ctx.stream,value.from)
 if(value.recordCount!==String(value.records.length)||value.terminal!==(value.records.length===0))fail()
 const last=value.records.at(-1),to=last?cursor(last.item):value.from
 if(!same(value.to,to)||value.membershipHash!==hash(value.records.map(r=>member(r.item))))fail()
 // Full envelope byte limit includes the final digest and readiness literals.
 encoded(value)
 if(value.pageHash!==hash(pageBody(value as unknown as RetainedAuthorityPage)))fail()
}
/** Accepts untrusted DTOs. Success validates structure only, never settlement. */
export function validateRetainedAuthorityPage(value:unknown,binding:unknown,stream:unknown):asserts value is RetainedAuthorityPage{
 validatePage(value,context(binding,stream))
}
export function createRetainedAuthorityPage(binding:unknown,stream:unknown,input:unknown):RetainedAuthorityPage{
 const ctx=context(binding,stream)
 exact(input,['ordinal','previousHash','from','records','terminal'])
 decimal(input.ordinal);digest(input.previousHash);validateCursor(input.from,ctx.stream)
 if(typeof input.terminal!=='boolean')fail()
 validateRecords(input.records,ctx.stream,input.from)
 if(input.terminal!==(input.records.length===0))fail()
 const last=input.records.at(-1)
 const body={schemaVersion:1 as const,kind:RETAINED_AUTHORITY_KIND,bindingHash:ctx.bindingHash,streamHash:ctx.streamHash,ordinal:input.ordinal,previousHash:input.previousHash,from:input.from,to:last?cursor(last.item):input.from,records:input.records,recordCount:String(input.records.length),terminal:input.terminal,membershipHash:hash(input.records.map(r=>member(r.item))),globalRetainedAuthorityVerified:false as const,reopeningReady:false as const,activationAuthorized:false as const}
 const page={...body,pageHash:hash(body)}
 validatePage(page,ctx)
 return structuredClone(page)
}
export function startRetainedAuthorityStream(binding:unknown,stream:unknown):RetainedAuthorityCheckpoint{
 const ctx=context(binding,stream)
 return {bindingHash:ctx.bindingHash,streamHash:ctx.streamHash,nextOrdinal:'0',tailHash:ctx.streamHash,records:'0',cursor:null,terminal:false}
}
export function advanceRetainedAuthorityStream(binding:unknown,stream:unknown,checkpoint:unknown,page:unknown):RetainedAuthorityCheckpoint{
 const ctx=context(binding,stream)
 exact(checkpoint,['bindingHash','streamHash','nextOrdinal','tailHash','records','cursor','terminal'])
 if(checkpoint.bindingHash!==ctx.bindingHash||checkpoint.streamHash!==ctx.streamHash||checkpoint.terminal!==false)fail()
 decimal(checkpoint.nextOrdinal);decimal(checkpoint.records);digest(checkpoint.tailHash);validateCursor(checkpoint.cursor,ctx.stream)
 if(checkpoint.nextOrdinal==='0'&&(checkpoint.records!=='0'||checkpoint.tailHash!==ctx.streamHash||checkpoint.cursor!==null))fail()
 validatePage(page,ctx)
 if(page.ordinal!==checkpoint.nextOrdinal||page.previousHash!==checkpoint.tailHash||!same(page.from,checkpoint.cursor))fail()
 const nextOrdinal=(BigInt(checkpoint.nextOrdinal)+1n).toString(),records=(BigInt(checkpoint.records)+BigInt(page.recordCount)).toString()
 decimal(nextOrdinal);decimal(records)
 return {bindingHash:ctx.bindingHash,streamHash:ctx.streamHash,nextOrdinal,tailHash:page.pageHash,records,cursor:page.to===null?null:structuredClone(page.to),terminal:page.terminal}
}
