/** Standalone untrusted stream artifacts, not native-current authority proofs.
 * ReportBundle owns staging/reservation/publication. This adapter adds only the
 * bounded G1 page/index contract and strict private-file verification. */
import {createHash} from 'node:crypto'
import {constants,type BigIntStats} from 'node:fs'
import {lstat,open,opendir,realpath,type FileHandle} from 'node:fs/promises'
import {basename,dirname,join,resolve} from 'node:path'
import {ReportBundle,fingerprint,json} from '../shared-source/report.js'
import {
 RETAINED_AUTHORITY_MAX_BYTES,validateRetainedAuthorityBinding,startRetainedAuthorityStream,
 advanceRetainedAuthorityStream,type RetainedAuthorityBinding,type RetainedAuthorityStream,
 type RetainedAuthorityCheckpoint,type RetainedAuthorityPage,
} from './retained-authority-contract.js'

export const RETAINED_AUTHORITY_MANIFEST_KIND='memory-retained-current-authority-stream-manifest' as const
const HEADER_BYTES=65536,INDEX_LINE_BYTES=4096,INDEX_FILE='mapping-details.ndjson'
export interface RetainedAuthorityManifestOptions {signal?:AbortSignal}
export interface RetainedAuthorityManifestHeader {
 schemaVersion:1;kind:typeof RETAINED_AUTHORITY_MANIFEST_KIND;binding:RetainedAuthorityBinding;stream:RetainedAuthorityStream;
 bindingHash:string;streamHash:string;pageCount:string;recordCount:string;tailHash:string;
 indexHash:string;indexBytes:string;partBytes:string;artifactComplete:true;
 globalRetainedAuthorityVerified:false;reopeningReady:false;activationAuthorized:false;
}
export interface OpenRetainedAuthorityManifest {
 readonly directory:string;readonly manifestHash:string;readonly header:RetainedAuthorityManifestHeader;
}
interface Entry {ordinal:string;file:string;fileBytes:string;fileHash:string;pageHash:string;recordCount:string;terminal:boolean;previousHash:string;entryHash:string}
interface OpenState {directory:string;manifestHash:string;header:RetainedAuthorityManifestHeader;directoryId:string}
const openedStates=new WeakMap<OpenRetainedAuthorityManifest,OpenState>()
function fail(reason='invalid'):never{throw Error('retained_manifest_'+reason)}
function check(options:RetainedAuthorityManifestOptions){if(options.signal?.aborted)fail('interrupted')}
function decimal(value:unknown):asserts value is string{if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,29})$/.test(value))fail()}
function digest(value:unknown):asserts value is string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail()}
function exact(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail()
 const descriptors=Object.getOwnPropertyDescriptors(value)
 if(Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!descriptors[k]||!('value' in descriptors[k])||!descriptors[k].enumerable))fail()
}
function partName(ordinal:string){decimal(ordinal);return 'part-'+ordinal.padStart(30,'0')+'.json'}
function entryBody(entry:Entry){
 return {ordinal:entry.ordinal,file:entry.file,fileBytes:entry.fileBytes,fileHash:entry.fileHash,pageHash:entry.pageHash,recordCount:entry.recordCount,terminal:entry.terminal,previousHash:entry.previousHash}
}
function identity(stat:BigIntStats){return stat.dev+':'+stat.ino}
function stamp(stat:BigIntStats){return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':')}
function privateStat(stat:BigIntStats,directory=false){
 if(stat.isSymbolicLink()||!(directory?stat.isDirectory():stat.isFile())||(stat.mode&0o7777n)!==(directory?0o700n:0o600n)||!directory&&stat.nlink!==1n||process.getuid&&stat.uid!==BigInt(process.getuid()))fail('private_file')
}
/** Pin canonical parent once; reject a symlink at the supplied parent/target.
 * Platform aliases in earlier ancestors (e.g. macOS /var) are resolved here. */
