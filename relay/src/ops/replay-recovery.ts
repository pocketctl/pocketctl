import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { canonicalPayloadHash, canonicalSourceClassification } from '@pocketctl/session-source'
import { assertDaemonSessionAccess, lockSessionMaterializationFence, nativeSessionFenceSet } from '../db.js'
import { inheritPostgresHistoryBodyReader } from '../session-history/postgres-reader.js'
import { loadReplayCanonical } from '../materialization/replay-compatibility.js'
import { safeMaterializationError } from '../inbox-worker.js'

type DB = Pick<pg.Pool, 'query'>
export interface RecoveryScope { daemonId: string; ownerId: number; generation: string }
export interface RecoveryEntry {
  inboxId: string; eventId: string; fingerprint: string; canonicalHash: string; canonicalFingerprint: string;
  original: Record<string, unknown>
}
export interface RecoveryManifest {
  version: 1; policy: 'canonical-replay-v1'; createdAt: string;
  target: { database: string; address: string; port: number };
  scope: RecoveryScope; entries: RecoveryEntry[];
  excluded: { inboxId: string; reason: string }[]; digest: string
}
/** Installed explicitly by an operator, never by dry-run. Contains no bodies. */
export const REPLAY_RECOVERY_AUDIT_SQL = `CREATE TABLE IF NOT EXISTS public.relay_replay_recovery_audit (
  manifest_digest TEXT NOT NULL, inbox_id BIGINT NOT NULL, event_id BIGINT NOT NULL,
  fingerprint TEXT NOT NULL, original JSONB NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  applied_by TEXT NOT NULL DEFAULT current_user, PRIMARY KEY(manifest_digest,inbox_id))`
