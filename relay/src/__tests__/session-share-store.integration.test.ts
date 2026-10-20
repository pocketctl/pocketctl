import { afterAll, beforeAll, expect, test } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { initSessionShareSchema, postgresShareStore, ShareConflict, ShareLimit } from '../session-share/store.js'
// Dedicated disposable database only. Never point this at a business database.
const connectionString=process.env.SHARE_TEST_DATABASE_URL
const pool=connectionString ? new Pool({connectionString}) : undefined
const store=pool ? postgresShareStore(pool) : undefined
beforeAll(async()=>{
  if(!pool)return
  const info=await pool.query('SELECT current_database() AS name')
  if(info.rows[0].name!=='share_verification')throw new Error('requires disposable share_verification database')
  await pool.query('DROP TABLE IF EXISTS session_share_links,sessions,users CASCADE')
  await pool.query('CREATE TABLE users(id INT PRIMARY KEY); CREATE TABLE sessions(session_id VARCHAR(64) PRIMARY KEY,user_id INT REFERENCES users(id),title TEXT); INSERT INTO users VALUES(7),(8); INSERT INTO sessions VALUES(\'s1\',7,\'First\'),(\'s2\',7,\'Second\'),(\'other\',8,\'Other\')')
  await initSessionShareSchema(pool)
  await initSessionShareSchema(pool)
})
afterAll(async()=>{await pool?.end()})
test.skipIf(!connectionString)('Postgres atomic idempotency, fixed expiry, ownership, quota and deletion cascade',async()=>{
  const request=randomUUID()
  const records=await Promise.all(Array.from({length:8},()=>store!.create(7,'s1',request)))
  expect(new Set(records.map(r=>r.id)).size).toBe(1)
  const first=records[0]
  expect(+first.expires_at-+first.created_at).toBe(900000)
  expect(await store!.get(8,first.id)).toBeNull()
  expect(await store!.revoke(8,first.id)).toBeNull()
  await expect(store!.create(7,'s2',request)).rejects.toBeInstanceOf(ShareConflict)
  await store!.revoke(7,first.id)
  const replay=await store!.create(7,'s1',request)
  expect(replay.id).toBe(first.id);expect(replay.revoked_at).not.toBeNull();expect(+replay.expires_at).toBe(+first.expires_at)
  const fresh=await store!.create(7,'s1',randomUUID())
  expect(fresh.id).not.toBe(first.id)
  await pool!.query("UPDATE session_share_links SET created_at=created_at-interval '2 days',expires_at=expires_at-interval '2 days' WHERE id=$1",[first.id])
  expect((await store!.create(7,'s1',request)).id).toBe(first.id)
  expect((await store!.list(7)).map(r=>r.id)).toEqual([fresh.id])
  await pool!.query("UPDATE sessions SET user_id=8 WHERE session_id='s1'")
  expect(await store!.get(7,fresh.id)).toBeNull();expect(await store!.list(7)).toHaveLength(0)
  await pool!.query("UPDATE sessions SET user_id=7 WHERE session_id='s1'")
  await Promise.all(Array.from({length:99},()=>store!.create(7,'s2',randomUUID())))
  expect(await store!.list(7)).toHaveLength(100)
  await expect(store!.create(7,'s2',randomUUID())).rejects.toBeInstanceOf(ShareLimit)
  await store!.revoke(7,fresh.id)
  await store!.create(7,'s2',randomUUID())
  await pool!.query('DELETE FROM users WHERE id=7').catch(async()=>{
    await pool!.query("DELETE FROM sessions WHERE user_id=7; DELETE FROM users WHERE id=7")
  })
  expect((await pool!.query('SELECT count(*)::int AS n FROM session_share_links')).rows[0].n).toBe(0)
})
