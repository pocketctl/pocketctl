/** V4 maintenance manifests contain identities and digests only. Business SQL
 * never runs while these file APIs are active. The index is streamed; neither
 * reader nor writer retains the complete selected row/page set in memory. */
import {createHash,randomUUID} from 'node:crypto'
import {constants} from 'node:fs'
import {mkdir,open,lstat,rename,rm,rmdir,opendir} from 'node:fs/promises'
import type {FileHandle} from 'node:fs/promises'
import {join,resolve,dirname,basename} from 'node:path'

export const PAGED_CLEANUP_MAX_ROWS=1024
export const PAGED_CLEANUP_MAX_BYTES=8*1024*1024
const digest=/^[a-f0-9]{64}$/,decimal=/^(0|[1-9][0-9]*)$/,identifier=/^[a-z][a-z0-9_]{0,62}$/
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const phases=['authority','feedback','derived','operational','raw','final'] as const
export type PagedCleanupPhase=typeof phases[number]
export interface PagedCleanupRecord {
 table:string;key:Record<string,string|null>;references:Record<string,string|null>
 fingerprint:string;bytes:string;disposition:'preserve'|'delete'|'invalidate'|'minimize'|'output'
 retainReason?:'independent_accepted'|'incurred_effect'|'provider_result_unknown'|'native_authority'|'replacement_support'|'referenced_source_loss'
}
export interface PagedCleanupPart {ordinal:string;phase:PagedCleanupPhase;root:{installationId:string;sessionId:string};componentHash:string;records:PagedCleanupRecord[]}
export interface PagedCleanupBinding {identity:string;configHash:string;catalogHash:string;authorityHash:string;referenceContractHash:string;rootsHash:string}
export interface PagedCleanupHeader extends PagedCleanupBinding {schemaVersion:4;kind:'memory-forward-privacy-cleanup';partCount:string;rowCount:string;workBytes:string;chainHash:string;manifestHash:string}
interface IndexEntry {ordinal:string;file:string;hash:string;rows:string;workBytes:string;fileBytes:string;previousHash:string;entryHash:string}
export interface OpenPagedCleanupManifest {readonly directory:string;readonly header:PagedCleanupHeader}
export interface PagedReceipt {ordinal:string;manifestHash:string;pageHash:string;previousHash:string;beforeHash:string;afterHash:string;receiptHash:string}
function plain(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)}
function exact(value:unknown,required:readonly string[],optional:readonly string[]=[]):asserts value is Record<string,unknown>{if(!plain(value)||required.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))throw Error('paged_manifest_shape')}
function canonical(value:unknown):string{
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value)
 if(typeof value==='number'&&Number.isSafeInteger(value))return String(value)
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(plain(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}'
 throw Error('paged_manifest_noncanonical_value')
}
export const pagedHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex')
function requireDecimal(value:unknown):asserts value is string{if(typeof value!=='string'||value.length>30||!decimal.test(value))throw Error('paged_manifest_decimal')}
function requireHash(value:unknown):asserts value is string{if(typeof value!=='string'||!digest.test(value))throw Error('paged_manifest_hash')}
const bindingKeys=['identity','configHash','catalogHash','authorityHash','referenceContractHash','rootsHash'] as const
function checkBinding(value:unknown):asserts value is PagedCleanupBinding{exact(value,bindingKeys);for(const key of bindingKeys)requireHash(value[key])}
function refMap(value:unknown,required:boolean){
 if(!plain(value)||Object.keys(value).length>32||required&&!Object.keys(value).length)throw Error('paged_manifest_identity')
 for(const [key,v] of Object.entries(value)){
  // Only typed identity columns may cross the report boundary; row prose,
  // request/response JSON, locators and arbitrary metadata are not accepted.
  if(!identifier.test(key)||!(/(^id$|_id$|_key$|_hash$|_hmac$)/.test(key)||['generation','sequence','revision','ordinal','version','key_id','row_version','job_type'].includes(key))||/^(body|payload|statement|document|summary|content|request|response|normalized_key)$/.test(key))throw Error('paged_manifest_identity_column')
  if(v!==null&&(typeof v!=='string'||v.length>1024||/[\u0000-\u001f]/.test(v)))throw Error('paged_manifest_identity')
 }
}
export function validatePagedCleanupPart(value:unknown):asserts value is PagedCleanupPart{
 exact(value,['ordinal','phase','root','componentHash','records']);requireDecimal(value.ordinal);requireHash(value.componentHash)
 if(!phases.includes(value.phase as PagedCleanupPhase))throw Error('paged_manifest_phase')
 exact(value.root,['installationId','sessionId'])
 if(typeof value.root.installationId!=='string'||!uuid.test(value.root.installationId)||typeof value.root.sessionId!=='string'||!value.root.sessionId||value.root.sessionId.length>512||/[\u0000-\u001f]/.test(value.root.sessionId))throw Error('paged_manifest_root')
 if(!Array.isArray(value.records)||!value.records.length||value.records.length>PAGED_CLEANUP_MAX_ROWS)throw Error('paged_manifest_row_bound')
 let bytes=0n;const seen=new Set<string>()
 for(const record of value.records){
  exact(record,['table','key','references','fingerprint','bytes','disposition'],['retainReason'])
  if(typeof record.table!=='string'||!identifier.test(record.table))throw Error('paged_manifest_table')
  refMap(record.key,true);refMap(record.references,false);requireHash(record.fingerprint);requireDecimal(record.bytes);bytes+=BigInt(record.bytes)
  if(!['preserve','delete','invalidate','minimize','output'].includes(String(record.disposition)))throw Error('paged_manifest_disposition')
  if(record.retainReason!==undefined&&!['independent_accepted','incurred_effect','provider_result_unknown','native_authority','replacement_support','referenced_source_loss'].includes(String(record.retainReason)))throw Error('paged_manifest_retention_reason')
  const key=pagedHash([record.table,record.key]);if(seen.has(key))throw Error('paged_manifest_duplicate_key');seen.add(key)
 }
 if(bytes>BigInt(PAGED_CLEANUP_MAX_BYTES)||Buffer.byteLength(canonical(value))>PAGED_CLEANUP_MAX_BYTES)throw Error('paged_manifest_byte_bound')
}
function partName(ordinal:string){return 'part-'+ordinal.padStart(20,'0')+'.json'}
async function privateFile(path:string,maxBytes?:number){
 let handle:FileHandle
 try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)}catch(error){if((error as NodeJS.ErrnoException).code==='ELOOP')throw Error('private_paged_manifest_required');throw error}
 try{const s=await handle.stat();if(!s.isFile()||(s.mode&0o077)!==0||maxBytes!==undefined&&s.size>maxBytes)throw Error('private_paged_manifest_required');return handle}catch(error){await handle.close();throw error}
}
async function readPrivate(path:string,maxBytes:number){
 const f=await privateFile(path,maxBytes)
 try{
  // fstat alone is not a memory bound: a file can grow after that check.
  const data=Buffer.alloc(maxBytes+1);let length=0
  while(length<data.length){const r=await f.read(data,length,data.length-length,null);if(!r.bytesRead)break;length+=r.bytesRead}
  if(length>maxBytes)throw Error('paged_manifest_byte_bound')
  return data.subarray(0,length)
 }finally{await f.close()}
}
async function* lines(path:string):AsyncGenerator<string>{
 const f=await privateFile(path);const buffer=Buffer.alloc(65536);let remainder=Buffer.alloc(0)
 try{for(;;){const {bytesRead}=await f.read(buffer,0,buffer.length,null);if(!bytesRead)break;let data=Buffer.concat([remainder,buffer.subarray(0,bytesRead)]),start=0,index:number
  while((index=data.indexOf(10,start))!==-1){if(index-start>4096)throw Error('paged_manifest_index_line_bound');yield data.subarray(start,index).toString('utf8');start=index+1}
  remainder=data.subarray(start);if(remainder.length>4096)throw Error('paged_manifest_index_line_bound')
 }if(remainder.length)throw Error('paged_manifest_index_incomplete_line')}finally{await f.close()}
}
function entry(value:unknown,ordinal:bigint,previousHash:string):IndexEntry{
 try{exact(value,['ordinal','file','hash','rows','workBytes','fileBytes','previousHash','entryHash']);for(const key of ['ordinal','rows','workBytes','fileBytes'])requireDecimal(value[key]);for(const key of ['hash','previousHash','entryHash'])requireHash(value[key]);
  const {entryHash,...body}=value
  if(value.ordinal!==ordinal.toString()||value.file!==partName(value.ordinal as string)||value.previousHash!==previousHash||pagedHash(body)!==entryHash||BigInt(value.rows as string)<1n||BigInt(value.rows as string)>1024n||BigInt(value.workBytes as string)>BigInt(PAGED_CLEANUP_MAX_BYTES)||BigInt(value.fileBytes as string)>BigInt(PAGED_CLEANUP_MAX_BYTES))throw Error()
  return value as unknown as IndexEntry
 }catch{throw Error('paged_manifest_index_invalid')}
}
function checkHeader(value:unknown):asserts value is PagedCleanupHeader{
 if(!plain(value)||value.schemaVersion!==4||value.kind!=='memory-forward-privacy-cleanup')throw Error('paged_manifest_version')
 exact(value,[...bindingKeys,'schemaVersion','kind','partCount','rowCount','workBytes','chainHash','manifestHash']);for(const k of [...bindingKeys,'chainHash','manifestHash'])requireHash(value[k]);for(const k of ['partCount','rowCount','workBytes'])requireDecimal(value[k])
 const {manifestHash,...body}=value;if(pagedHash(body)!==manifestHash)throw Error('paged_manifest_header_changed')
}
async function* entries(opened:OpenPagedCleanupManifest){
 let n=0n,rows=0n,bytes=0n,previous=pagedHash(Object.fromEntries(bindingKeys.map(k=>[k,opened.header[k]])))
 for await(const line of lines(join(opened.directory,'parts.ndjson'))){let parsed:unknown;try{parsed=JSON.parse(line)}catch{throw Error('paged_manifest_index_invalid')}
  const e=entry(parsed,n,previous);n++;rows+=BigInt(e.rows);bytes+=BigInt(e.workBytes);previous=e.entryHash;yield e
 }
 if(n.toString()!==opened.header.partCount||rows.toString()!==opened.header.rowCount||bytes.toString()!==opened.header.workBytes||previous!==opened.header.chainHash)throw Error('paged_manifest_index_incomplete')
}
export async function openPagedCleanupManifest(directory:string):Promise<OpenPagedCleanupManifest>{
 directory=resolve(directory);const s=await lstat(directory);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0)throw Error('private_paged_manifest_required')
 const header:unknown=JSON.parse((await readPrivate(join(directory,'manifest.json'),16384)).toString('utf8'));checkHeader(header)
 const opened={directory,header};for await(const _ of entries(opened)){/* authenticate whole roster before consumers can mutate */}
 // Streaming directory inventory, rather than allocating one filename array.
 let count=0n;const dir=await opendir(directory)
 for await(const file of dir){if(!file.isFile())throw Error('private_paged_manifest_required');if(file.name==='manifest.json'||file.name==='parts.ndjson')continue
  const m=/^part-([0-9]{20,30})\.json$/.exec(file.name);if(!m||BigInt(m[1])>=BigInt(header.partCount)||file.name!==partName(BigInt(m[1]).toString()))throw Error('paged_manifest_unexpected_file');count++
 }
 if(count!==BigInt(header.partCount))throw Error('paged_manifest_part_missing')
 return opened
}
export async function* readPagedCleanupParts(opened:OpenPagedCleanupManifest):AsyncGenerator<PagedCleanupPart>{
 checkHeader(opened.header)
 for await(const e of entries(opened)){
  const bytes=await readPrivate(join(opened.directory,e.file),PAGED_CLEANUP_MAX_BYTES);let value:unknown
  try{value=JSON.parse(bytes.toString('utf8'));validatePagedCleanupPart(value)}catch{throw Error('paged_manifest_part_invalid')}
  if(bytes.length.toString()!==e.fileBytes||pagedHash(value)!==e.hash||value.ordinal!==e.ordinal||value.records.length.toString()!==e.rows||value.records.reduce((n,r)=>n+BigInt(r.bytes),0n).toString()!==e.workBytes)throw Error('paged_manifest_part_changed')
  yield value
 }
}
export class PagedCleanupManifestWriter {
 private ordinal=0n;private rows=0n;private bytes=0n;private previous:string;private closed=false
 private constructor(readonly target:string,private staging:string,private lock:FileHandle,private index:FileHandle,private binding:PagedCleanupBinding,private signal?:AbortSignal){this.previous=pagedHash(binding)}
 private check(){if(this.signal?.aborted)throw Error('maintenance_interrupted')}
 static async create(directory:string,binding:PagedCleanupBinding,options:{signal?:AbortSignal}={}){
  if(options.signal?.aborted)throw Error('maintenance_interrupted')
  checkBinding(binding);const target=resolve(directory),parent=await lstat(dirname(target));if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('private_paged_manifest_parent')
  const lock=await open(target+'.lock','wx',0o600),staging=join(dirname(target),'.'+basename(target)+'.partial-'+randomUUID())
  try{if(await lstat(target).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e}))throw Error('paged_manifest_exists');await mkdir(staging,{mode:0o700});const index=await open(join(staging,'parts.ndjson'),'wx',0o600);return new PagedCleanupManifestWriter(target,staging,lock,index,structuredClone(binding),options.signal)}
  catch(error){await rm(staging,{recursive:true,force:true});await lock.close();await rm(target+'.lock',{force:true});throw error}
 }
 async append(part:PagedCleanupPart){
  this.check();if(this.closed)throw Error('paged_manifest_closed');validatePagedCleanupPart(part);if(part.ordinal!==this.ordinal.toString())throw Error('paged_manifest_ordinal')
  const data=canonical(part)+'\n';if(Buffer.byteLength(data)>PAGED_CLEANUP_MAX_BYTES)throw Error('paged_manifest_byte_bound')
  const filename=partName(part.ordinal),file=await open(join(this.staging,filename),'wx',0o600)
  try{await file.writeFile(data);await file.sync()}finally{await file.close()}
  const work=part.records.reduce((n,r)=>n+BigInt(r.bytes),0n),body={ordinal:part.ordinal,file:filename,hash:pagedHash(part),rows:String(part.records.length),workBytes:work.toString(),fileBytes:String(Buffer.byteLength(data)),previousHash:this.previous},e={...body,entryHash:pagedHash(body)}
  await this.index.writeFile(canonical(e)+'\n');this.previous=e.entryHash;this.ordinal++;this.rows+=BigInt(e.rows);this.bytes+=work
 }
 async finish():Promise<PagedCleanupHeader>{
  this.check();if(this.closed)throw Error('paged_manifest_closed')
  const body={...this.binding,schemaVersion:4 as const,kind:'memory-forward-privacy-cleanup' as const,partCount:this.ordinal.toString(),rowCount:this.rows.toString(),workBytes:this.bytes.toString(),chainHash:this.previous},header={...body,manifestHash:pagedHash(body)}
  await this.index.sync();await this.index.close();const file=await open(join(this.staging,'manifest.json'),'wx',0o600);try{await file.writeFile(canonical(header)+'\n');await file.sync()}finally{await file.close()}
  const staged=await open(this.staging,'r');try{await staged.sync()}finally{await staged.close()}
  this.check();await mkdir(this.target,{mode:0o700});const reservation=await lstat(this.target)
  try{this.check();await rename(this.staging,this.target)}catch(error){const current=await lstat(this.target).catch(()=>undefined);if(current?.ino===reservation.ino&&current.dev===reservation.dev)await rmdir(this.target).catch(()=>{});throw error}
  this.closed=true;await this.lock.close();await rm(this.target+'.lock',{force:true});const parent=await open(dirname(this.target),'r');try{await parent.sync()}finally{await parent.close()};return header
 }
 async abort(){if(this.closed)return;this.closed=true;await this.index.close().catch(()=>{});await rm(this.staging,{recursive:true,force:true});await this.lock.close();await rm(this.target+'.lock',{force:true})}
}
/** Bounded page-prefix primitive; database callers stream one batch and carry
 * ordinal/tail state instead of reading every receipt into one array. */
