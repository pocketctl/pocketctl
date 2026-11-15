import type pg from 'pg'

export const statisticsEnabled = () => process.env.PLATFORM_STATS_ENABLED === 'true'
export const HEARTBEAT_MAX_AGE_MS = 120_000

async function advanceCollector(c:Pick<pg.PoolClient,'query'>,role:'api'|'worker') {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('platform-statistics:collector:'||$1,0))",[role])
  await c.query(`INSERT INTO memory_platform_stats_gaps(metric,gap_from,gap_to)
    SELECT metric,last_seen,clock_timestamp() FROM memory_platform_stats_collectors CROSS JOIN (VALUES('memory'),('usage')) AS m(metric)
    WHERE collector=$1 AND last_seen<clock_timestamp()-interval '45 seconds'`,[role])
  await c.query(`INSERT INTO memory_platform_stats_collectors(collector,coverage_start,last_seen) VALUES($1,clock_timestamp(),clock_timestamp())
    ON CONFLICT(collector) DO UPDATE SET last_seen=clock_timestamp()`,[role])
}

/** Recovery after a failed heartbeat preserves the interval that was unseen. */
export async function recordCollectorHeartbeat(pool:pg.Pool,role:'api'|'worker'):Promise<void>{
  if(!statisticsEnabled())return
  const c=await pool.connect()
  try{await c.query('BEGIN');await advanceCollector(c,role);await c.query('COMMIT')}
  catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}

/** Opt in is explicit in each writer process. Applying this schema never
 * backfills knowledge_claims or asserts that old rows are historical facts. */
export async function initializePlatformStatistics(pool: pg.Pool, options: {role: 'api'|'worker'; internalToken?: string;namespace?:'public'|'memory';verifyOnly?:boolean}): Promise<() => void> {
  if (!statisticsEnabled()) return () => {}
  if(options.role==='api' && Array.from(options.internalToken??process.env.PLATFORM_STATS_INTERNAL_TOKEN??'').length<32)throw new Error('PLATFORM_STATS_INTERNAL_TOKEN must contain at least 32 characters')
  if(options.namespace==='memory'||options.verifyOnly)await verifyPlatformStatisticsSchema(pool)
  else await applyPlatformStatisticsSchema(pool,'public')
  await recordCollectorHeartbeat(pool,options.role)
  let stopped=false
  const timer=setInterval(()=>{if(!stopped)void recordCollectorHeartbeat(pool,options.role).catch(()=>{})},30_000)
  timer.unref()
  return ()=>{stopped=true;clearInterval(timer)}
}

export async function applyPlatformStatisticsSchema(pool:pg.Pool,namespace:'public'|'memory'='public'):Promise<void>{
  if(!['public','memory'].includes(namespace))throw Error('invalid_statistics_namespace')
  const c=await pool.connect()
  try{
    await c.query('BEGIN')
    await c.query(`SET LOCAL search_path=${namespace},pg_catalog`)
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('platform-statistics:schema:v1',0))")
    await c.query(`CREATE TABLE IF NOT EXISTS memory_platform_stats_collectors (
      collector TEXT PRIMARY KEY CHECK(collector IN('api','worker')), coverage_start TIMESTAMPTZ NOT NULL,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`)
    await c.query(`CREATE TABLE IF NOT EXISTS memory_platform_stats_claims (
      installation_id UUID NOT NULL,claim_id UUID NOT NULL,source TEXT NOT NULL CHECK(source IN('manual','automatic','unclassified')),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(installation_id,claim_id))`)
    await c.query(`CREATE INDEX IF NOT EXISTS memory_platform_stats_claims_time ON memory_platform_stats_claims(occurred_at)`)
    await c.query(`CREATE TABLE IF NOT EXISTS memory_platform_stats_usage (
      installation_id UUID NOT NULL,membership_id UUID,request_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('read','write')),
      human_activity BOOLEAN NOT NULL DEFAULT false,occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(installation_id,request_key))`)
    await c.query(`CREATE INDEX IF NOT EXISTS memory_platform_stats_usage_time ON memory_platform_stats_usage(occurred_at)`)
    await c.query(`CREATE TABLE IF NOT EXISTS memory_platform_stats_gaps (
      metric TEXT NOT NULL CHECK(metric IN('memory','usage')),gap_from TIMESTAMPTZ NOT NULL,gap_to TIMESTAMPTZ NOT NULL,CHECK(gap_to>=gap_from))`)
    // Revocation is terminal authority loss, including changes performed by an
    // older discovery process. This trigger stores no identity in the gap.
    await c.query(`CREATE OR REPLACE FUNCTION memory_platform_stats_revoke() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,${namespace} AS $$
      DECLARE earliest timestamptz;
      BEGIN
        IF NEW.local_status IN('purging','purged') OR NEW.relay_status IN('revoking','revoked') THEN
          SELECT min(occurred_at) INTO earliest FROM memory_platform_stats_claims WHERE installation_id=NEW.installation_id;
          IF earliest IS NOT NULL THEN INSERT INTO memory_platform_stats_gaps VALUES('memory',earliest,clock_timestamp()); END IF;
          SELECT min(occurred_at) INTO earliest FROM memory_platform_stats_usage WHERE installation_id=NEW.installation_id;
          IF earliest IS NOT NULL THEN INSERT INTO memory_platform_stats_gaps VALUES('usage',earliest,clock_timestamp()); END IF;
          DELETE FROM memory_platform_stats_claims WHERE installation_id=NEW.installation_id;
          DELETE FROM memory_platform_stats_usage WHERE installation_id=NEW.installation_id;
        END IF;
        RETURN NEW;
      END $$`)
    await c.query('DROP TRIGGER IF EXISTS memory_platform_stats_revoke_trigger ON memory_installations')
    await c.query(`CREATE TRIGGER memory_platform_stats_revoke_trigger BEFORE UPDATE OF local_status,relay_status ON memory_installations
      FOR EACH ROW EXECUTE FUNCTION memory_platform_stats_revoke()`)
    await c.query('COMMIT')
  }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}

export async function verifyPlatformStatisticsSchema(pool:pg.Pool):Promise<void>{
  const result=await pool.query(`SELECT
    to_regclass('memory_platform_stats_collectors') IS NOT NULL
    AND to_regclass('memory_platform_stats_claims') IS NOT NULL
    AND to_regclass('memory_platform_stats_usage') IS NOT NULL
    AND to_regclass('memory_platform_stats_gaps') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('memory_installations')
      AND tgname='memory_platform_stats_revoke_trigger' AND tgenabled IN('O','A')
      AND tgfoid=to_regprocedure('memory_platform_stats_revoke()')) AS ready`)
  if(!result.rows[0]?.ready)throw Error('platform_statistics_migrator_required')
}
