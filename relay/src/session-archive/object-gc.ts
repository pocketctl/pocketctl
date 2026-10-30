import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { ArchiveStorage } from './storage.js'

/** Durable cleanup survives content/manifest/account removal. Namespace and
 * reference checks prevent a different bucket or live body being deleted. */
export class ArchiveObjectCollector {
  constructor(private readonly pool:pg.Pool,private readonly storage:ArchiveStorage){if(!storage.namespace)throw new Error('object collector namespace required')}
  async runOnce(limit=20):Promise<number>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('invalid object cleanup limit')
    // Reap abandoned staged manifests, preserving every authoritative body.
    await this.pool.query(`DELETE FROM session_archive_manifests WHERE manifest_id IN(
      SELECT m.manifest_id FROM session_archive_manifests m WHERE m.state='uploading' AND m.upload_deadline<NOW()
        AND NOT EXISTS(SELECT 1 FROM session_lifecycle_jobs j WHERE j.operation_id=m.operation_id AND j.state='running' AND j.lease_until>NOW())
        AND NOT EXISTS(SELECT 1 FROM events e WHERE e.body_manifest_id=m.manifest_id)
        AND NOT EXISTS(SELECT 1 FROM session_document_versions v WHERE v.body_manifest_id=m.manifest_id)
      ORDER BY m.upload_deadline LIMIT $1 FOR UPDATE SKIP LOCKED)`,[limit])
    let completed=0
    for(let index=0;index<limit;index++){
      const token=randomUUID()
      const claimed=(await this.pool.query(`WITH candidate AS(
        SELECT q.storage_namespace,q.object_key FROM session_archive_object_deletions q
        WHERE q.storage_namespace=$1 AND q.next_attempt_at<=NOW() AND (q.state='pending' OR (q.state='running' AND q.lease_until<=NOW()))
          AND NOT EXISTS(SELECT 1 FROM session_archive_chunks c JOIN session_archive_manifests m USING(manifest_id) WHERE c.object_key=q.object_key
            AND m.storage_namespace=q.storage_namespace AND ((m.state='uploading' AND m.upload_deadline>NOW())
              OR EXISTS(SELECT 1 FROM events e WHERE e.body_manifest_id=c.manifest_id AND e.body_chunk_ordinal=c.ordinal)
              OR EXISTS(SELECT 1 FROM session_document_versions v WHERE v.body_manifest_id=c.manifest_id AND v.body_chunk_ordinal=c.ordinal)))
        ORDER BY q.next_attempt_at,q.created_at FOR UPDATE OF q SKIP LOCKED LIMIT 1)
        UPDATE session_archive_object_deletions q SET state='running',lease_token=$2,lease_until=NOW()+interval '5 minutes',attempt=attempt+1
        FROM candidate c WHERE q.storage_namespace=c.storage_namespace AND q.object_key=c.object_key RETURNING q.*`,[this.storage.namespace,token])).rows[0]
      if(!claimed)break
      try{
        await this.storage.delete(claimed.object_key)
        const done=await this.pool.query(`UPDATE session_archive_object_deletions SET state='deleted',completed_at=NOW(),lease_token=NULL,lease_until=NULL,last_error_code=NULL
          WHERE storage_namespace=$1 AND object_key=$2 AND state='running' AND lease_token=$3 AND lease_until>NOW()`,[this.storage.namespace,claimed.object_key,token])
        completed+=done.rowCount??0
      }catch(error){
        const code=(error as NodeJS.ErrnoException).code
        const errorCode=['EACCES','EPERM','ENOSPC','EROFS'].includes(code??'')?`object_delete_${code!.toLowerCase()}`:'object_delete_failed'
        await this.pool.query(`UPDATE session_archive_object_deletions SET state='pending',lease_token=NULL,lease_until=NULL,next_attempt_at=NOW()+(LEAST(3600,60*power(2,LEAST(attempt-1,6)))::int*interval '1 second'),last_error_code=$4
          WHERE storage_namespace=$1 AND object_key=$2 AND state='running' AND lease_token=$3`,[this.storage.namespace,claimed.object_key,token,errorCode])
      }
    }
    await this.pool.query(`UPDATE session_lifecycle_deletions d SET objects_completed_at=NOW() WHERE objects_completed_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM session_archive_object_deletions q WHERE q.session_id=d.session_id AND q.state<>'deleted')`)
    await this.pool.query(`UPDATE session_lifecycle_deletions d SET extensions_completed_at=NOW() WHERE extensions_completed_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM extension_session_deletions q WHERE q.session_id=d.session_id AND q.status='pending')`)
    return completed
  }
}
