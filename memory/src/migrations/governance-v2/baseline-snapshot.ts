import {createHash} from 'node:crypto'
import {gzipSync,gunzipSync} from 'node:zlib'
import type {MigrationBaseline} from './backfill.js'
export type StoredMigrationBaseline=Omit<MigrationBaseline,'rows'|'owners'>&Partial<Pick<MigrationBaseline,'rows'|'owners'>>&{snapshot?:{encoding:string;payload:string;sha256:string;bytes:number}}
const INLINE_BYTES=1024*1024,MAX_BYTES=512*1024*1024
/** Large JSON object parsing/sorting can exceed the bounded SQL statement
 * budget. Store the exact snapshot as one checksum-bound compressed string;
 * scope and overlap metadata remain readable for existing resume commands.
 * Omit rows/owners so an older validator fails rather than validating empties.
 */
export function encodeMigrationBaseline(b:MigrationBaseline):StoredMigrationBaseline{
 const raw=Buffer.from(JSON.stringify({rows:b.rows,owners:b.owners}))
 if(raw.length<=INLINE_BYTES)return b
 if(raw.length>MAX_BYTES)throw new Error('migration_snapshot_capacity')
 const {rows,owners,...metadata}=b
 return {...metadata,snapshot:{encoding:'gzip-json-v1',payload:gzipSync(raw).toString('base64'),sha256:createHash('sha256').update(raw).digest('hex'),bytes:raw.length}}
}
export function decodeMigrationBaseline(value:unknown):MigrationBaseline{
 if(!value||typeof value!=='object')throw new Error('migration_snapshot_integrity')
 const v=value as StoredMigrationBaseline
 if(!v.snapshot){if(!v.rows||typeof v.rows!=='object'||Array.isArray(v.rows))throw new Error('migration_snapshot_integrity');return {...v,rows:v.rows,owners:v.owners??{}}}
 if(v.snapshot.encoding!=='gzip-json-v1')throw new Error('migration_snapshot_encoding')
 try{
  const s=v.snapshot;if(!Number.isSafeInteger(s.bytes)||s.bytes<1||s.bytes>MAX_BYTES||typeof s.payload!=='string'||!/^[a-f0-9]{64}$/.test(s.sha256))throw new Error()
  const raw=gunzipSync(Buffer.from(s.payload,'base64'),{maxOutputLength:s.bytes})
  if(raw.length!==s.bytes||createHash('sha256').update(raw).digest('hex')!==s.sha256)throw new Error()
  const body=JSON.parse(raw.toString('utf8'))
  if(!body.rows||typeof body.rows!=='object'||Array.isArray(body.rows)||!body.owners||typeof body.owners!=='object'||Array.isArray(body.owners))throw new Error()
  const {snapshot,rows,owners,...metadata}=v;return {...metadata,rows:body.rows,owners:body.owners}
 }catch{throw new Error('migration_snapshot_integrity')}
}
