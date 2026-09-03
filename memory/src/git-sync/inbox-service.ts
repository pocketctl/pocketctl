import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import type { V2GrantFacts } from '../governance/authorization.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import { requireGitPermission,requireCurrentGitAuthorization,type GitAuthorizationStamp } from './authorization.js'
import { lockGitConnection,type GitConnection } from './repository.js'
import type { GitSyncConfig,GitSyncMode } from './config.js'

export type GitOutcomeKind='fixture'|'shadow'|'consented_mpc'|'natural'
export interface GitQueueDeps {pool:pg.Pool;config:GitSyncConfig;scopeMode(connection:GitConnection):Promise<GitSyncMode>
  /** Server-owned experiment classification, never inferred from enabled mode. */
  outcomeKind?:GitOutcomeKind}
export const GitQueueSubject=z.object({installationId:z.uuid(),connectionId:z.uuid(),exportId:z.uuid(),expectedGeneration:z.string().regex(/^[1-9][0-9]{0,18}$/)}).strict()
export type GitQueueSubject=z.infer<typeof GitQueueSubject>
const Trigger=z.object({source:z.enum(['webhook','poll','preview','export']),eventId:z.string().min(1).max(256),changeNumber:z.string().regex(/^[1-9][0-9]{0,14}$/)}).strict()
export type GitTrigger=z.infer<typeof Trigger>
const Facts=z.object({primaryInstallationId:z.uuid(),configVersion:z.string(),scopeBindings:z.array(z.object({
  installation_id:z.uuid(),owner_scope_kind:z.enum(['personal','team','organization']),owner_scope_id:z.string(),membership_id:z.string().nullable(),
  membership_revision:z.string(),authorization_epoch:z.string(),permissions:z.array(z.string()).max(16),
})).max(64)})
const hash=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
export interface GitPrincipal {grant_facts:V2GrantFacts;authorization_stamp:GitAuthorizationStamp;generation:string}
export async function gitAdmissionMode(deps:GitQueueDeps,c:GitConnection):Promise<'shadow'|'enabled'> {
  const modes=[deps.config.mode,c.syncMode,await deps.scopeMode(c)]
  if(c.state!=='active'||modes.includes('off'))throw new Error('git_feature_disabled')
  return modes.includes('shadow')?'shadow':'enabled'
}
export async function gitQueueTransaction<T>(pool:pg.Pool,run:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect()
  try{await client.query('BEGIN');const result=await run(client);await client.query('COMMIT');return result}
  catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}
/** Internal primitive for authenticated inbox and authoritative poll children;
 * caller holds current authorization and connection locks. No public JSON grant. */
export async function insertGitQueuedRun(client:pg.PoolClient,input:{subject:GitQueueSubject;principal:GitPrincipal;mode:'shadow'|'enabled';
  trigger:Omit<GitTrigger,'changeNumber'>&{changeNumber:string|null};maxTaskAgeMs:number;pollKey?:string;outcomeKind?:GitOutcomeKind}) {
  const {subject:s,principal:p,trigger:t}=input,stamp=p.authorization_stamp
  // Poll recovery calls this primitive directly. Exact delivery identity must
  // win even if its previous child has since finished a not-merged observation.
  const payloadHash=hash({source:t.source,changeNumber:t.changeNumber})
  const delivery=(await client.query<{run_id:string;job_id:string|null;payload_hash:string}>(`SELECT run_id,job_id,payload_hash FROM memory_git_inbox
    WHERE installation_id=$1 AND connection_id=$2 AND event_id=$3`,[s.installationId,s.connectionId,t.eventId])).rows[0]
  if(delivery){if(delivery.payload_hash!==payloadHash)throw new Error('git_event_collision')
    return {runId:delivery.run_id,jobId:delivery.job_id,duplicate:true}}
  const admissionHash=hash({exportId:s.exportId,changeNumber:t.changeNumber,operation:t.source==='export'?'export':t.changeNumber?'import':'poll',pollKey:input.pollKey??null})
  const prior=(await client.query<{run_id:string;job_id:string|null;reason_code:string|null;observation:number}>(`SELECT COALESCE(p.canonical_run_id,p.run_id) AS run_id,r.job_id,p.reason_code,p.observation FROM memory_git_run_receipts p
    LEFT JOIN memory_git_runs r ON r.installation_id=p.installation_id AND r.run_id=COALESCE(p.canonical_run_id,p.run_id)
    WHERE p.installation_id=$1 AND p.connection_id=$2 AND p.generation=$3 AND p.admission_hash=$4
    ORDER BY p.observation DESC LIMIT 1`,[s.installationId,s.connectionId,s.expectedGeneration,admissionHash])).rows[0]
  if(prior&&prior.reason_code!=='not_merged')return {runId:prior.run_id,jobId:prior.job_id,duplicate:true}
  const observation=prior?prior.observation+1:0,requestHash=hash({admissionHash,observation})
  const runId=randomUUID(),jobId=randomUUID(),type=t.source==='export'?'git_export':t.changeNumber?'git_ingest':'git_reconcile'
  await client.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
    VALUES($1,$2,$3,$4,79,$5)`,[jobId,s.installationId,type,`git:${runId}`,{runId}])
  await client.query(`INSERT INTO memory_git_runs(run_id,installation_id,connection_id,generation,direction,mode,outcome_kind,state,
    membership_id,membership_revision,authorization_epoch,config_version,request_hash,export_id,job_id,grant_facts,change_number,trigger_source,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'received',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,clock_timestamp()+($18*interval '1 millisecond'))`,
    [runId,s.installationId,s.connectionId,s.expectedGeneration,t.source==='export'?'export':'import',input.mode,input.outcomeKind??'fixture',
      stamp.membershipId,stamp.membershipRevision,stamp.authorizationEpoch,stamp.configVersion,requestHash,s.exportId,jobId,p.grant_facts,t.changeNumber,t.source,input.maxTaskAgeMs])
  await client.query(`INSERT INTO memory_git_run_receipts(installation_id,connection_id,generation,run_id,request_hash,outcome_kind,state,admission_hash,observation)
    VALUES($1,$2,$3,$4,$5,$6,'received',$7,$8)`,[s.installationId,s.connectionId,s.expectedGeneration,runId,requestHash,input.outcomeKind??'fixture',admissionHash,observation])
  await client.query(`INSERT INTO memory_git_inbox(inbox_id,installation_id,connection_id,event_id,payload_hash,run_id,job_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),s.installationId,s.connectionId,t.eventId,payloadHash,runId,jobId])
  return {runId,jobId,duplicate:false}
}
/** Enrollment is a foreground cryptographic-guard boundary. receive/poll are
 * internal verified-trigger entry points; routes must first verify webhook. */
