import {test,expect} from 'vitest'
import {PostgresRelaySourceStore} from '@pocketctl/session-source'
const scope={installationId:'installation',principalUserId:'1',ownerScopeKind:'personal' as const,ownerScopeId:'installation',authorizationRevision:'1',configVersion:'1',modeGeneration:'3'}
const root={kind:'relay_event' as const,key:'1:session'}
for(const [sqlstate,code]of [['57014','source_store_timeout'],['55P03','source_store_busy'],['40001','source_store_busy'],['40P01','source_store_busy'],['42501','source_store_unavailable']])test('classifies '+sqlstate+' without disclosing SQL or payload',async()=>{
 const store=new PostgresRelaySourceStore({query:async()=>{throw Object.assign(new Error('private SQL body'),{code:sqlstate,detail:'secret'})}} as any)
 let error:any;try{await store.checkCurrent(scope,root)}catch(e){error=e}
 expect(error.code).toBe(code);expect(error.message).not.toContain('private');expect(error.detail).toBeUndefined();expect(error.cause).toBeUndefined()
})