async function location(path:string){
 const target=resolve(path),parent=await lstat(dirname(target))
 if(!parent.isDirectory()||parent.isSymbolicLink())fail('parent')
 return join(await realpath(dirname(target)),basename(target))
}
async function directory(path:string,expected?:string){
 const stat=await lstat(path,{bigint:true});privateStat(stat,true)
 if(expected!==undefined&&identity(stat)!==expected)fail('directory_changed')
 return identity(stat)
}
async function privateOpen(path:string,maxBytes?:number){
 const initial=await lstat(path,{bigint:true});privateStat(initial)
 if(maxBytes!==undefined&&initial.size>BigInt(maxBytes))fail('file_bytes')
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{const observed=await file.stat({bigint:true});privateStat(observed);if(stamp(observed)!==stamp(initial))fail('file_changed');return {file,initial,path}}
 catch(error){await file.close();throw error}
}
async function unchanged(input:{file:FileHandle;initial:BigIntStats;path:string}){
 const [current,named]=await Promise.all([input.file.stat({bigint:true}),lstat(input.path,{bigint:true})])
 privateStat(current);privateStat(named)
 if(stamp(current)!==stamp(input.initial)||stamp(named)!==stamp(input.initial))fail('file_changed')
}
async function readPrivate(path:string,maxBytes:number,options:RetainedAuthorityManifestOptions){
 check(options);const input=await privateOpen(path,maxBytes)
 try{
  // Fixed allocation and one sentinel byte detect growth without readFile's
  // potentially unbounded allocation if the file grows after initial stat.
  const size=Number(input.initial.size),buffer=Buffer.alloc(size+1);let offset=0
  while(offset<buffer.length){check(options);const {bytesRead}=await input.file.read(buffer,offset,buffer.length-offset,null);check(options);if(!bytesRead)break;offset+=bytesRead}
  if(offset!==size)fail('file_changed')
  await unchanged(input);check(options);return buffer.subarray(0,size)
 }finally{await input.file.close()}
}
function parse(bytes:Buffer):unknown{
 const text=bytes.toString('utf8');if(!Buffer.from(text,'utf8').equals(bytes))fail('encoding')
 try{return JSON.parse(text)}catch{fail('json')}
}
function header(value:unknown):asserts value is RetainedAuthorityManifestHeader{
 exact(value,['schemaVersion','kind','binding','stream','bindingHash','streamHash','pageCount','recordCount','tailHash','indexHash','indexBytes','partBytes','artifactComplete','globalRetainedAuthorityVerified','reopeningReady','activationAuthorized'])
 if(value.schemaVersion!==1||value.kind!==RETAINED_AUTHORITY_MANIFEST_KIND||value.artifactComplete!==true||value.globalRetainedAuthorityVerified!==false||value.reopeningReady!==false||value.activationAuthorized!==false)fail()
 const initial=startRetainedAuthorityStream(value.binding,value.stream)
 if(value.bindingHash!==initial.bindingHash||value.streamHash!==initial.streamHash)fail('binding')
 for(const key of ['pageCount','recordCount','indexBytes','partBytes'] as const)decimal(value[key])
 for(const key of ['tailHash','indexHash'] as const)digest(value[key])
 if(value.pageCount==='0'||value.indexBytes==='0'||value.partBytes==='0')fail('incomplete')
}
async function roster(state:OpenState,options:RetainedAuthorityManifestOptions){
 check(options);await directory(state.directory,state.directoryId);let count=0n
 const entries=await opendir(state.directory)
 for await(const entry of entries){
  check(options);count++
  if(!entry.isFile()||entry.isSymbolicLink())fail('roster')
  if(entry.name==='manifest.json'||entry.name===INDEX_FILE)continue
  if(!/^part-[0-9]{30}\.json$/.test(entry.name)||BigInt(entry.name.slice(5,-5))>=BigInt(state.header.pageCount))fail('roster')
 }
 if(count!==BigInt(state.header.pageCount)+2n)fail('roster')
 await directory(state.directory,state.directoryId);check(options)
}
function validateEntry(value:unknown):asserts value is Entry{
 exact(value,['ordinal','file','fileBytes','fileHash','pageHash','recordCount','terminal','previousHash','entryHash'])
 decimal(value.ordinal);decimal(value.fileBytes);decimal(value.recordCount)
 for(const key of ['fileHash','pageHash','previousHash','entryHash'] as const)digest(value[key])
 if(value.file!==partName(value.ordinal)||BigInt(value.fileBytes)<1n||BigInt(value.fileBytes)>BigInt(RETAINED_AUTHORITY_MAX_BYTES)||BigInt(value.recordCount)>1024n||typeof value.terminal!=='boolean')fail('entry')
 if(value.entryHash!==fingerprint(JSON.stringify(entryBody(value as unknown as Entry))))fail('entry_hash')
}
async function* entries(state:OpenState,options:RetainedAuthorityManifestOptions):AsyncGenerator<Entry>{
 const input=await privateOpen(join(state.directory,INDEX_FILE)),hasher=createHash('sha256'),chunk=Buffer.alloc(4096)
 let pending=Buffer.alloc(0),bytes=0n,ordinal=0n,tail=state.header.streamHash
 try{
  if(input.initial.size.toString()!==state.header.indexBytes)fail('index_bytes')
  for(;;){
   check(options);const {bytesRead}=await input.file.read(chunk,0,chunk.length,null);check(options);if(!bytesRead)break
   bytes+=BigInt(bytesRead);if(bytes>input.initial.size)fail('index_changed')
   const data=chunk.subarray(0,bytesRead);hasher.update(data);pending=Buffer.concat([pending,data])
   for(;;){
    const end=pending.indexOf(10);if(end<0)break
    if(end<1||end+1>INDEX_LINE_BYTES)fail('index_line')
    const value=parse(pending.subarray(0,end));pending=pending.subarray(end+1);validateEntry(value)
    if(value.ordinal!==ordinal.toString()||value.previousHash!==tail||ordinal>=BigInt(state.header.pageCount))fail('index_prefix')
    ordinal++;tail=value.entryHash;yield value
   }
   if(pending.length>INDEX_LINE_BYTES)fail('index_line')
  }
  if(pending.length||bytes!==input.initial.size||ordinal.toString()!==state.header.pageCount||hasher.digest('hex')!==state.header.indexHash)fail('index_incomplete')
  await unchanged(input);check(options)
 }finally{await input.file.close()}
}
async function* pages(state:OpenState,options:RetainedAuthorityManifestOptions):AsyncGenerator<RetainedAuthorityPage>{
 check(options);await roster(state,options)
 const manifest=await readPrivate(join(state.directory,'manifest.json'),HEADER_BYTES,options)
 if(fingerprint(manifest.toString('utf8'))!==state.manifestHash)fail('header_changed')
 let current=startRetainedAuthorityStream(state.header.binding,state.header.stream),partBytes=0n
 for await(const entry of entries(state,options)){
  await directory(state.directory,state.directoryId)
  const bytes=await readPrivate(join(state.directory,entry.file),RETAINED_AUTHORITY_MAX_BYTES,options)
  if(bytes.length.toString()!==entry.fileBytes||createHash('sha256').update(bytes).digest('hex')!==entry.fileHash)fail('part_changed')
  const page=parse(bytes)
  current=advanceRetainedAuthorityStream(state.header.binding,state.header.stream,current,page)
  const validated=page as RetainedAuthorityPage
  if(validated.pageHash!==entry.pageHash||validated.recordCount!==entry.recordCount||validated.terminal!==entry.terminal)fail('part_entry')
  partBytes+=BigInt(bytes.length);check(options);yield validated
 }
 if(!current.terminal||current.nextOrdinal!==state.header.pageCount||current.records!==state.header.recordCount||current.tailHash!==state.header.tailHash||partBytes.toString()!==state.header.partBytes)fail('stream_incomplete')
 await roster(state,options)
 if(fingerprint((await readPrivate(join(state.directory,'manifest.json'),HEADER_BYTES,options)).toString('utf8'))!==state.manifestHash)fail('header_changed')
}
/** Mandatory external byte digest pins the immutable header/index roster. Open
 * fully checks the stream without retaining its pages. Every subsequent read
 * rechecks it; abandoning an iterator early is not a fresh completeness proof. */