export function verifyPagedReceiptPrefix(manifestHash:string,pages:readonly PagedCleanupPart[],receipts:readonly PagedReceipt[],start={completed:'0',tailHash:manifestHash}){
 requireHash(manifestHash);requireDecimal(start.completed);requireHash(start.tailHash);if(receipts.length>pages.length||pages.length>1024)throw Error('paged_receipt_prefix')
 let ordinal=BigInt(start.completed),tail=start.tailHash
 for(let i=0;i<receipts.length;i++){
  const r=receipts[i],{receiptHash,...body}=r
  if(r.ordinal!==ordinal.toString()||pages[i].ordinal!==r.ordinal||r.manifestHash!==manifestHash||r.pageHash!==pagedHash(pages[i])||r.previousHash!==tail||!digest.test(r.beforeHash)||!digest.test(r.afterHash)||pagedHash(body)!==receiptHash)throw Error('paged_receipt_prefix')
  ordinal++;tail=receiptHash
 }
 return {completed:ordinal.toString(),tailHash:tail}
}

/** Discovery supplies complete, independently mutable native components. This
 * packer never splits one and never accumulates more than one admitted page.
 * Immutable shared guards may repeat; shared mutable rows mean discovery did
 * not close the component and are refused rather than arbitrarily ordered. */
