import {expect,test} from 'vitest'
import {reviewMemoryObjects,type CatalogReviewProofs} from '../../migrations/shared-source/object-review.js'
import type {CatalogObject} from '../../migrations/shared-source/classification.js'
const hash='a'.repeat(64),changed='b'.repeat(64)
const object=(kind:string,name:string,extra:Record<string,unknown>={}):CatalogObject=>({key:kind+':public.'+name,kind,schema:'public',name,definitionHash:hash,...extra})
const proofs:CatalogReviewProofs={internalTriggers:[],sequenceStateProofs:[],extensionMembers:[]}
test('source-derived exact definitions receive explicit destinations; matching an unknown table name never approves it',()=>{
 const known=[object('table','source_events'),object('table','knowledge_claims'),object('function','memory_known()'),object('json-column','source_events.payload',{parent:'source_events'}),object('index','source_events_pkey',{parent:'source_events',valid:true,ready:true}),object('constraint','source_events.source_pk',{parent:'source_events',valid:true})]
 const result=reviewMemoryObjects(known,known,proofs)
 expect(result.unreviewed).toEqual([])
 expect(result.plan[known[0].key].action).toBe('transform')
 expect(result.plan[known[1].key].action).toBe('migrate-as-is')
 expect(result.plan[known[2].key].action).toBe('transform')
 expect(result.plan[known[3].key].action).toBe('transform')
 const unknown=object('table','surprise_table')
 expect(reviewMemoryObjects([unknown],[unknown],proofs).unreviewed).toHaveLength(1)
})
test('changed definitions and unsupported objects remain blocked even with a known parent',()=>{
 const baseline=[object('table','source_events'),object('function','memory_known()')]
 const result=reviewMemoryObjects([{...baseline[1],definitionHash:changed},object('index','new_unreviewed_index',{parent:'source_events',valid:true,ready:true}),object('foreign-table','source_events')],baseline,proofs)
 expect(result.unreviewed).toHaveLength(3);expect(Object.keys(result.plan)).toHaveLength(0)
})
test('generated FK trigger proof binds both definitions, parent and one-to-one baseline identity',()=>{
 const a=object('trigger','source_events.RI_ConstraintTrigger_c_10',{parent:'source_events',internal:true}),b={...a,key:'trigger:public.source_events.RI_ConstraintTrigger_c_20',name:'source_events.RI_ConstraintTrigger_c_20',definitionHash:changed}
 const proof={liveKey:b.key,liveDefinitionHash:changed,baselineKey:a.key,baselineDefinitionHash:hash}
 expect(reviewMemoryObjects([b],[a],{...proofs,internalTriggers:[proof]}).plan[b.key].action).toBe('derived-rebuild')
 expect(reviewMemoryObjects([b],[a],{...proofs,internalTriggers:[{...proof,liveDefinitionHash:hash}]}).unreviewed).toHaveLength(1)
 const c={...b,key:'trigger:public.source_events.RI_ConstraintTrigger_c_30',name:'source_events.RI_ConstraintTrigger_c_30'}
 expect(reviewMemoryObjects([b,c],[a],{...proofs,internalTriggers:[proof,{...proof,liveKey:c.key}]}).unreviewed.length).toBeGreaterThan(0)
})
test('extension members are retained in public instead of copied as Memory-owned functions',()=>{
 const fn=object('function','word_similarity(text, text)')
 expect(reviewMemoryObjects([fn],[fn],{...proofs,extensionMembers:[fn.key]}).plan[fn.key].action).toBe('retain-relay')
})
test('sequence state needs reproduced configuration proof, readable exact decimal state and matching live hash',()=>{
 const base=object('sequence-state','counter'),live={...base,definitionHash:changed,lastValue:'9007199254740993',isCalled:false,stateReadable:true}
 const proof={key:live.key,definitionHash:changed,baselineConfigHash:hash}
 expect(reviewMemoryObjects([live],[base],{...proofs,sequenceStateProofs:[proof]}).plan[live.key].action).toBe('migrate-as-is')
 expect(reviewMemoryObjects([{...live,lastValue:9007199254740993}],[base],{...proofs,sequenceStateProofs:[proof]}).unreviewed).toHaveLength(1)
 expect(reviewMemoryObjects([{...live,stateReadable:false}],[base],{...proofs,sequenceStateProofs:[proof]}).unreviewed).toHaveLength(1)
})
test('ACL owner substitution preserves the exact grant bits; a new privilege or grant recipient is blocked',()=>{
 const base=object('permission','function.memory_known()',{ownerFingerprint:hash,grants:[{grantorFingerprint:hash,granteeFingerprint:hash,public:false,privilege:'EXECUTE',grantable:false}]})
 const live={...base,definitionHash:changed,ownerFingerprint:changed,grants:[{grantorFingerprint:changed,granteeFingerprint:changed,public:false,privilege:'EXECUTE',grantable:false}]}
 expect(reviewMemoryObjects([live],[base],proofs).plan[live.key].action).toBe('transform')
 const elevated={...live,grants:[...live.grants,{grantorFingerprint:changed,granteeFingerprint:'c'.repeat(64),public:false,privilege:'EXECUTE',grantable:false}]}
 expect(reviewMemoryObjects([elevated],[base],proofs).unreviewed).toHaveLength(1)
})
test('duplicate catalog identities and inherited proof entries cannot be approved',()=>{
 const table=object('table','source_events')
 expect(reviewMemoryObjects([table,table],[table],proofs).unreviewed).toHaveLength(2)
 const fake=Object.create({extensionMembers:[table.key]})
 expect(()=>reviewMemoryObjects([table],[table],fake)).toThrow('invalid_catalog_review_proofs')
})

test('only the separately identified legacy service owners receive global-role dispositions',()=>{
 const role=(id:string,extra:Record<string,unknown>={})=>object('role',id,{key:'role:*.'+id,schema:'*',superuser:false,createRole:false,createDatabase:false,bypassRls:false,replication:false,inherit:true,canLogin:true,memberships:[],settingsFingerprint:hash,...extra})
 const memory=role(hash),relay=role(changed),unknown=role('c'.repeat(64))
 const context={...proofs,memoryDatabaseOwnerFingerprint:hash,relayDatabaseOwnerFingerprint:changed}
 const result=reviewMemoryObjects([memory,relay,unknown],[],context)
 expect(result.plan[memory.key].action).toBe('retire-after-gate')
 expect(result.plan[relay.key].action).toBe('retain-relay')
 expect(result.unreviewed.map(r=>r.key)).toEqual([unknown.key])
 expect(reviewMemoryObjects([role(hash,{replication:true})],[],context).unreviewed).toHaveLength(1)
})
test('the old Memory database ACL is archived as owner-only metadata, never granted to the shared runtime',()=>{
 const permission=object('permission','database',{key:'permission:*.database.'+changed,schema:'*',ownerFingerprint:hash,
  grants:['CONNECT','CREATE','TEMPORARY'].map(privilege=>({grantorFingerprint:hash,granteeFingerprint:hash,public:false,privilege,grantable:false}))})
 expect(reviewMemoryObjects([permission],[],{...proofs,memoryDatabaseOwnerFingerprint:hash}).plan[permission.key].action).toBe('audit-archive')
 expect(reviewMemoryObjects([{...permission,grants:[...(permission.grants as any[]),{grantorFingerprint:hash,granteeFingerprint:changed,public:false,privilege:'CONNECT',grantable:false}]}],[],{...proofs,memoryDatabaseOwnerFingerprint:hash}).unreviewed).toHaveLength(1)
})