export function createGitInboxService(deps:GitQueueDeps) {
  async function current(client:pg.PoolClient,s:GitQueueSubject) {
    const p=(await client.query<GitPrincipal>(`SELECT grant_facts,authorization_stamp,generation::text FROM memory_git_sync_principals
      WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3`,[s.installationId,s.connectionId,s.exportId])).rows[0]
    if(!p)throw new Error('git_principal_missing')
    await requireCurrentGitAuthorization(client,p.authorization_stamp,'contribute')
    const c=await lockGitConnection(client,s.installationId,s.connectionId,s.expectedGeneration),mode=await gitAdmissionMode(deps,c)
    if(p.generation!==s.expectedGeneration)throw new Error('git_authorization_stale')
    const snapshot=await client.query(`SELECT 1 FROM memory_git_snapshots WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3
      AND generation=$4 AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE`,[s.installationId,s.connectionId,s.exportId,s.expectedGeneration])
    if(!snapshot.rowCount)throw new Error('git_export_unregistered')
    return {p,c,mode}
  }
  return {
    async enroll(grant:V2GrantFacts,raw:unknown) {
      const s=GitQueueSubject.parse(raw),facts=Facts.parse(grant) as V2GrantFacts
      return gitQueueTransaction(deps.pool,async client=>{
        const stamp=await requireGitPermission(client,facts,s.installationId,'contribute'),c=await lockGitConnection(client,s.installationId,s.connectionId,s.expectedGeneration)
        await gitAdmissionMode(deps,c)
        const valid=await client.query(`SELECT 1 FROM memory_git_snapshots WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3
          AND generation=$4 AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE`,[s.installationId,s.connectionId,s.exportId,s.expectedGeneration])
        if(!valid.rowCount)throw new Error('git_export_unregistered')
        await client.query(`INSERT INTO memory_git_sync_principals(installation_id,connection_id,export_id,generation,membership_id,grant_facts,authorization_stamp)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[s.installationId,s.connectionId,s.exportId,s.expectedGeneration,stamp.membershipId,facts,stamp])
      })
    },
    async receive(raw:unknown,event:unknown) {
      const s=GitQueueSubject.parse(raw),trigger=Trigger.parse(event)
      return gitQueueTransaction(deps.pool,async client=>{const {p,mode}=await current(client,s)
        return insertGitQueuedRun(client,{subject:s,principal:p,mode,trigger,maxTaskAgeMs:deps.config.maxTaskAgeMs,outcomeKind:deps.outcomeKind})})
    },
    async poll(raw:unknown) {
      const s=GitQueueSubject.parse(raw)
      return gitQueueTransaction(deps.pool,async client=>{const {p,mode}=await current(client,s)
        const slot=await client.query<{pollKey:string}>(`UPDATE memory_git_connections SET next_poll_at=clock_timestamp()+($3*interval '1 millisecond')
          WHERE installation_id=$1 AND connection_id=$2 AND (next_poll_at IS NULL OR next_poll_at<=clock_timestamp()) RETURNING next_poll_at::text AS "pollKey"`,
          [s.installationId,s.connectionId,deps.config.pollIntervalMs])
        if(!slot.rows[0])throw new Error('git_poll_too_soon')
        const pollKey=slot.rows[0].pollKey
        return insertGitQueuedRun(client,{subject:s,principal:p,mode,trigger:{source:'poll',eventId:`poll:${pollKey}`,changeNumber:null},pollKey,maxTaskAgeMs:deps.config.maxTaskAgeMs,outcomeKind:deps.outcomeKind})})
    },
  }
}
