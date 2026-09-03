/** Hermetic config rendering and runtime assembly. No daemon/start/DB/network. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
import { loadGitSyncConfig } from '../../../src/git-sync/config.js'
import { createGitRuntime } from '../../../src/git-sync/runtime.js'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const defaults = {
  MEMORY_GIT_SYNC_MODE: 'off', MEMORY_GIT_WRITE_MODE: 'off', MEMORY_GIT_MAX_CONCURRENCY: '1',
  MEMORY_GIT_REQUEST_TIMEOUT_MS: '15000', MEMORY_GIT_POLL_INTERVAL_MS: '60000', MEMORY_GIT_MAX_HTTP_ATTEMPTS: '128',
  MEMORY_GIT_MAX_FAILURES: '5', MEMORY_GIT_MAX_TASK_AGE_MS: '86400000', MEMORY_GIT_MAX_FILES: '256',
  MEMORY_GIT_MAX_FILE_BYTES: '262144', MEMORY_GIT_MAX_TOTAL_BYTES: '8388608',
  MEMORY_GIT_TARGET_REGISTRY_PATH: '', MEMORY_GIT_READ_CONSENT_FILE: '', MEMORY_GIT_SIGNING_KEY_FILE: '', MEMORY_GIT_SIGNING_KEY_ID: '',
}
const production = {
  RELAY_EXTENSIONS: 'off', POSTGRES_ADMIN_PASSWORD: 'contract-admin', POSTGRES_APP_PASSWORD: 'contract-app',
  AUTH_CODE_PEPPER: 'contract-pepper', JWT_SECRET: 'contract-jwt', TLS_CERT_PATH: '/contract/cert.pem', TLS_KEY_PATH: '/contract/key.pem',
  MEMORY_MODE: 'off', MEMORY_POSTGRES_PASSWORD: 'contract-memory', MEMORY_RELAY_URL: 'http://relay:8080',
  MEMORY_RELAY_ISSUER: 'https://relay.example.invalid', MEMORY_PROVIDER_CLIENT_ID: 'contract-id',
  MEMORY_PROVIDER_CLIENT_SECRET: 'contract-client', MEMORY_HMAC_KEY: 'contract-hmac',
}
function render(manifest: string, overrides: Record<string, string> = {}) {
  const result = spawnSync('docker', ['compose', '--env-file', '/dev/null', '-f', manifest, 'config', '--format', 'json'], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG, ...production, ...overrides },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout).services
}
const target = { installationId: '00000000-0000-4000-8000-000000000001', repositoryId: '00000000-0000-4000-8000-000000000002',
  connectionId: '00000000-0000-4000-8000-000000000003', ownerScopeKind: 'team' as const, ownerScopeId: '00000000-0000-4000-8000-000000000001',
  provider: 'github' as const, providerRepositoryId: '123', targetBranch: 'main', rootPath: '.pocketctl/knowledge',
  state: 'active' as const, syncMode: 'enabled' as const, writeMode: 'off' as const, generation: '1' }
for (const manifest of process.argv.slice(2).length ? process.argv.slice(2) : ['docker-compose.yml', 'docker-compose.prod.yml']) {
  const services = render(manifest)
  for (const name of ['memory-api', 'memory-worker']) {
    const env = services[name].environment
    assert.deepEqual(Object.fromEntries(Object.keys(defaults).map(k => [k, env[k]])), defaults)
    assert.equal(services[name].volumes?.some((v: {target: string}) => v.target.includes('git')), undefined)
    // Invalid paths must not force secret reads or enable a capability under off.
    const runtime = await createGitRuntime({ pool: {} as pg.Pool, config: loadGitSyncConfig(env), globalMode: 'enabled', sharedMode: 'enabled',
      env: { ...env, MEMORY_GIT_TARGET_REGISTRY_PATH: '/missing/registry', MEMORY_GIT_READ_CONSENT_FILE: '/missing/consent', MEMORY_GIT_SIGNING_KEY_FILE: '/missing/key' },
      readFile: async () => { throw new Error('off touched runtime files') }, fetch: async () => { throw new Error('network forbidden') } })
    assert.equal(await runtime.scopeMode(target), 'off')
    assert.equal(runtime.reads, undefined); assert.equal(runtime.recoveryReads, undefined); assert.equal(runtime.keys, undefined)
    assert.equal('writes' in runtime, false); assert.equal('fixtureWrites' in runtime, false)
  }
  const overrides = { ...defaults, MEMORY_GIT_SYNC_MODE: 'shadow', MEMORY_GIT_WRITE_MODE: 'shadow', MEMORY_GIT_REQUEST_TIMEOUT_MS: '1000',
    MEMORY_GIT_MAX_HTTP_ATTEMPTS: '8', MEMORY_GIT_TARGET_REGISTRY_PATH: '/run/secrets/memory_git_targets',
    MEMORY_GIT_READ_CONSENT_FILE: '/run/secrets/memory_git_consent', MEMORY_GIT_SIGNING_KEY_FILE: '/run/secrets/memory_git_signing', MEMORY_GIT_SIGNING_KEY_ID: 'rehearsal-key' }
  const changed = render(manifest, overrides)
  for (const name of ['memory-api', 'memory-worker']) {
    const env = changed[name].environment
    assert.deepEqual(Object.fromEntries(Object.keys(defaults).map(k => [k, env[k]])), overrides)
    assert.equal(loadGitSyncConfig(env).maxHttpAttempts, 8)
    // Identical fully registered, consented inputs isolate the mode gate. All
    // files, credentials, target lookup and HTTP are in-memory test doubles.
    const runtimeEnv={...env,MEMORY_GIT_SIGNING_KEY_FILE:'',MEMORY_GIT_SIGNING_KEY_ID:''}
    const registry={targets:[{installationId:target.installationId,repositoryId:target.repositoryId,targetId:'synthetic-target',provider:'github',
      providerRepositoryId:'123',owner:'fixture',repository:'example',branch:'main',private:true,credentialRef:'synthetic-token',credentialFile:'/synthetic/token',scopeMode:'enabled'}]}
    const consents={consents:[{installationId:target.installationId,connectionId:target.connectionId,providerRepositoryId:'123',branch:'main',
      consentId:'00000000-0000-4000-8000-000000000004',permission:'read',expiresAt:new Date(Date.now()+60_000).toISOString()}]}
    for(const mode of ['shadow','enabled'] as const){
      let tokens=0,fetches=0,queries=0
      const runtime=await createGitRuntime({pool:{query:async(_sql:string,values:string[])=>{
        assert.deepEqual(values,[target.installationId,target.connectionId]);queries++
        return {rows:[{target_id:'synthetic-target',credential_ref:'synthetic-token'}]}
      }} as unknown as pg.Pool,config:loadGitSyncConfig({...env,MEMORY_GIT_SYNC_MODE:mode}),globalMode:'enabled',sharedMode:'enabled',env:runtimeEnv,
      readFile:async path=>{
        if(path===env.MEMORY_GIT_TARGET_REGISTRY_PATH)return Buffer.from(JSON.stringify(registry))
        if(path===env.MEMORY_GIT_READ_CONSENT_FILE)return Buffer.from(JSON.stringify(consents))
        if(path==='/synthetic/token'){tokens++;return Buffer.from('synthetic-no-real-credential')}
        throw new Error('unexpected synthetic path')
      },fetch:async()=>{fetches++;throw new Error('synthetic transport boundary')}})
      assert.equal('writes' in runtime,false);assert.equal('fixtureWrites' in runtime,false)
      const read=await runtime.reads!.resolve(target),recovery=await runtime.recoveryReads!.resolve(target)
      if(mode==='shadow'){assert.equal(read,null);assert.equal(recovery,null);assert.equal(tokens,0);assert.equal(queries,0)}
      else{
        assert.equal(read?.kind,'live');assert.equal(recovery?.kind,'live');assert.equal(tokens,2);assert.equal(queries,2)
        await assert.rejects(read!.request({operation:'repository'},new AbortController().signal),/provider_failure/)
        await assert.rejects(recovery!.request({action:'repository'},new AbortController().signal),/provider_failure/)
      }
      assert.equal(fetches,mode==='shadow'?0:2)
    }
  }
  const denied = render(manifest, { MEMORY_GIT_WRITE_MODE: 'enabled' })
  for (const name of ['memory-api', 'memory-worker']) assert.throws(() => loadGitSyncConfig(denied[name].environment), /MEMORY_GIT_WRITE_MODE/)
  console.log(`${manifest}: Phase6 defaults, parity, bounded overrides, off missing-files, closed write runtime PASS`)
}
