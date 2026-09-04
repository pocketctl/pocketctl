import pg from 'pg'
import { createHmac,randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitExportFixture } from '../testing/phase6-export-fixture.js'
import { attestationFixture } from '../testing/phase6-attestation-fixture.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createGitInboxService } from '../git-sync/inbox-service.js'
import { loadGitSyncConfig } from '../git-sync/config.js'
import { verifyGitWebhook } from '../git-sync/provider.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
db('Phase 6 durable Git inbox',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemorySchema(pool)},60_000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations,memory_git_attestation_keys,memory_jobs CASCADE')})
  afterAll(async()=>{await pool?.end()})
  test('accepts all three registered Git jobs in the durable queue',async()=>{
    for(const kind of ['git_ingest','git_export','git_reconcile']) {
      await expect(pool.query(`INSERT INTO memory_jobs(job_id,job_type,idempotency_key,priority,payload)
        VALUES($1,$2,$1::uuid::text,80,'{}')`,[randomUUID(),kind])).resolves.toMatchObject({rowCount:1})
    }
  })
  test('provides additive public key and typed snapshot binding storage',async()=>{
    const rows=await pool.query(`SELECT to_regclass('memory_git_attestation_keys')::text AS keys,
      to_regclass('memory_git_snapshot_keys')::text AS bindings`)
    expect(rows.rows).toEqual([{keys:'memory_git_attestation_keys',bindings:'memory_git_snapshot_keys'}])
  })
  async function setup(mode='shadow') {
    const f=await gitExportFixture(pool),key=attestationFixture()
    const bundle=await createGitExportService({pool,keys:key.registry,skill:{context:f.skill.context,cases:f.skill.cases}}).export(f.grant,
      {installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',baseCommit:'a'.repeat(40),purpose:'external_export',assets:f.keys.filter(k=>k.kind==='rule')})
    const subject={installationId:f.installationId,connectionId:f.connectionId,exportId:bundle.exportId,expectedGeneration:'1'}
    const config=loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:mode})
    const service=createGitInboxService({pool,config,scopeMode:async()=> 'enabled'})
    return {f,key,bundle,subject,service}
  }
  test('commits inbox and job before ACK, deduplicates webhook/poll, survives job retention',async()=>{
    const s=await setup(),extended={...s.f.grant,bearerToken:'MUST-NOT-PERSIST'};await s.service.enroll(extended,s.subject)
    const a=await s.service.receive(s.subject,{source:'webhook',eventId:'delivery-1',changeNumber:'7'})
    expect(a.duplicate).toBe(false)
    expect((await pool.query('SELECT state FROM memory_jobs WHERE job_id=$1',[a.jobId])).rows).toEqual([{state:'pending'}])
    const b=await s.service.receive(s.subject,{source:'poll',eventId:'poll-1',changeNumber:'7'})
    expect(b.runId).toBe(a.runId);expect(b.duplicate).toBe(true)
    await pool.query('DELETE FROM memory_jobs WHERE job_id=$1',[a.jobId])
    expect((await s.service.receive(s.subject,{source:'webhook',eventId:'delivery-2',changeNumber:'7'})).runId).toBe(a.runId)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_runs')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT grant_facts FROM memory_git_sync_principals')).rows[0].grant_facts).toEqual(s.f.grant)
    expect(JSON.stringify((await pool.query('SELECT payload FROM memory_jobs')).rows)).not.toContain('MUST-NOT-PERSIST')
  })
  test('job insertion failure rolls back inbox, run and denominator admission',async()=>{
    const s=await setup();await s.service.enroll(s.f.grant,s.subject)
    await pool.query(`CREATE FUNCTION fail_git_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_job_failure'; END $$`)
    await pool.query(`CREATE TRIGGER fail_git_job BEFORE INSERT ON memory_jobs FOR EACH ROW EXECUTE FUNCTION fail_git_job()`)
    try {await expect(s.service.receive(s.subject,{source:'webhook',eventId:'delivery-1',changeNumber:'7'})).rejects.toThrow('fixture_job_failure')}
    finally {await pool.query('DROP TRIGGER fail_git_job ON memory_jobs; DROP FUNCTION fail_git_job()')}
    for(const table of ['memory_git_inbox','memory_git_runs','memory_git_run_receipts'])expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0)
  })
  test('default off denies admission and revoked enrollment cannot queue work',async()=>{
    const off=await setup('off');await expect(off.service.enroll(off.f.grant,off.subject)).rejects.toThrow('git_feature_disabled')
    const s=await setup();await s.service.enroll(s.f.grant,s.subject)
    await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[s.f.membershipId])
    await expect(s.service.receive(s.subject,{source:'webhook',eventId:'delivery-1',changeNumber:'7'})).rejects.toThrow('git_principal_missing')
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_inbox')).rows[0].n).toBe(0)
  })
  test('persists poll cadence and refuses a second poll within sixty seconds after restart',async()=>{
    const s=await setup();await s.service.enroll(s.f.grant,s.subject)
    expect(await s.service.poll(s.subject)).toMatchObject({duplicate:false})
    await expect(s.service.poll(s.subject)).rejects.toThrow('git_poll_too_soon')
  })
  test('enabled mode alone cannot classify a synthetic admitted run as natural evidence',async()=>{
    const s=await setup('enabled');await s.service.enroll(s.f.grant,s.subject)
    await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId])
    await s.service.receive(s.subject,{source:'webhook',eventId:'enabled-fixture',changeNumber:'7'})
    expect((await pool.query('SELECT mode,outcome_kind FROM memory_git_runs')).rows).toEqual([{mode:'enabled',outcome_kind:'fixture'}])
  })
  test('public keys retire monotonically and typed bindings reject retroactive trust',async()=>{
    const s=await setup(),der=s.key.keys.get('test-1')!.publicKey.export({format:'der',type:'spki'})
    await pool.query("INSERT INTO memory_git_attestation_keys(key_id,public_key_spki,state) VALUES('key-1',$1,'active')",[der])
    await pool.query("UPDATE memory_git_attestation_keys SET state='retired' WHERE key_id='key-1'")
    await expect(pool.query("UPDATE memory_git_attestation_keys SET state='active' WHERE key_id='key-1'")).rejects.toThrow('git_key_immutable')
    await expect(pool.query("UPDATE memory_git_attestation_keys SET public_key_spki='\\x01' WHERE key_id='key-1'")).rejects.toThrow('git_key_immutable')
    await expect(pool.query('INSERT INTO memory_git_snapshot_keys VALUES($1,$2,$3,$4)',[s.f.installationId,s.f.connectionId,s.bundle.exportId,'key-1'])).rejects.toThrow('git_snapshot_immutable')
  })
  test('GitHub validates raw-body HMAC, target and event, forwarding only an untrusted change locator',()=>{
    const raw=Buffer.from(JSON.stringify({repository:{id:123},pull_request:{number:7,merged:true,diff:'FORGED',user:{id:'FAKE'}},url:'https://evil.invalid',action:'closed'}))
    const signature='sha256='+createHmac('sha256','fixture-secret').update(raw).digest('hex')
    const registration={provider:'github' as const,providerRepositoryId:'123',secret:'fixture-secret',eventType:'pull_request'}
    const input={rawBody:raw,signature,eventType:'pull_request',eventId:'delivery-1'}
    expect(verifyGitWebhook(input,registration)).toEqual({source:'webhook',eventId:'delivery-1',changeNumber:'7'})
    expect(()=>verifyGitWebhook({...input,rawBody:Buffer.from(raw.toString().replace('FORGED','TAMPERED'))},registration)).toThrow('webhook_invalid')
    expect(()=>verifyGitWebhook(input,{...registration,providerRepositoryId:'999'})).toThrow('webhook_invalid')
    expect(()=>verifyGitWebhook({...input,eventType:'push'},registration)).toThrow('webhook_invalid')
  })
  test('Gitee timestamp signature never promotes the mutable body to trusted merge or author facts',()=>{
    const timestamp=String(Date.now()),secret='fixture-secret'
    const signature=encodeURIComponent(createHmac('sha256',secret).update(timestamp+'\n'+secret).digest('base64'))
    const registration={provider:'gitee' as const,providerRepositoryId:'123',secret,eventType:'Merge Request Hook'}
    const input={rawBody:Buffer.from(JSON.stringify({repository:{id:123},pull_request:{number:7,merged:true,author:'FAKE'}})),signature,timestamp,eventType:'Merge Request Hook',eventId:'gitee-1'}
    expect(verifyGitWebhook(input,registration)).toEqual({source:'webhook',eventId:'gitee-1',changeNumber:'7'})
    expect(()=>verifyGitWebhook({...input,timestamp:String(Date.now()-3_600_001)},registration)).toThrow('webhook_invalid')
  })
})
