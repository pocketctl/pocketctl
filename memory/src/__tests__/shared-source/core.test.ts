import { describe, expect, test } from 'vitest'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalPayloadHash } from '../../inbox/canonical-json.js'
import { mapSource, type Source, type Candidate } from '../../migrations/shared-source/mapping.js'
import { classifyObject,parseObjectPlan } from '../../migrations/shared-source/classification.js'
import { capacityPlan } from '../../migrations/shared-source/capacity.js'
import {assertDistinctDatabases} from '../../migrations/shared-source/database.js'
import { ReportBundle, fingerprint, decimal } from '../../migrations/shared-source/report.js'

const hash = canonicalPayloadHash({text:'private body'}).toString('hex')
const source: Source = {
  id:'00000000-0000-0000-0000-000000000001', installationId:'installation', ownerKey:'personal:owner',
  sessionId:'session', turnId:'turn', eventType:'agent_text', hash, actualHash:hash,
  links:[{kind:'relay_event',id:'9007199254740993',via:'inbox',version:'19'}], provenance:'known', sequence:'19',
}
const candidate: Candidate = {
  kind:'relay_event', id:'9007199254740993', installationId:'installation', ownerKey:'personal:owner',
  sessionId:'session',turnId:'turn',eventType:'agent_text',hash,version:'19',sequence:'19',
  storage:'hot', authorityVerified:true, provenance:'known',
}

test('only explicit own object reviews can approve an object; inherited table names remain unknown',()=>{
 const object={kind:'table',schema:'public',name:'source_events',key:'table:public.source_events',definitionHash:'a'.repeat(64)}
 const inherited=Object.create({[object.key]:{action:'migrate-as-is',definitionHash:object.definitionHash}})
 expect(classifyObject(object,inherited).blocked).toBe(true)
 for(const name of ['constructor','toString','__proto__'])expect(classifyObject({...object,name,key:'table:public.'+name},{})).toMatchObject({action:'unclassified',blocked:true})
 const plan=parseObjectPlan(JSON.parse('{"__proto__":{"action":"migrate-as-is","definitionHash":"'+'a'.repeat(64)+'"}}'))
 expect(Object.hasOwn(plan,'__proto__')).toBe(true);expect(Object.getPrototypeOf(plan)).toBeNull()
})
test('known JSON column routes are suggestions and still need an exact definition review',()=>{
 const object={kind:'json-column',schema:'memory',name:'source_events.payload',key:'json-column:memory.source_events.payload',definitionHash:'a'.repeat(64)}
 expect(classifyObject(object,{})).toMatchObject({action:'transform',blocked:true,reasons:['object_review_required']})
 expect(classifyObject({...object,name:'source_events.new_payload'},{})).toMatchObject({action:'unclassified',blocked:true})
 expect(classifyObject(object,{[object.key]:{action:'transform',definitionHash:object.definitionHash}}).blocked).toBe(false)
})