const hash = (value: unknown) => canonicalPayloadHash(value).toString('hex')
const idPattern = /^[1-9][0-9]{0,15}$/
function validateScope(scope: RecoveryScope, ids: string[]) {
  if (!scope || typeof scope.daemonId !== 'string' || !scope.daemonId || scope.daemonId.length > 64
    || !Number.isSafeInteger(scope.ownerId) || scope.ownerId < 1 || !idPattern.test(scope.generation)
    || !Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !idPattern.test(id) || !Number.isSafeInteger(Number(id)))) throw Error('invalid_recovery_scope')
}
async function target(db: DB): Promise<RecoveryManifest['target']> {
  return (await db.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port`)).rows[0]
}
async function candidate(db: DB, scope: RecoveryScope, id: string, lock: boolean): Promise<RecoveryEntry> {
  const row = (await db.query(`SELECT to_jsonb(i) AS snapshot FROM event_inbox i WHERE inbox_id=$1 ${lock?'FOR UPDATE':''}`, [id])).rows[0]?.snapshot
  if (!row || !Number.isSafeInteger(row.inbox_id) || !Number.isSafeInteger(row.seq) || !Number.isSafeInteger(row.daemon_generation) || row.daemon_id !== scope.daemonId || row.user_id !== scope.ownerId || String(row.daemon_generation) !== scope.generation
    || row.status !== 3 || !['materialization_failed','canonical_source_header_mismatch'].includes(row.last_error)
    || row.claimed_by !== null || row.claimed_at !== null || row.materialized_event_id !== null) throw Error('ineligible_dead_letter')
  if(row.payload?.resync !== true)throw Error('replay_marker_required')
  const stableId = row.payload?.event_id, requestId = row.payload?.request_id
  if (!row.session_id || !(typeof stableId === 'string' && stableId || typeof requestId === 'string' && requestId)) throw Error('stable_identity_required')
  // Recovery deliberately excludes alias rerouting; it needs a separately
  // reviewed manifest. Runtime materialization still follows native authority.
  if ((await db.query('SELECT 1 FROM session_aliases WHERE old_session_id=$1',[row.session_id])).rowCount) throw Error('alias_requires_review')
  await assertDaemonSessionAccess(db as pg.Pool,{sessionId:row.session_id,daemonId:scope.daemonId,userId:scope.ownerId,policy:'must_exist'})
  const eventHash = createHash('md5').update(`${row.session_id}:${row.event_type}:${stableId?'event:'+stableId:'request:'+requestId}`).digest('hex').slice(0,16)
  const event = (await db.query(`SELECT e.id::text,e.effect_status,e.source_header_version,e.source_sequence::text,e.source_classification
    FROM events e WHERE e.session_id=$1 AND e.event_hash=$2`,[row.session_id,eventHash])).rows[0]
  if (!event || !['completed','none'].includes(event.effect_status)) throw Error('completed_canonical_required')
  const payload = await loadReplayCanonical(db,Number(event.id),scope.ownerId,row.session_id,row.event_type,lock,row.payload)
  if (event.source_header_version != null && !isDeepStrictEqual(event.source_classification,
    canonicalSourceClassification({source_kind:'canonical_event',session_id:row.session_id,source_seq:event.source_sequence,payload}))) throw Error('canonical_source_header_mismatch')
  const journal = (await db.query("SELECT source_seq::text,owner_user_id,session_id,event_type,payload FROM extension_source_outbox WHERE source_kind='canonical_event' AND source_id=$1",['event:'+event.id])).rows[0]
  if (journal && (journal.owner_user_id!==scope.ownerId || journal.session_id!==row.session_id || journal.event_type!==row.event_type
    || !isDeepStrictEqual(journal.payload,payload) || event.source_sequence && event.source_sequence!==journal.source_seq)) throw Error('canonical_source_header_mismatch')
  const {payload: _payload, materialization_context: _context, ...original} = row
  return {inboxId:id,eventId:event.id,fingerprint:hash(row),canonicalHash:hash(payload),canonicalFingerprint:hash(event),original}
}
function manifestDigest(manifest: Omit<RecoveryManifest,'digest'> | RecoveryManifest) {
  const {digest: _digest, ...body} = manifest as RecoveryManifest
  return hash(body)
}
export async function planReplayRecovery(pool: pg.Pool, scope: RecoveryScope, ids: string[]): Promise<RecoveryManifest> {
  validateScope(scope,ids)
  const client=await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='10s'")
    inheritPostgresHistoryBodyReader(pool,client)
    const manifest: RecoveryManifest={version:1,policy:'canonical-replay-v1',createdAt:new Date().toISOString(),target:await target(client),scope,entries:[],excluded:[],digest:''}
    for (const id of ids) {
      // No savepoints/writes: SQL/connection errors abort the whole plan. Only
      // explicitly classified candidate rejections become exclusions.
      try { manifest.entries.push(await candidate(client,scope,id,false)) }
      catch(error) {
        const known=['ineligible_dead_letter','stable_identity_required','alias_requires_review','completed_canonical_required','replay_marker_required','canonical_source_header_mismatch']
        const message=error instanceof Error?error.message:''
        const category=safeMaterializationError(error)
        if (!known.includes(message) && !['replay_payload_conflict','replay_provenance_conflict','replay_canonical_unavailable','unknown_daemon_session','session_ownership_violation'].includes(category)) throw error
        manifest.excluded.push({inboxId:id,reason:known.includes(message)?message:category})
      }
    }
    manifest.entries.sort((a,b)=>Number(a.original.seq)-Number(b.original.seq)||Number(a.inboxId)-Number(b.inboxId))
    manifest.digest=manifestDigest(manifest)
    await client.query('COMMIT')
    return manifest
  } catch(error) { await client.query('ROLLBACK');throw error } finally { client.release() }
}
export async function applyReplayRecovery(pool: pg.Pool, manifest: RecoveryManifest, digest: string, workersPaused: boolean) {
  if (!workersPaused) throw Error('workers_must_be_paused')
  if (!manifest || manifest.version!==1 || manifest.policy!=='canonical-replay-v1' || manifest.digest!==digest || manifestDigest(manifest)!==digest) throw Error('manifest_digest_mismatch')
  validateScope(manifest.scope,manifest.entries.map(e=>e.inboxId))
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'")
    if (!isDeepStrictEqual(await target(client),manifest.target)) throw Error('recovery_target_mismatch')
    // Acquire the same sorted alias fences as materialization before inbox
    // locks. Bound the mutation to <=100 IDs and fail rather than wait.
    const sessions=manifest.entries.map(e=>String(e.original.session_id))
    const fences=await nativeSessionFenceSet(client,sessions)
    for (const session of fences) await lockSessionMaterializationFence(client,session)
    if (!isDeepStrictEqual(fences,await nativeSessionFenceSet(client,sessions))) throw Error('alias_set_changed')
    await client.query('LOCK TABLE event_inbox IN SHARE ROW EXCLUSIVE MODE NOWAIT')
    if ((await client.query('SELECT 1 FROM event_inbox WHERE daemon_id=$1 AND status=1 LIMIT 1',[manifest.scope.daemonId])).rowCount) throw Error('active_claims_present')
    inheritPostgresHistoryBodyReader(pool,client)
    const deadline=Date.now()+10_000
    let applied=0,alreadyApplied=0
    for (const entry of manifest.entries) {
      if(Date.now()>deadline)throw Error('recovery_time_budget_exceeded')
      const receipt=(await client.query('SELECT fingerprint FROM relay_replay_recovery_audit WHERE manifest_digest=$1 AND inbox_id=$2',[digest,entry.inboxId])).rows[0]
      if (receipt) { if(receipt.fingerprint!==entry.fingerprint)throw Error('audit_mismatch');alreadyApplied++;continue }
      const fresh=await candidate(client,manifest.scope,entry.inboxId,true)
      if (!isDeepStrictEqual(fresh,entry)) throw Error('candidate_changed')
      const changed=await client.query(`UPDATE event_inbox SET status=0,attempts=0,available_at=NOW(),last_error=NULL,completed_at=NULL
        WHERE inbox_id=$1 AND status=3 AND attempts=$2 AND last_error=$3 AND claimed_by IS NULL AND claimed_at IS NULL`,
        [entry.inboxId,entry.original.attempts,entry.original.last_error])
      if(changed.rowCount!==1)throw Error('candidate_changed')
      await client.query(`INSERT INTO relay_replay_recovery_audit(manifest_digest,inbox_id,event_id,fingerprint,original) VALUES($1,$2,$3,$4,$5)`,
        [digest,entry.inboxId,entry.eventId,entry.fingerprint,entry.original])
      applied++
    }
    if(Date.now()>deadline)throw Error('recovery_time_budget_exceeded')
    await client.query('COMMIT')
    return {digest,applied,alreadyApplied}
  } catch(error) { await client.query('ROLLBACK');throw error } finally { client.release() }
}
