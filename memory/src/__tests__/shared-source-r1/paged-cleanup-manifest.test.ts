import {maintenanceHelp} from '../../migrations/shared-forward/source-maintenance-cli.js'
import {afterEach,describe,expect,test} from 'vitest'
import {mkdtemp,readFile,writeFile,stat,readdir,rm,symlink,chmod} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {PagedCleanupManifestWriter,openPagedCleanupManifest,readPagedCleanupParts,validatePagedCleanupPart,verifyPagedReceiptPrefix,packPagedCleanupComponents,pagedHash,type PagedCleanupRecord,type PagedCleanupPart,type PagedReceipt} from '../../migrations/shared-forward/paged-cleanup-manifest.js'
const dirs:string[]=[],digest='a'.repeat(64),other='b'.repeat(64)
const root={installationId:'10000000-0000-0000-0000-000000000001',sessionId:'selected'}
const binding={identity:digest,configHash:digest,catalogHash:digest,authorityHash:digest,referenceContractHash:digest,rootsHash:digest}
function record(n:number):PagedCleanupRecord{return {table:'source_events',key:{source_event_id:`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`},references:{installation_id:root.installationId,session_id:root.sessionId},fingerprint:digest,bytes:'24',disposition:'delete'}}
function part(n=0):PagedCleanupPart{return {ordinal:String(n),phase:'raw',root,componentHash:pagedHash(['component',n]),records:[record(n)]}}
async function directory(){const d=await mkdtemp(join(tmpdir(),'pocketctl-paged-manifest-'));dirs.push(d);return d}
async function manifest(count=2){const d=await directory(),target=join(d,'plan'),writer=await PagedCleanupManifestWriter.create(target,binding);for(let i=0;i<count;i++)await writer.append(part(i));const header=await writer.finish();return {d,target,header}}
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true})})
describe('v4 body-free streaming maintenance manifest',()=>{
 test('streams bounded private parts, atomic header and exact decimal identities',async()=>{
  const d=await directory(),target=join(d,'plan'),writer=await PagedCleanupManifestWriter.create(target,binding)
  await writer.append(part(0));expect(await readdir(d)).not.toContain('plan')
  await writer.append({...part(1),records:[record(1),{...record(2),key:{feed_id:'9007199254740993'}}]})
  const header=await writer.finish();expect(header).toMatchObject({schemaVersion:4,partCount:'2',rowCount:'3',workBytes:'72'})
  expect((await stat(target)).mode&0o077).toBe(0);for(const name of await readdir(target))expect((await stat(join(target,name))).mode&0o077).toBe(0)
  const opened=await openPagedCleanupManifest(target);expect(opened.header).toEqual(header)
  const parts=[];for await(const p of readPagedCleanupParts(opened))parts.push(p)
  expect(parts.map(p=>p.ordinal)).toEqual(['0','1']);expect(parts[1].records[1].key.feed_id).toBe('9007199254740993');expect(await readdir(d)).toEqual(['plan'])
 })
 test('abort leaves no completed partial and prior output is never overwritten',async()=>{
  const {d,target}=await manifest(1),original=await readFile(join(target,'manifest.json'),'utf8')
  await expect(PagedCleanupManifestWriter.create(target,binding)).rejects.toThrow();expect(await readFile(join(target,'manifest.json'),'utf8')).toBe(original)
  const pending=await PagedCleanupManifestWriter.create(join(d,'interrupted'),binding);await pending.append(part());await pending.abort();expect(await readdir(d)).toEqual(['plan'])
 })
 test('noncooperating destination cannot be overwritten',async()=>{
  const d=await directory(),target=join(d,'plan'),writer=await PagedCleanupManifestWriter.create(target,binding)
  await writer.append(part());await writeFile(target,'unrelated');await expect(writer.finish()).rejects.toThrow();await writer.abort();expect(await readFile(target,'utf8')).toBe('unrelated')
 })
 test('missing, changed or reordered chunks refuse',async()=>{
  const {target}=await manifest(),opened=await openPagedCleanupManifest(target),names=(await readdir(target)).filter(n=>n.startsWith('part-')).sort()
  const one=await readFile(join(target,names[0]),'utf8'),two=await readFile(join(target,names[1]),'utf8');await writeFile(join(target,names[0]),two,{mode:0o600})
  await expect(async()=>{for await(const _ of readPagedCleanupParts(opened)){}}).rejects.toThrow('paged_manifest_part')
  await writeFile(join(target,names[0]),one,{mode:0o600});await rm(join(target,names[1]));await expect(async()=>{for await(const _ of readPagedCleanupParts(opened)){}}).rejects.toThrow()
 })
 test('truncated/reordered index and unexpected files refuse',async()=>{
  const {target}=await manifest(),index=join(target,'parts.ndjson'),original=await readFile(index,'utf8'),lines=original.trimEnd().split('\n')
  await writeFile(index,lines[0]+'\n',{mode:0o600});await expect(openPagedCleanupManifest(target)).rejects.toThrow('paged_manifest_index')
  await writeFile(index,lines.reverse().join('\n')+'\n',{mode:0o600});await expect(openPagedCleanupManifest(target)).rejects.toThrow('paged_manifest_index')
  await writeFile(index,original,{mode:0o600});await writeFile(join(target,'unexpected.json'),'{}',{mode:0o600});await expect(openPagedCleanupManifest(target)).rejects.toThrow('paged_manifest_unexpected_file')
 })
 test('symlinks and public permissions refuse',async()=>{
  const {d,target}=await manifest(1);await symlink(target,join(d,'alias'));await expect(openPagedCleanupManifest(join(d,'alias'))).rejects.toThrow('private_paged_manifest')
  const file=join(target,'manifest.json');await chmod(file,0o644);await expect(openPagedCleanupManifest(target)).rejects.toThrow('private_paged_manifest');await chmod(file,0o600)
  const chunk=join(target,(await readdir(target)).find(n=>n.startsWith('part-'))!);await rm(chunk);await symlink(file,chunk)
  await expect(async()=>{for await(const _ of readPagedCleanupParts(await openPagedCleanupManifest(target))){}}).rejects.toThrow('private_paged_manifest')
 })
 test('rejects body/unknown fields, numeric IDs, unsafe identifiers and work bounds',async()=>{
  for(const changed of [{...part(),records:[{...record(1),payload:'secret'}]},{...part(),records:[{...record(1),key:{feed_id:9007199254740992}}]},{...part(),records:[{...record(1),table:'source_events; DROP TABLE x'}]},{...part(),records:[{...record(1),references:{body:'secret'}}]},{...part(),records:Array.from({length:1025},(_,i)=>record(i))},{...part(),records:[{...record(1),bytes:String(8*1024*1024+1)}]},{...part(),ordinal:'01'}])expect(()=>validatePagedCleanupPart(changed)).toThrow()
  const d=await directory(),writer=await PagedCleanupManifestWriter.create(join(d,'bad'),binding);await expect(writer.append({...part(),ordinal:'1'})).rejects.toThrow('paged_manifest_ordinal');await writer.abort();expect(await readdir(d)).toEqual([])
 })
 test('abort signal prevents publishing a completed manifest',async()=>{
  const d=await directory(),controller=new AbortController(),writer=await PagedCleanupManifestWriter.create(join(d,'cancelled'),binding,{signal:controller.signal})
  await writer.append(part());controller.abort()
  await expect(writer.finish()).rejects.toThrow('maintenance_interrupted');await writer.abort();expect(await readdir(d)).toEqual([])
 })
 test('packs many independent components into bounded pages without splitting one component',async()=>{
  async function* components(){for(let n=0;n<1030;n++){const {ordinal:_,...component}=part(n);yield component}}
  const pages=[];for await(const p of packPagedCleanupComponents(components()))pages.push(p)
  expect(pages.map(p=>p.records.length)).toEqual([1024,6]);expect(pages.map(p=>p.ordinal)).toEqual(['0','1'])
  expect(new Set(pages.flatMap(p=>p.records.map(r=>r.key.source_event_id))).size).toBe(1030)
  async function* oversized(){const {ordinal:_,...component}=part();yield {...component,records:Array.from({length:1025},(_,n)=>record(n))}}
  await expect(async()=>{for await(const _ of packPagedCleanupComponents(oversized())){}}).rejects.toThrow('paged_component_capacity')
 })
 test('shared immutable guards cannot grow the component hash list without bound',async()=>{
  async function* components(){for(let n=0;n<1030;n++){const {ordinal:_,...component}=part(n);yield {...component,records:[{...record(1),disposition:'preserve' as const}]}}}
  const sizes=[];for await(const p of packPagedCleanupComponents(components()))sizes.push(p.records.length)
  expect(sizes).toEqual([1,1])
 })
 test('v4 cannot reinterpret old versions',async()=>{
  const {target}=await manifest(1),file=join(target,'manifest.json'),header=JSON.parse(await readFile(file,'utf8'));header.schemaVersion=3;await writeFile(file,JSON.stringify(header),{mode:0o600});await expect(openPagedCleanupManifest(target)).rejects.toThrow('paged_manifest_version')
 })
 test('durable receipts prove exact contiguous committed prefix',()=>{
  const pages=[part(0),part(1),part(2)],manifestHash=digest;let previous=manifestHash
  const receipts:PagedReceipt[]=pages.slice(0,2).map((p,i)=>{const r={ordinal:String(i),manifestHash,pageHash:pagedHash(p),previousHash:previous,beforeHash:digest,afterHash:other};const receipt={...r,receiptHash:pagedHash(r)};previous=receipt.receiptHash;return receipt})
  expect(verifyPagedReceiptPrefix(manifestHash,pages,receipts)).toEqual({completed:'2',tailHash:previous})
  for(const list of [[receipts[1]],[receipts[0],receipts[0]],[receipts[0],{...receipts[1],beforeHash:other}]])expect(()=>verifyPagedReceiptPrefix(manifestHash,pages,list)).toThrow('paged_receipt_prefix')
  expect(()=>verifyPagedReceiptPrefix(other,pages,receipts)).toThrow('paged_receipt_prefix');expect(verifyPagedReceiptPrefix(manifestHash,pages,[])).toEqual({completed:'0',tailHash:manifestHash})
 })
})

test('administrator help exposes additive paged commands and original version boundary',()=>{expect(maintenanceHelp).toContain('paged-cleanup plan --config FILE --roots FILE --output NEW_DIR');expect(maintenanceHelp).toContain('paged-cleanup apply|resume|verify --config FILE --manifest DIR --output NEW_DIR');expect(maintenanceHelp).toContain('Existing cleanup versions 1/2/3 keep their original contracts')})
