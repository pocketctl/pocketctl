import { describe,expect,test } from 'vitest'
import { createGitRuntime,createGitPollingScheduler } from '../git-sync/runtime.js'
import { loadGitSyncConfig } from '../git-sync/config.js'
import type pg from 'pg'
const connection={installationId:'00000000-0000-4000-8000-000000000001',repositoryId:'00000000-0000-4000-8000-000000000002',connectionId:'00000000-0000-4000-8000-000000000003',
  provider:'github' as const,providerRepositoryId:'123',targetBranch:'main',rootPath:'.pocketctl/knowledge',ownerScopeKind:'team' as const,ownerScopeId:'00000000-0000-4000-8000-000000000004',state:'active' as const,syncMode:'enabled' as const,writeMode:'off' as const,generation:'1'}
const target={installationId:connection.installationId,repositoryId:connection.repositoryId,targetId:'fixed',credentialRef:'read-token',credentialFile:'/fixture/token',provider:'github',providerRepositoryId:'123',owner:'example',repository:'knowledge',branch:'main',private:true,scopeMode:'enabled'}
const consent={installationId:connection.installationId,connectionId:connection.connectionId,providerRepositoryId:'123',branch:'main',consentId:'00000000-0000-4000-8000-000000000005',expiresAt:'2099-01-01T00:00:00Z',permission:'read'}
describe('server-owned Git runtime',()=>{
  test('off scheduler does not scan the database or resolve any scope/secret configuration',async()=>{
    let touched=0
    const scheduler=createGitPollingScheduler({pool:{query:async()=>{touched++;throw new Error('unexpected scan')}} as unknown as pg.Pool,
      config:loadGitSyncConfig({}),scopeMode:async()=>{touched++;throw new Error('unexpected resolution')},signal:new AbortController().signal})
    scheduler.start();await scheduler.tick();await scheduler.stop();expect(touched).toBe(0)
  })
  test('default off does not read any key/credential/registry file or expose writes',async()=>{
    const runtime=await createGitRuntime({pool:{} as pg.Pool,config:loadGitSyncConfig({}),globalMode:'enabled',sharedMode:'enabled',env:{MEMORY_GIT_SIGNING_KEY_FILE:'/missing'},readFile:async()=>{throw new Error('must not read')}})
    expect(await runtime.scopeMode(connection)).toBe('off');expect(runtime.reads).toBeUndefined();expect(runtime.keys).toBeUndefined();expect(runtime).not.toHaveProperty('fixtureWrites')
  })
  test('enabled mode plus a token cannot authorize reads without current matching consent',async()=>{
    const readPaths:string[]=[],requests:string[]=[]
    let consentEntries:unknown[]=[]
    const runtime=await createGitRuntime({pool:{query:async()=>({rows:[{target_id:'fixed',credential_ref:'read-token'}]})} as unknown as pg.Pool,
      config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),globalMode:'enabled',sharedMode:'enabled',
      env:{MEMORY_GIT_TARGET_REGISTRY_PATH:'/fixture/registry',MEMORY_GIT_READ_CONSENT_FILE:'/fixture/consent'},
      readFile:async path=>{readPaths.push(path);return Buffer.from(path==='/fixture/registry'?JSON.stringify({targets:[target]}):path==='/fixture/consent'?JSON.stringify({consents:consentEntries}):'TEST_ONLY_TOKEN')},
      fetch:async url=>{requests.push(String(url));return Response.json([])}})
    expect(await runtime.scopeMode(connection)).toBe('enabled')
    expect(await runtime.reads!.resolve(connection)).toBeNull();expect(readPaths).not.toContain('/fixture/token')
    consentEntries=[consent];const cap=await runtime.reads!.resolve(connection);expect(cap).not.toBeNull()
    await cap!.request({operation:'poll',cursor:null},new AbortController().signal);expect(requests).toHaveLength(1)
    consentEntries=[];await expect(cap!.request({operation:'poll',cursor:null},new AbortController().signal)).rejects.toThrow('read_not_authorized');expect(requests).toHaveLength(1)
    expect(runtime).not.toHaveProperty('fixtureWrites')
  })
  test('independent recovery consent exposes GET metadata only and rechecks consent per request',async()=>{
    let allowed=true;const methods:string[]=[]
    const runtime=await createGitRuntime({pool:{query:async()=>({rows:[{target_id:'fixed',credential_ref:'read-token'}]})} as unknown as pg.Pool,
      config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),globalMode:'enabled',sharedMode:'enabled',
      env:{MEMORY_GIT_TARGET_REGISTRY_PATH:'/fixture/registry',MEMORY_GIT_READ_CONSENT_FILE:'/fixture/consent'},
      readFile:async path=>Buffer.from(path==='/fixture/registry'?JSON.stringify({targets:[target]}):path==='/fixture/consent'?JSON.stringify({consents:allowed?[consent]:[]}):'TEST_ONLY_TOKEN'),
      fetch:async(_url,init)=>{methods.push(init?.method??'GET');return Response.json({})}})
    const cap=await runtime.recoveryReads!.resolve(connection);expect(cap).not.toBeNull()
    await cap!.request({action:'repository'},new AbortController().signal)
    await expect(cap!.request({action:'create_branch',branch:'unsafe',sha:'a'.repeat(40)} as never,new AbortController().signal)).rejects.toThrow('read_not_authorized')
    allowed=false;await expect(cap!.request({action:'repository'},new AbortController().signal)).rejects.toThrow('read_not_authorized')
    expect(methods).toEqual(['GET'])
  })
  test('shared/scope/global mode uses the strictest setting',async()=>{
    const runtime=await createGitRuntime({pool:{} as pg.Pool,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),globalMode:'enabled',sharedMode:'off',
      env:{MEMORY_GIT_TARGET_REGISTRY_PATH:'/fixture/registry'},readFile:async()=>Buffer.from(JSON.stringify({targets:[target]}))})
    expect(await runtime.scopeMode(connection)).toBe('off');expect(await runtime.reads!.resolve(connection)).toBeNull()
  })
})
