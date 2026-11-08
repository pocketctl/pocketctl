import {afterEach,describe,expect,it} from 'vitest'
import {mkdtemp,rm,lstat,readFile,writeFile,chmod,symlink,mkdir,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {RetainedAuthorityManifestWriter,openRetainedAuthorityManifest,readRetainedAuthorityPages} from '../../migrations/shared-forward/retained-authority-manifest.js'
import {createRetainedAuthorityPage,startRetainedAuthorityStream,advanceRetainedAuthorityStream} from '../../migrations/shared-forward/retained-authority-contract.js'

const id='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64)
const binding={schemaVersion:1,kind:'memory-retained-current-authority',installationIds:[id],databaseIdentityHash:hash,configHash:hash,catalogHash:hash,keyringHash:hash,sourcePolicyHash:hash,roleIdentityHash:hash,unitsHash:hash,referenceContractHash:hash}
const stream={installationId:id,family:'root',schema:'memory',table:'source_sessions',column:null,keyColumns:[{name:'session_id',type:'decimal'}]}
const temporary:string[]=[]
async function target(){const root=await mkdtemp(join(tmpdir(),'retained-manifest-'));temporary.push(root);return join(root,'artifact')}
const part=(n:number)=>'part-'+String(n).padStart(30,'0')+'.json'
function positive(n:number){return {kind:'positive',item:{installationId:id,schema:'memory',table:'source_sessions',column:null,key:[String(n)],occurrence:'0',rowVersion:'1',metadataFingerprint:hash},policy:'personal-raw-v1',currentFactsHash:hash,dependencySetHash:hash}}
async function fixture(count=2){
 const path=await target(),writer=await RetainedAuthorityManifestWriter.create(path,binding,stream)
 let state=startRetainedAuthorityStream(binding,stream)
 for(let n=0;n<count;n+=1024){
  const page=createRetainedAuthorityPage(binding,stream,{ordinal:state.nextOrdinal,previousHash:state.tailHash,from:state.cursor,records:Array.from({length:Math.min(1024,count-n)},(_,i)=>positive(n+i+1)),terminal:false})
  await writer.append(page);state=advanceRetainedAuthorityStream(binding,stream,state,page)
 }
 await writer.append(createRetainedAuthorityPage(binding,stream,{ordinal:state.nextOrdinal,previousHash:state.tailHash,from:state.cursor,records:[],terminal:true}))
 const result=await writer.finish();return {path,...result}
}
async function consume(opened:Awaited<ReturnType<typeof openRetainedAuthorityManifest>>){let pages=0,rows=0;for await(const page of readRetainedAuthorityPages(opened)){pages++;rows+=page.records.length}return {pages,rows}}
afterEach(async()=>{await Promise.all(temporary.splice(0).map(path=>rm(path,{recursive:true,force:true})))})

describe('retained authority private stream artifact',()=>{
 it('refuses atomic publication without the explicit terminal page and removes its partial artifact',async()=>{
  const path=await target(),writer=await RetainedAuthorityManifestWriter.create(path,binding,stream)
  await expect(writer.finish()).rejects.toThrow('retained_manifest')
  await expect(lstat(path)).rejects.toMatchObject({code:'ENOENT'})
  await expect(lstat(path+'.lock')).rejects.toMatchObject({code:'ENOENT'})
 })
 it('publishes private bounded pages and round-trips more than 4096 members with a final empty tail',async()=>{
  const artifact=await fixture(4097),opened=await openRetainedAuthorityManifest(artifact.path,artifact.manifestHash)
  expect(await consume(opened)).toEqual({pages:6,rows:4097})
  expect(opened.header.recordCount).toBe('4097');expect(opened.header.pageCount).toBe('6')
  expect(opened.header.globalRetainedAuthorityVerified).toBe(false);expect(opened.header.reopeningReady).toBe(false);expect(opened.header.activationAuthorized).toBe(false)
  expect((await lstat(artifact.path)).mode&0o777).toBe(0o700)
  for(const name of await readdir(artifact.path))expect((await lstat(join(artifact.path,name))).mode&0o777).toBe(0o600)
 })
 it('authenticates a genuinely empty stream rather than omitting the terminal page',async()=>{
  const artifact=await fixture(0),opened=await openRetainedAuthorityManifest(artifact.path,artifact.manifestHash)
  expect(await consume(opened)).toEqual({pages:1,rows:0})
 })
 it.each(['malformed','missing','unexpected','truncated-index','reordered-index','changed-part'] as const)('refuses actual %s filesystem corruption',async(kind)=>{
  const artifact=await fixture()
  if(kind==='malformed')await writeFile(join(artifact.path,part(0)),'{')
  if(kind==='missing')await rm(join(artifact.path,part(0)))
  if(kind==='unexpected')await writeFile(join(artifact.path,'unexpected.json'),'{}',{mode:0o600})
  if(kind==='truncated-index'){const path=join(artifact.path,'mapping-details.ndjson'),data=await readFile(path);await writeFile(path,data.subarray(0,data.length-1))}
  if(kind==='reordered-index'){const path=join(artifact.path,'mapping-details.ndjson'),lines=(await readFile(path,'utf8')).trimEnd().split('\n');await writeFile(path,lines.reverse().join('\n')+'\n')}
  if(kind==='changed-part'){const path=join(artifact.path,part(0)),data=await readFile(path,'utf8');await writeFile(path,data.replace('personal-raw-v1','personal-raw-v2'))}
  await expect(openRetainedAuthorityManifest(artifact.path,artifact.manifestHash)).rejects.toThrow()
 })
 it('rejects part changes after open and ignores caller mutation of the exposed header',async()=>{
  const artifact=await fixture(),opened=await openRetainedAuthorityManifest(artifact.path,artifact.manifestHash)
  ;(opened.header as {recordCount:string}).recordCount='0'
  expect(await consume(opened)).toEqual({pages:2,rows:2})
  await writeFile(join(artifact.path,part(0)),'{}')
  await expect(consume(opened)).rejects.toThrow()
 })
 it('requires the caller-pinned manifest digest and rejects unknown header/readiness fields even with a matching file digest',async()=>{
  const artifact=await fixture()
  await expect(openRetainedAuthorityManifest(artifact.path,'b'.repeat(64))).rejects.toThrow()
  const path=join(artifact.path,'manifest.json'),header=JSON.parse(await readFile(path,'utf8'))
  for(const change of [{globalRetainedAuthorityVerified:true},{reopeningReady:true},{kind:'memory-forward-privacy-cleanup'},{body:'secret'}]){
   const bytes=JSON.stringify({...header,...change})+'\n';await writeFile(path,bytes)
   await expect(openRetainedAuthorityManifest(artifact.path,createHash('sha256').update(bytes).digest('hex'))).rejects.toThrow()
  }
 })
 it.each(['file-permission','directory-permission','file-special-permission','part-symlink','directory-symlink'] as const)('refuses %s on actual private artifacts',async(kind)=>{
  const artifact=await fixture();let path=artifact.path
  if(kind==='file-permission')await chmod(join(path,part(0)),0o644)
  if(kind==='directory-permission')await chmod(path,0o755)
  if(kind==='file-special-permission')await chmod(join(path,part(0)),0o4600)
  if(kind==='part-symlink'){const original=join(path,part(0)),copy=path+'-copy';await writeFile(copy,await readFile(original),{mode:0o600});await rm(original);await symlink(copy,original)}
  if(kind==='directory-symlink'){path=artifact.path+'-link';await symlink(artifact.path,path)}
  await expect(openRetainedAuthorityManifest(path,artifact.manifestHash)).rejects.toThrow()
 })
 it('refuses a symlink parent and never overwrites an existing or concurrently reserved target',async()=>{
  const path=await target(),parent=path+'-parent';await symlink(path.slice(0,path.lastIndexOf('/')),parent)
  await expect(RetainedAuthorityManifestWriter.create(join(parent,'nested'),binding,stream)).rejects.toThrow()
  await mkdir(path,{mode:0o700});await writeFile(join(path,'sentinel'),'original')
  await expect(RetainedAuthorityManifestWriter.create(path,binding,stream)).rejects.toThrow()
  expect(await readFile(join(path,'sentinel'),'utf8')).toBe('original')
  const other=await target(),writer=await RetainedAuthorityManifestWriter.create(other,binding,stream)
  await expect(RetainedAuthorityManifestWriter.create(other,binding,stream)).rejects.toThrow()
  expect((await lstat(other+'.lock')).isFile()).toBe(true)
  await writer.abort();await expect(lstat(other+'.lock')).rejects.toMatchObject({code:'ENOENT'})
 })
 it('cancels in-flight append without publishing or leaking staging/lock files',async()=>{
  const path=await target(),controller=new AbortController(),writer=await RetainedAuthorityManifestWriter.create(path,binding,stream,{signal:controller.signal})
  const state=startRetainedAuthorityStream(binding,stream),page=createRetainedAuthorityPage(binding,stream,{ordinal:'0',previousHash:state.tailHash,from:null,records:[positive(1)],terminal:false})
  const pending=writer.append(page);controller.abort()
  await expect(pending).rejects.toThrow('retained_manifest_interrupted')
  expect(await readdir(path.slice(0,path.lastIndexOf('/')))).toEqual([])
 })
 it('refuses aborted creation/finish and interrupts a streaming reader before its next page',async()=>{
  const path=await target(),controller=new AbortController();controller.abort()
  await expect(RetainedAuthorityManifestWriter.create(path,binding,stream,{signal:controller.signal})).rejects.toThrow('retained_manifest_interrupted')
  const finishController=new AbortController(),writer=await RetainedAuthorityManifestWriter.create(path,binding,stream,{signal:finishController.signal})
  const state=startRetainedAuthorityStream(binding,stream)
  await writer.append(createRetainedAuthorityPage(binding,stream,{ordinal:'0',previousHash:state.tailHash,from:null,records:[],terminal:true}))
  finishController.abort();await expect(writer.finish()).rejects.toThrow('retained_manifest_interrupted')
  await expect(lstat(path)).rejects.toMatchObject({code:'ENOENT'})
  const artifact=await fixture(),opened=await openRetainedAuthorityManifest(artifact.path,artifact.manifestHash),readController=new AbortController()
  const reader=readRetainedAuthorityPages(opened,{signal:readController.signal})
  expect((await reader.next()).done).toBe(false);readController.abort()
  await expect(reader.next()).rejects.toThrow('retained_manifest_interrupted')
 })
 it('rejects out-of-order pages and extra caller fields before they can enter report files',async()=>{
  for(const extra of [{ordinal:'1'},{body:'secret'}]){
   const path=await target(),writer=await RetainedAuthorityManifestWriter.create(path,binding,stream),state=startRetainedAuthorityStream(binding,stream)
   const page=createRetainedAuthorityPage(binding,stream,{ordinal:'0',previousHash:state.tailHash,from:null,records:[positive(1)],terminal:false})
   await expect(writer.append({...page,...extra})).rejects.toThrow()
   await expect(lstat(path)).rejects.toMatchObject({code:'ENOENT'})
   await expect(lstat(path+'.lock')).rejects.toMatchObject({code:'ENOENT'})
  }
 })
 it('counts the newline in the bounded index line even when supplied digests are internally consistent',async()=>{
  const artifact=await fixture(0),indexPath=join(artifact.path,'mapping-details.ndjson'),manifestPath=join(artifact.path,'manifest.json')
  const line=(await readFile(indexPath,'utf8')).trimEnd().padEnd(4096,' ')+'\n'
  await writeFile(indexPath,line)
  const header=JSON.parse(await readFile(manifestPath,'utf8'));header.indexBytes=String(Buffer.byteLength(line));header.indexHash=createHash('sha256').update(line).digest('hex')
  const manifest=JSON.stringify(header)+'\n';await writeFile(manifestPath,manifest)
  await expect(openRetainedAuthorityManifest(artifact.path,createHash('sha256').update(manifest).digest('hex'))).rejects.toThrow('retained_manifest_index_line')
 })
})