export async function openRetainedAuthorityManifest(path:string,expectedManifestHash:string,options:RetainedAuthorityManifestOptions={}):Promise<OpenRetainedAuthorityManifest>{
 check(options);digest(expectedManifestHash)
 const target=await location(path),directoryId=await directory(target),bytes=await readPrivate(join(target,'manifest.json'),HEADER_BYTES,options)
 if(createHash('sha256').update(bytes).digest('hex')!==expectedManifestHash)fail('manifest_hash')
 const value=parse(bytes);header(value)
 const state:OpenState={directory:target,manifestHash:expectedManifestHash,header:value,directoryId}
 for await(const _ of pages(state,options)){/* bounded validation, no inventory collection */}
 const opened={directory:target,manifestHash:expectedManifestHash,header:structuredClone(value)}
 openedStates.set(opened,state);return opened
}
export async function* readRetainedAuthorityPages(opened:OpenRetainedAuthorityManifest,options:RetainedAuthorityManifestOptions={}):AsyncGenerator<RetainedAuthorityPage>{
 const state=openedStates.get(opened);if(!state)fail('unopened')
 yield* pages(state,options)
}
async function syncDirectory(path:string){const file=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await file.sync()}finally{await file.close()}}

export class RetainedAuthorityManifestWriter {
 private current:RetainedAuthorityCheckpoint
 private index=createHash('sha256');private indexBytes=0n;private partBytes=0n;private indexTail:string
 private closed=false;private cancelled=false;private running:Promise<unknown>|undefined
 private constructor(private bundle:ReportBundle,private binding:RetainedAuthorityBinding,private stream:RetainedAuthorityStream,private options:RetainedAuthorityManifestOptions){
  this.current=startRetainedAuthorityStream(binding,stream);this.indexTail=this.current.streamHash
 }
 static async create(path:string,binding:unknown,stream:unknown,options:RetainedAuthorityManifestOptions={}):Promise<RetainedAuthorityManifestWriter>{
  check(options);validateRetainedAuthorityBinding(binding);startRetainedAuthorityStream(binding,stream)
  const copiedBinding=structuredClone(binding),copiedStream=structuredClone(stream) as RetainedAuthorityStream,target=await location(path);check(options)
  const bundle=await ReportBundle.create(target)
  try{check(options);return new RetainedAuthorityManifestWriter(bundle,copiedBinding,copiedStream,options)}catch(error){await bundle.abort();throw error}
 }
 private check(){check(this.options);if(this.cancelled)fail('interrupted')}
 private async cleanup(){if(!this.closed){this.closed=true;await this.bundle.abort()}}
 private operation<T>(body:()=>Promise<T>):Promise<T>{
  if(this.closed||this.running)return Promise.reject(Error('retained_manifest_closed_or_busy'))
  const running=(async()=>{try{this.check();return await body()}catch(error){await this.cleanup();throw error}finally{this.running=undefined}})()
  this.running=running;return running
 }
 append(value:unknown):Promise<void>{return this.operation(async()=>{
  const next=advanceRetainedAuthorityStream(this.binding,this.stream,this.current,value),page=structuredClone(value) as RetainedAuthorityPage
  const content=json(page),fileBytes=Buffer.byteLength(content)
  if(fileBytes>RETAINED_AUTHORITY_MAX_BYTES)fail('part_bytes')
  const body={ordinal:page.ordinal,file:partName(page.ordinal),fileBytes:String(fileBytes),fileHash:fingerprint(content),pageHash:page.pageHash,recordCount:page.recordCount,terminal:page.terminal,previousHash:this.indexTail}
  const entry={...body,entryHash:fingerprint(JSON.stringify(body))},line=JSON.stringify(entry)+'\n'
  if(Buffer.byteLength(line)>INDEX_LINE_BYTES)fail('index_line')
  await this.bundle.write(body.file,page);this.check();await this.bundle.detail(entry);this.check()
  this.index.update(line);this.indexBytes+=BigInt(Buffer.byteLength(line));this.partBytes+=BigInt(fileBytes);this.indexTail=entry.entryHash;this.current=next
 })}
 finish():Promise<{manifestHash:string;header:RetainedAuthorityManifestHeader}>{return this.operation(async()=>{
  if(!this.current.terminal)fail('terminal_required')
  const value:RetainedAuthorityManifestHeader={schemaVersion:1,kind:RETAINED_AUTHORITY_MANIFEST_KIND,binding:this.binding,stream:this.stream,bindingHash:this.current.bindingHash,streamHash:this.current.streamHash,pageCount:this.current.nextOrdinal,recordCount:this.current.records,tailHash:this.current.tailHash,indexHash:this.index.digest('hex'),indexBytes:this.indexBytes.toString(),partBytes:this.partBytes.toString(),artifactComplete:true,globalRetainedAuthorityVerified:false,reopeningReady:false,activationAuthorized:false}
  header(value);const content=json(value);if(Buffer.byteLength(content)>HEADER_BYTES)fail('header_bytes')
  await this.bundle.write('manifest.json',value);this.check()
  // Publication is a single noncancellable commit phase after this check.
  // Cancellation never removes/replaces an already published complete bundle.
  await this.bundle.finish();this.closed=true
  await syncDirectory(this.bundle.target);await syncDirectory(dirname(this.bundle.target))
  const manifestHash=fingerprint(content)
  await openRetainedAuthorityManifest(this.bundle.target,manifestHash)
  return {manifestHash,header:structuredClone(value)}
 })}
 async abort():Promise<void>{this.cancelled=true;await this.running?.catch(()=>undefined);await this.cleanup()}
}
