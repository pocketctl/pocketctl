import {beforeEach,describe,expect,test,vi} from 'vitest'
import {canonicalPayloadHash} from '@pocketctl/session-source'
const fixture=vi.hoisted(()=>({view:{} as any,progress:undefined as any,query:vi.fn(),select:vi.fn(),complete:vi.fn(),failCheckpoint:false}))
vi.mock('../../sources/source-execution.js',()=>({sourceExecutionBranchFor:()=> 'canonical-active',sourceExecutionTokenFor:()=>undefined,guardSourceExecutionCommit:async()=>{},completeSourceProjection:fixture.complete}))
vi.mock('../../sources/pool-context.js',()=>({sourceConnectionKey:(p:any)=>p,sourcePoolContext:()=>({namespace:'memory'})}))
vi.mock('../../sources/observed-reader.js',()=>({createObservedPersonalMetadataReader:()=>({selectPage:fixture.select,resolve:async()=>[],proof:()=>({})}),createObservedSourceReader:()=>({})}))
vi.mock('../../sources/source-projection-admission.js',()=>({personalMetadataEnvelope:()=>({})}))
vi.mock('../../sources/processing-pins.js',()=>({runSelectedSourceTransaction:async(_p:any,_i:any,_s:any,work:any)=>work({query:fixture.query})}))
import {preparePersonalMetadataReferencePage,persistPersonalMetadataReferencePage} from '../../sources/canonical-references.js'
const pool={} as any,scope={installationId:'installation',ownerScopeKind:'personal'} as any,root={kind:'relay_event',key:'root'} as const,seal={controlRevision:'1'} as any
const version={content:'1',authorization:'1',storage:'1'},scopeHash=canonicalPayloadHash(scope).toString('hex')
const wave=(overrides={})=>({contract:'personal-metadata-wave-v1',through:'100',startVersion:version,scopeHash,controlRevision:'1',phase:'scanning',...overrides})
const receipt=(w:any)=>({source_version:{metadataWave:w},next_cursor:'durable-cursor',state:'scanning'})
async function page(w:any,upper='200',nextAfter?:string){fixture.progress=w===undefined?undefined:receipt(w);fixture.view={upperId:upper,observedVersion:{...version,content:'2'},heads:[],exhausted:nextAfter===undefined,nextAfter};const p=await preparePersonalMetadataReferencePage(pool,scope,root,seal,fixture.progress);return persistPersonalMetadataReferencePage(pool,p)}
beforeEach(()=>{fixture.complete.mockReset();fixture.select.mockReset().mockImplementation(async(_scope:any,_root:any,request:any)=>{
 for(const key of ['after','through'])if(request[key]!==undefined&&(typeof request[key]!=='string'||!/^(0|[1-9]\d*)$/.test(request[key])))throw Error('source_metadata_invalid_cursor')
 return fixture.view
});fixture.query.mockReset();fixture.failCheckpoint=false;fixture.progress=undefined
 fixture.query.mockImplementation(async(sql:string,args:any[])=>{
  if(sql.includes('lock_memory_personal_source_commit')||sql.includes('pg_try_advisory_xact_lock'))return {rows:[{locked:true}]}
  if(sql.startsWith('SELECT source_version'))return {rows:fixture.progress?[fixture.progress]:[]}
  if(sql.includes('memory_relay_source_authority'))return {rows:[{state:'current',content_revision:'2',authorization_revision:'1',storage_revision:'1'}]}
  if(sql.startsWith('INSERT INTO memory_canonical_projection_progress')){if(fixture.failCheckpoint)throw Error('checkpoint rollback');fixture.progress={source_version:JSON.parse(args[4]),next_cursor:args[5],state:args[6]}}
  return {rows:[]}
 })})