export async function* packPagedCleanupComponents(components:AsyncIterable<Omit<PagedCleanupPart,'ordinal'>>,startOrdinal='0'):AsyncGenerator<PagedCleanupPart>{
 requireDecimal(startOrdinal);let ordinal=BigInt(startOrdinal),pending:PagedCleanupPart|undefined,hashes:string[]=[],work=0n,encoded=0
 let seen=new Map<string,PagedCleanupRecord>()
 function begin(single:PagedCleanupPart){pending={...single,ordinal:ordinal.toString(),records:[...single.records]};hashes=[single.componentHash];work=single.records.reduce((n,r)=>n+BigInt(r.bytes),0n);encoded=single.records.reduce((n,r)=>n+Buffer.byteLength(canonical(r)),0);seen=new Map(single.records.map(r=>[pagedHash([r.table,r.key]),r]))}
 function complete(){const result={...pending!,componentHash:hashes.length===1?hashes[0]:pagedHash(hashes)};validatePagedCleanupPart(result);return result}
 for await(const component of components){
  const single={...component,ordinal:ordinal.toString()}
  try{validatePagedCleanupPart(single)}catch(error){if(/(row|byte)_bound/.test((error as Error).message))throw Error('paged_component_capacity');throw error}
  if(!pending){begin(single);continue}
  if(pending.phase!==single.phase||pending.root.installationId!==single.root.installationId||pending.root.sessionId!==single.root.sessionId){yield complete();ordinal++;begin(single);continue}
  const extra:{key:string;row:PagedCleanupRecord}[]=[];let additionalWork=0n,additionalEncoded=0
  for(const row of single.records){const key=pagedHash([row.table,row.key]),old=seen.get(key);if(old){if(old.disposition!=='preserve'||row.disposition!=='preserve'||pagedHash(old)!==pagedHash(row))throw Error('paged_component_shared_mutation')}else{extra.push({key,row});additionalWork+=BigInt(row.bytes);additionalEncoded+=Buffer.byteLength(canonical(row))}}
  const count=pending.records.length+extra.length,frame=Buffer.byteLength(canonical({...pending,records:[]})),size=frame+encoded+additionalEncoded+Math.max(0,count-1)
  if(hashes.length>=PAGED_CLEANUP_MAX_ROWS||count>PAGED_CLEANUP_MAX_ROWS||work+additionalWork>BigInt(PAGED_CLEANUP_MAX_BYTES)||size>PAGED_CLEANUP_MAX_BYTES){yield complete();ordinal++;begin(single);continue}
  for(const {key,row} of extra){pending.records.push(row);seen.set(key,row)}hashes.push(component.componentHash);work+=additionalWork;encoded+=additionalEncoded
 }
 if(pending)yield complete()
}