describe('shared source proof gate',()=>{
 test('retains UUID and bigint without using the body as identity',()=>{
  const result=mapSource(source,[candidate])
  expect(result).toMatchObject({sourceEventId:source.id,state:'unique-hot',contentHash:hash,sourceVersion:'19',canonicalId:'9007199254740993',replacementProven:true,deletionEligible:false})
  expect(JSON.stringify(result)).not.toContain('private body')
  expect(mapSource({...source,links:[]},[candidate]).state).toBe('unproven')
 })
 test.each(['ownerKey','sessionId','turnId','eventType','installationId','version','sequence','hash'] as const)('rejects mismatched %s',key=>{
  expect(mapSource(source,[{...candidate,[key]:'wrong'}]).state).toBe('conflict')
 })
 test('does not confuse identical text from different events or duplicate candidates',()=>{
  const other={...candidate,id:'9007199254740994'}
  expect(mapSource(source,[other]).state).toBe('unproven')
  const linked={...source,links:[...source.links,{...source.links[0],id:other.id}]}
  expect(mapSource(linked,[candidate,other]).state).toBe('ambiguous')
  expect(mapSource(source,[candidate,{...candidate}]).state).toBe('unique-hot')
  expect(mapSource(source,[candidate,{...candidate,hash:'f'.repeat(64)}]).state).toBe('conflict')
 })
 test('classification changes cannot reuse a content-only proof',()=>{
  expect(mapSource({...source,classificationHash:'a'.repeat(64)},[{...candidate,classificationHash:'b'.repeat(64)}]).state).toBe('conflict')
 })
 test('unknown provenance stays unknown; reclaimed sources cannot regain access',()=>{
  expect(mapSource({...source,provenance:'unknown'},[candidate])).toMatchObject({state:'unproven',replacementProven:false})
  expect(mapSource({...source,bodyReclaimed:true},[candidate]).reasons).toContain('memory_body_reclaimed')
 })
 test('an independently verified original Feed identity preserves unknown lineage and absent order',()=>{
  const s={...source,provenance:'unknown' as const,sequence:undefined,links:[{kind:'relay_event' as const,id:candidate.id,via:'feed' as const}]}
  const c={...candidate,provenance:'unknown' as const,sequence:undefined,version:'',originalIdentityProof:{kind:'retained-feed-v1' as const,manifestHash:'a'.repeat(64)}}
  expect(mapSource(s,[c])).toMatchObject({state:'unique-hot',replacementProven:true,provenanceState:'unknown',originalIdentityManifestHash:'a'.repeat(64),deletionEligible:false})
  expect(mapSource(s,[c]).sourceVersion).toBeUndefined()
  expect(mapSource(s,[c]).sourceSequence).toBeUndefined()
  for(const bad of [{...c,originalIdentityProof:undefined},{...c,originalIdentityProof:{...c.originalIdentityProof,manifestHash:'bad'}},{...c,provenance:'known' as const},{...c,sequence:'1'},{...c,authorityVerified:false}])expect(mapSource(s,[bad]).replacementProven).toBe(false)
  expect(mapSource(s,[{...c,hash:'b'.repeat(64)}]).state).toBe('conflict')
  expect(mapSource({...s,links:[]},[c]).replacementProven).toBe(false)
  expect(mapSource({...s,sequence:'19'},[c]).replacementProven).toBe(false)
 })
 test('cold data requires archive verification in addition to hot identity',()=>{
  expect(mapSource(source,[{...candidate,storage:'cold'}]).state).toBe('unproven')
  expect(mapSource(source,[{...candidate,storage:'cold',archiveVerified:true}]).state).toBe('unique-cold')
 })
 test.each(['team_collaboration','team_delivery'] as const)('uses a distinct %s identity',kind=>{
  expect(mapSource({...source,links:[{kind,id:'team:proof',via:'journal',version:'2'}]},[
   {...candidate,kind,id:'team:proof',version:'2',teamVerified:true},
  ]).state).toBe(kind==='team_delivery'?'accepted-delivery':'team-collaboration')
  expect(mapSource({...source,links:[{kind,id:'team:proof',via:'journal',version:'2'}]},[
   {...candidate,kind,id:'team:proof',version:'2'},
  ]).state).toBe('unproven')
 })
 test('absence is not a deletion or legacy-only proof',()=>{
  expect(mapSource(source,[]).state).toBe('unproven')
  expect(mapSource({...source,tombstone:{verified:true,ownerKey:source.ownerKey,sessionId:source.sessionId}},[]).state).toBe('known-deleted')
  expect(mapSource({...source,tombstone:{verified:true,ownerKey:'other',sessionId:source.sessionId}},[]).state).toBe('conflict')
  expect(mapSource({...source,legacyProof:{identityVerified:true,completeTargetSearch:true,archiveVerified:true}},[]).state).toBe('unproven')
  const legacyProof={identityVerified:true,completeTargetSearch:true,archiveVerified:true,manifestHash:'f'.repeat(64)}
  expect(mapSource({...source,legacyProof},[]).state).toBe('verified-legacy-only')
  expect(mapSource({...source,provenance:'unknown',legacyProof},[])).toMatchObject({state:'verified-legacy-only',provenanceState:'unknown',sourceKind:'legacy_archive',canonicalId:source.id,deletionEligible:false})
  expect(mapSource({...source,provenance:'unknown',legacyProof},[candidate]).state).toBe('unproven')
 })
 test('tombstones cannot suppress a conflicting canonical identity',()=>{
  const deleted={...source,tombstone:{verified:true,ownerKey:source.ownerKey,sessionId:source.sessionId}}
  expect(mapSource(deleted,[{...candidate,sessionId:'other-session'}]).state).toBe('conflict')
  expect(mapSource(deleted,[{...candidate,hash:'e'.repeat(64)}]).state).toBe('conflict')
 })
 test('detects corrupt stored hash before proposing replacement',()=>{
  expect(mapSource({...source,actualHash:'e'.repeat(64)},[candidate]).state).toBe('conflict')
 })
})

