import pg from 'pg'
import {describe,it,expect} from 'vitest'
import {verifyPagedCleanupCurrent,type PagedCleanupConfig,type PreparedPagedCleanupVerification} from '../../migrations/shared-forward/paged-cleanup.js'

describe('G2 opaque preparation admission without IO',()=>{
 it('rejects caller JSON, receipt flags, cloned descriptors and exotic objects before querying',async()=>{
  const client=new pg.Client()
  Object.defineProperty(client,'query',{get(){throw Error('unexpected_query_access')}})
  const config=new Proxy({},{get(){throw Error('unexpected_config_access')}}) as PagedCleanupConfig
  for(const value of [null,undefined,{},[],{kind:'prepared-paged-cleanup-verification'},{verified:true,fileStateRoot:'a'.repeat(64)},{privacyCatchupReadyForReopen:true},Object.create({kind:'prepared-paged-cleanup-verification'})]){
   await expect(verifyPagedCleanupCurrent(client,'a'.repeat(64),config,value as PreparedPagedCleanupVerification)).rejects.toThrow('paged_current_preparation_required')
  }
 })
 it('cannot acquire a capability by supplying accessors or symbols',async()=>{
  const token=Object.defineProperty({},'kind',{get(){throw Error('unexpected_token_getter')}})
  for(const value of [token,{[Symbol('prepared')]:true}]){
   await expect(verifyPagedCleanupCurrent(null as unknown as pg.Client,'',null as unknown as PagedCleanupConfig,value as PreparedPagedCleanupVerification)).rejects.toThrow('paged_current_preparation_required')
  }
 })
})
