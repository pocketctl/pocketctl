import type pg from 'pg'
import {createTransactionBoundPool} from '../api/transaction-bound-pool.js'
import {BACKFILL_FAMILIES,migrationTransaction} from '../migrations/governance-v2/backfill.js'
import {reconcileGovernanceChanges} from '../migrations/governance-v2/reconcile.js'
import {validateGovernanceMigration} from '../migrations/governance-v2/validate.js'
import {assertMigrationOpen,retentionTransaction,readRetentionPlan} from './transaction.js'

/** One scope still ranking in the latest two retains the entire multi-scope run. */
const eligibleHistory = `FROM memory_governance_migration_runs m
 WHERE m.details_reclaimed_at IS NULL AND cardinality(m.scope_ids)>0 AND (
   (m.abandoned_at<=statement_timestamp()-INTERVAL '14 days') OR (
    m.sealed_at<=statement_timestamp()-INTERVAL '14 days' AND NOT EXISTS(
     SELECT 1 FROM unnest(m.scope_ids) scope WHERE (SELECT count(*) FROM memory_governance_migration_runs newer
       WHERE newer.migration_kind=m.migration_kind AND scope=ANY(newer.scope_ids) AND newer.sealed_at IS NOT NULL
        AND (newer.sealed_at,newer.run_id)>(m.sealed_at,m.run_id))<2)))
 AND EXISTS(SELECT 1 FROM memory_governance_migration_summaries s WHERE s.run_id=m.run_id)`
const eligibleChanges = `FROM memory_governance_migration_changes d
 WHERE d.occurred_at<=statement_timestamp()-INTERVAL '14 days'
 AND NOT EXISTS(SELECT 1 FROM memory_governance_migration_runs m WHERE m.sealed_at IS NULL AND m.abandoned_at IS NULL
  AND (cardinality(m.scope_ids)=0 OR d.installation_id=ANY(m.scope_ids)) AND d.sequence>m.start_watermark)`

export async function previewMigrationRetention(pool:pg.Pool,limit=20) {
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('invalid_retention_preview_limit')
 return readRetentionPlan(pool,async client=> ({history:(await client.query(`SELECT m.run_id,m.migration_kind,m.scope_ids,m.sealed_at,m.abandoned_at ${eligibleHistory}
   ORDER BY COALESCE(m.sealed_at,m.abandoned_at),m.run_id LIMIT $1`,[limit])).rows,
  changes:(await client.query(`SELECT count(*)::text eligible_rows,COALESCE(sum(pg_column_size(d)),0)::text tuple_bytes ${eligibleChanges}`)).rows[0]}))
}

async function summarize(c:pg.PoolClient,run:any,outcome:'complete'|'abandoned',verification:unknown) {
 const counts=(await c.query(`SELECT action,count(*)::text count FROM memory_governance_migration_actions WHERE run_id=$1 GROUP BY action ORDER BY action`,[run.run_id])).rows
 await c.query(`INSERT INTO memory_governance_migration_summaries
  (run_id,migration_kind,scope_ids,schema_version,environment_fingerprint,started_at,completed_at,outcome,action_counts,verification)
  VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),$7,$8,$9) ON CONFLICT DO NOTHING`,
 [run.run_id,run.migration_kind,run.scope_ids,run.schema_version,run.environment_fingerprint,run.started_at,outcome,JSON.stringify(counts),JSON.stringify(verification)])
}