test('classification is explicit and additions or changed definitions block',()=>{
 const object={key:'table:public.source_events',kind:'table',schema:'public',name:'source_events',definitionHash:'a'.repeat(64)}
 expect(classifyObject(object,{})).toMatchObject({action:'transform',blocked:true})
 expect(classifyObject({...object,name:'new_table',key:'table:public.new_table'},{})).toMatchObject({action:'unclassified',blocked:true})
 expect(classifyObject(object,{[object.key]:{action:'transform',definitionHash:object.definitionHash}}).blocked).toBe(false)
 expect(classifyObject(object,{[object.key]:{action:'transform',definitionHash:'b'.repeat(64)}}).blocked).toBe(true)
})

test('capacity requires every measured component and never spends future savings',()=>{
 const input={policy:'recoverable' as const,existingAllocatedBytes:'9007199254740993',freeBytes:'10000000000',targetBytes:'1000',stagingBytes:'0',temporaryIndexBytes:'500',walBytes:'100',restoreBytes:'600',mappingBytes:'200',growthBytes:'300',copySeconds:'10',indexSeconds:'2',restoreSeconds:'8',evidenceId:'isolated-rehearsal-v1'}
 expect(capacityPlan(input)).toMatchObject({ready:true,peakAdditionalBytes:'2700',safetyBytes:'2147483648',requiredFreeBytes:'2147486348'})
 expect(capacityPlan({...input,targetBytes:undefined})).toMatchObject({ready:false,status:'not-ready'})
 expect(capacityPlan({...input,freeBytes:'2700'}).ready).toBe(false)
 expect(()=>capacityPlan({...input,walBytes:'-1'})).toThrow()
 expect(()=>decimal(9007199254740993)).toThrow()
 expect(decimal(9007199254740993n)).toBe('9007199254740993')
})

test('forward-only Memory capacity omits backup/restore requirements while retaining real copy/WAL/safety measurements',()=>{
 const input={existingAllocatedBytes:'9007199254740993',freeBytes:'10000000000',targetBytes:'1000',stagingBytes:'0',temporaryIndexBytes:'500',walBytes:'100',mappingBytes:'200',growthBytes:'300',copySeconds:'10',indexSeconds:'2',evidenceId:'forward-live-v1'}
 expect(capacityPlan(input)).toMatchObject({policy:'forward-only',ready:true,peakAdditionalBytes:'2100',backupRequired:false,rollbackSupported:false,waivedChecks:['memory_backup','memory_restore','memory_rollback']})
 expect(capacityPlan({...input,walBytes:undefined})).toMatchObject({ready:false,missing:expect.arrayContaining(['walBytes'])})
 expect(()=>capacityPlan({...input,policy:'ignore-everything'} as any)).toThrow('invalid_capacity_policy')
})

test('forward capacity refuses to omit the per-table staging allocation',()=>{
 const input={existingAllocatedBytes:'0',freeBytes:'10000000000',targetBytes:'1000',temporaryIndexBytes:'500',walBytes:'100',mappingBytes:'200',growthBytes:'300',copySeconds:'10',indexSeconds:'2',evidenceId:'stage-measured-v1'}
 expect(capacityPlan(input)).toMatchObject({ready:false,missing:expect.arrayContaining(['stagingBytes'])})
 expect(capacityPlan({...input,stagingBytes:'9007199254740993'})).toMatchObject({ready:false,peakAdditionalBytes:'9007199254743093'})
})

test('report bundles are private, atomically completed, and never overwritten',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shared-source-report-')), path=join(root,'run')
 const bundle=await ReportBundle.create(path)
 await bundle.write('inventory.json',{identity:fingerprint('postgres://user:password@host/db'),count:9007199254740993n})
 await bundle.detail({sourceEventId:source.id,state:'unproven',reasons:['missing_identity']})
 await bundle.finish()
 expect((await stat(join(path,'mapping-details.ndjson'))).mode&0o777).toBe(0o600)
 expect((await stat(path)).mode&0o777).toBe(0o700)
 expect(await readFile(join(path,'inventory.json'),'utf8')).not.toMatch(/password|postgres:\/\//)
 expect(await readFile(join(path,'inventory.json'),'utf8')).toContain('9007199254740993')
 await expect(ReportBundle.create(path)).rejects.toThrow()
 const interrupted=await ReportBundle.create(join(root,'interrupted'))
 await interrupted.detail({state:'unproven'})
 await interrupted.abort()
 expect(await readdir(root)).toEqual(['run'])
})

test('same database through distinct roles is still the same database',()=>{
 const a={databaseFingerprint:'same-database',fingerprint:'role-a'}
 const b={databaseFingerprint:'same-database',fingerprint:'role-b'}
 expect(()=>assertDistinctDatabases(a,b)).toThrow('distinct_databases_required')
 expect(()=>assertDistinctDatabases(a,{...b,databaseFingerprint:'other-database'})).not.toThrow()
})
