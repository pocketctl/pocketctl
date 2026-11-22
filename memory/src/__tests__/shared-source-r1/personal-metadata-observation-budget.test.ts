import {expect,test,vi} from 'vitest'
import {createPostgresPersonalMetadataReader} from '@pocketctl/session-source'

test('retired whole-session metadata selectors cannot query storage',async()=>{
 const unavailable=vi.fn(async()=>{throw Error('unexpected database access')})
 const reader=createPostgresPersonalMetadataReader({connect:unavailable,query:unavailable})
 const scope={installationId:'installation',principalUserId:'1',ownerScopeKind:'personal' as const,
  ownerScopeId:'installation',authorizationRevision:'1',configVersion:'1',modeGeneration:'3'}
 const root={kind:'relay_event' as const,key:'1:session'}
 await expect(reader.selectKeys(scope,root,['1'])).rejects.toMatchObject({code:'source_kind_unsupported'})
 await expect(reader.selectPage(scope,root)).rejects.toMatchObject({code:'source_kind_unsupported'})
 expect(unavailable).not.toHaveBeenCalled()
})