describe('finite selected metadata tail checkpoint protocol',()=>{
 test.each([false,true])('a previously ready version must durably enter the new metadata wave, exhausted=%s',async exhausted=>{
  const selectedVersion=exhausted?version:{...version,content:'2'}
  fixture.progress={source_version:selectedVersion,next_cursor:null,state:'ready'}
  fixture.view={upperId:'100',observedVersion:selectedVersion,heads:[],exhausted,...(!exhausted?{nextAfter:'64'}:{})}
  const prepared=await preparePersonalMetadataReferencePage(pool,scope,root,seal,fixture.progress)
  expect(await persistPersonalMetadataReferencePage(pool,prepared)).toMatchObject({contextReady:false})
  expect(fixture.progress.state).toBe('scanning')
  expect(fixture.progress.source_version.metadataWave).toMatchObject({startVersion:selectedVersion,phase:exhausted?'restart':'scanning',after:exhausted?'100':'64'})
  expect(fixture.progress.next_cursor).not.toBeNull();expect(fixture.complete).not.toHaveBeenCalled()
 })
 test('unstable full exhaustion schedules exactly one tail, which never becomes ready even with matching version',async()=>{
  expect(await page(wave())).toMatchObject({contextReady:false});const due=fixture.progress.source_version.metadataWave;expect(due).toMatchObject({phase:'restart',through:'100',after:'100'})
  expect(await page(due,'200','150')).toMatchObject({contextReady:false});expect(fixture.select.mock.calls.at(-1)?.[2]).toEqual({limit:64,after:'100'});const active=fixture.progress.source_version.metadataWave;expect(active).toMatchObject({phase:'restart',through:'200',after:'150',startVersion:{content:'2'}})
  expect(await page(active,'999')).toMatchObject({contextReady:false});expect(fixture.select.mock.calls.at(-1)?.[2]).toEqual({limit:64,after:'150',through:'200'});const full=fixture.progress.source_version.metadataWave;expect(full.phase).toBe('restart');expect(full.after).toBeUndefined();expect(fixture.complete).not.toHaveBeenCalled()
  expect(await page(full,'999','64')).toMatchObject({contextReady:false});expect(fixture.select.mock.calls.at(-1)?.[2]).toEqual({limit:64});expect(fixture.progress.source_version.metadataWave).toMatchObject({phase:'scanning',after:'64',through:'999'})
 })
 test('only unchanged exhausted full wave may complete ordinary context',async()=>{expect(await page(wave({startVersion:{...version,content:'2'}}))).toMatchObject({contextReady:true});expect(fixture.progress.state).toBe('ready');expect(fixture.complete).toHaveBeenCalledOnce()})
 test.each(['0','99','100'])('empty or lowered maximum tail %s imposes full zero without invalid cursor',async upper=>{await page(wave({phase:'restart',after:'100'}),upper);expect(fixture.progress.source_version.metadataWave.after).toBeUndefined();expect(fixture.progress.source_version.metadataWave.through).toBe(upper);expect(fixture.complete).not.toHaveBeenCalled()})
 test.each([{phase:'restart'},{phase:'restart',after:'100',controlRevision:'2'},{phase:'restart',after:'100',scopeHash:'0'.repeat(64)}])('legacy restart or changed authority resets to full zero %j',async patch=>{await page(wave(patch),'200','64');expect(fixture.select.mock.calls[0][2]).toEqual({limit:64});expect(fixture.progress.source_version.metadataWave.phase).toBe('scanning')})
 test.each([{through:'9',after:'10'},{through:'100',after:'101'},{through:'9223372036854775808'},{phase:'tail'},{newLedger:[]},{startVersion:{...version,extra:'1'}},{phase:'restart',through:'0100',after:'100'},{phase:'restart',after:'0100'},{through:'0100',after:'9'},{phase:'restart',through:100,after:'100'},{phase:'restart',after:100}])('unsupported shape fails closed %j',async patch=>{await expect(page(wave(patch))).rejects.toThrow('canonical_reference_wave_invalid');expect(fixture.select).not.toHaveBeenCalled();expect(fixture.complete).not.toHaveBeenCalled()})
 test('canonical equal tail witness freezes the next bound',async()=>{await page(wave({phase:'restart',after:'100'}),'200','150');expect(fixture.select.mock.calls[0][2]).toEqual({limit:64,after:'100'});expect(fixture.progress.source_version.metadataWave).toMatchObject({phase:'restart',after:'150',through:'200'})})
 test('numeric restart cursor comparison is not lexical and active bound survives preparation restart',async()=>{await page(wave({phase:'restart',after:'9',through:'100'}),'100','64');expect(fixture.select.mock.calls[0][2]).toEqual({limit:64,after:'9',through:'100'});const durable=structuredClone(fixture.progress.source_version.metadataWave);await page(durable,'100');expect(fixture.select.mock.calls.at(-1)?.[2]).toEqual({limit:64,after:'64',through:'100'});expect(fixture.progress.source_version.metadataWave.after).toBeUndefined()})
 test('failed checkpoint leaves the durable tail duty available for retry',async()=>{const due=wave({phase:'restart',after:'100'});fixture.failCheckpoint=true;await expect(page(due,'200','150')).rejects.toThrow('checkpoint rollback');expect(fixture.progress).toEqual(receipt(due));expect(fixture.complete).not.toHaveBeenCalled();fixture.failCheckpoint=false;await page(due,'200','150');expect(fixture.select.mock.calls.at(-1)?.[2]).toEqual({limit:64,after:'100'})})
})