export async function sealGovernanceMigration(pool:pg.Pool,runId:string) {
 return migrationTransaction(pool,async c=>{
  await assertMigrationOpen(c,runId)
  const run=(await c.query('SELECT * FROM memory_governance_migration_runs WHERE run_id=$1 FOR UPDATE',[runId])).rows[0]
  if(!run.scope_ids.length)throw new Error('migration_scope_missing')
  for(const id of [...run.scope_ids].sort())await c.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))`,[id])
  const active=await c.query(`SELECT installation_id FROM memory_governance_v2_states WHERE installation_id=ANY($1::uuid[])
    AND phase='active' AND writer_floor='identity_v2' AND identity_generation=2 FOR SHARE`,[run.scope_ids])
  if(active.rowCount!==run.scope_ids.length)throw new Error('migration_cutover_required')
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('memory-jobs:claim',0))")
  // NOWAIT prevents blocking production writers while a final proof is made.
  await c.query(`LOCK TABLE ${BACKFILL_FAMILIES.join(',')} IN SHARE ROW EXCLUSIVE MODE NOWAIT`)
  const bound=createTransactionBoundPool(c)
  await reconcileGovernanceChanges(bound,{runId})
  const validation=await validateGovernanceMigration(bound,runId)
  if(validation.violations.length)throw new Error('migration_validation_failed')
  await summarize(c,run,'complete',validation)
  await c.query(`UPDATE memory_governance_migration_runs SET state='complete',sealed_at=clock_timestamp(),completed_at=clock_timestamp() WHERE run_id=$1`,[runId])
  return {runId,sealed:true,validation}
 })
}

/** Failure alone is resumable; abandoning it is an explicit operator action. */
export async function abandonGovernanceMigration(pool:pg.Pool,runId:string) {
 return migrationTransaction(pool,async c=>{
  await assertMigrationOpen(c,runId)
  const run=(await c.query('SELECT * FROM memory_governance_migration_runs WHERE run_id=$1 FOR UPDATE',[runId])).rows[0]
  await summarize(c,run,'abandoned',{reason:'operator_abandoned'})
  await c.query(`UPDATE memory_governance_migration_runs SET state='failed',abandoned_at=clock_timestamp(),completed_at=clock_timestamp() WHERE run_id=$1`,[runId])
  return {runId,abandoned:true}
 })
}

export async function retainMigrationHistory(pool:pg.Pool,batchSize=500) {
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>5000)throw new Error('invalid_retention_batch')
 return retentionTransaction(pool,async c=>{
  const run=(await c.query(`SELECT m.run_id ${eligibleHistory} ORDER BY COALESCE(m.sealed_at,m.abandoned_at),m.run_id LIMIT 1 FOR UPDATE OF m`)).rows[0]
  if(!run)return {actions:0,checkpoints:0,runs:0}
  const actions=(await c.query(`WITH due AS MATERIALIZED(SELECT ctid FROM memory_governance_migration_actions WHERE run_id=$1 LIMIT $2 FOR UPDATE)
    DELETE FROM memory_governance_migration_actions a USING due WHERE a.ctid=due.ctid`,[run.run_id,batchSize])).rowCount??0
  const checkpoints=(await c.query(`WITH due AS MATERIALIZED(SELECT ctid FROM memory_governance_migration_checkpoints WHERE run_id=$1 LIMIT $2 FOR UPDATE)
    DELETE FROM memory_governance_migration_checkpoints a USING due WHERE a.ctid=due.ctid`,[run.run_id,batchSize])).rowCount??0
  let runs=0
  const pending=(await c.query(`SELECT EXISTS(SELECT 1 FROM memory_governance_migration_actions WHERE run_id=$1)
    OR EXISTS(SELECT 1 FROM memory_governance_migration_checkpoints WHERE run_id=$1) pending`,[run.run_id])).rows[0].pending
  if(!pending){
   await c.query(`UPDATE memory_governance_migration_summaries SET details_reclaimed_at=clock_timestamp() WHERE run_id=$1`,[run.run_id])
   runs=(await c.query(`UPDATE memory_governance_migration_runs SET manifest='{}',details_reclaimed_at=clock_timestamp() WHERE run_id=$1`,[run.run_id])).rowCount??0
  }
  return {actions,checkpoints,runs}
 })
}

export async function retainMigrationChanges(pool:pg.Pool,batchSize=500) {
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>5000)throw new Error('invalid_retention_batch')
 return retentionTransaction(pool,async c=>{
  // Drain transactions that allocated sequence numbers but have not committed.
  // Only this tiny log table is locked; source tables are never locked by GC.
  await c.query('LOCK TABLE memory_governance_migration_changes IN SHARE ROW EXCLUSIVE MODE NOWAIT')
  const result=await c.query(`WITH due AS MATERIALIZED(SELECT d.sequence ${eligibleChanges} ORDER BY d.sequence LIMIT $1 FOR UPDATE OF d),
    deleted AS(DELETE FROM memory_governance_migration_changes d USING due WHERE d.sequence=due.sequence RETURNING d.sequence)
    SELECT count(*)::int deleted,COALESCE(max(sequence),0)::text floor FROM deleted`,[batchSize])
  await c.query(`UPDATE memory_retention_control SET change_gc_floor=GREATEST(change_gc_floor,$1::bigint) WHERE singleton`,[result.rows[0].floor])
  return {changes:result.rows[0].deleted as number}
 })
}
