import{randomUUID}from'node:crypto'
import type pg from'pg'
/** Copy synthetic historical version/authority facts without a live mutation
 * stamp. This exercises the real import distinction, not disabled triggers. */
export async function copyHistoricalAuthorityFixture(pool:pg.Pool,versionId:string):Promise<string>{
 const copied=randomUUID(),c=await pool.connect()
 try{
  await c.query('BEGIN')
  if((await c.query("SELECT NULLIF(current_setting('pocketctl.candidate_ttl',true),'') IS NULL AS historical")).rows[0]?.historical!==true)throw Error('historical_fixture_requires_no_live_stamp')
  await c.query(`INSERT INTO knowledge_versions SELECT (jsonb_populate_record(NULL::knowledge_versions,
    to_jsonb(v)||jsonb_build_object('version_id',$1::uuid,'version_number',v.version_number+1))).* FROM knowledge_versions v WHERE version_id=$2`,[copied,versionId])
  await c.query(`INSERT INTO memory_authority_records SELECT (jsonb_populate_record(NULL::memory_authority_records,
    to_jsonb(a)||jsonb_build_object('authority_id',$1::uuid,'version_id',$2::uuid,'published_at','2026-01-01T00:00:00Z'))).* FROM memory_authority_records a WHERE version_id=$3`,[randomUUID(),copied,versionId])
  await c.query('COMMIT');return copied
 }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}
