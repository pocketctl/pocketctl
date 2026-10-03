import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

export const defaultPreferences = { locale: 'zh', theme: 'system', notifications: { browser: false, completed: true, errors: true, daemon: true, updates: false } }
export function validatePreferencePatch(body: unknown): { expected_revision: number; preferences: Record<string,unknown> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON object required')
  const value=body as Record<string,any>
  if (Object.keys(value).some(key=>!['expected_revision','preferences'].includes(key)) || !Number.isSafeInteger(value.expected_revision) || value.expected_revision<1) throw new Error('positive expected_revision required')
  const patch=value.preferences
  if (!patch || typeof patch!=='object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key=>!['locale','theme','notifications'].includes(key))) throw new Error('invalid preferences')
  if (patch.locale!==undefined && !['zh','en'].includes(patch.locale)) throw new Error('invalid locale')
  if (patch.theme!==undefined && !['system','light','dark'].includes(patch.theme)) throw new Error('invalid theme')
  if (patch.notifications!==undefined && (!patch.notifications || typeof patch.notifications!=='object' || Array.isArray(patch.notifications) || Object.entries(patch.notifications).some(([key,value])=>!Object.keys(defaultPreferences.notifications).includes(key)||typeof value!=='boolean'))) throw new Error('invalid notifications')
  return value as ReturnType<typeof validatePreferencePatch>
}
export async function initPreferenceSchema(db: Pick<pg.Pool,'query'>) {
  await db.query(`CREATE TABLE IF NOT EXISTS user_preferences(user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, preferences JSONB NOT NULL DEFAULT '{}'::jsonb, revision BIGINT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
}
export function registerPreferenceRoutes(app: FastifyInstance, deps: { pool:pg.Pool; verifyAccessToken(token:string):Promise<{userId:number}|null>; ready():boolean }) {
  const view=(row:any)=>({preferences:{...defaultPreferences,...row?.preferences,notifications:{...defaultPreferences.notifications,...row?.preferences?.notifications}},revision:Number(row?.revision??1),configured:!!row})
  for (const method of ['GET','PATCH'] as const) app.route({method,url:'/api/user/preferences',handler:async(req,reply)=>{
    const header=req.headers.authorization,actor=header?.startsWith('Bearer ')?await deps.verifyAccessToken(header.slice(7)):null
    if(!actor)return reply.code(401).send({error:'authorization_required'})
    if(!deps.ready())return reply.code(503).send({error:'database_unavailable'})
    if(method==='GET')return view((await deps.pool.query('SELECT preferences,revision FROM user_preferences WHERE user_id=$1',[actor.userId])).rows[0])
    let patch:ReturnType<typeof validatePreferencePatch>
    try{patch=validatePreferencePatch(req.body)}catch(error){return reply.code(400).send({error:'invalid_preferences',message:(error as Error).message})}
    const client=await deps.pool.connect()
    try{
      await client.query('BEGIN')
      await client.query('INSERT INTO user_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',[actor.userId])
      const row=(await client.query('SELECT preferences,revision FROM user_preferences WHERE user_id=$1 FOR UPDATE',[actor.userId])).rows[0]
      if(Number(row.revision)!==patch.expected_revision){await client.query('ROLLBACK');return reply.code(409).send({error:'revision_conflict',...view(row)})}
      const current=view(row).preferences,next={...current,...patch.preferences,notifications:{...current.notifications,...patch.preferences.notifications as object}}
      const updated=(await client.query('UPDATE user_preferences SET preferences=$2::jsonb,revision=revision+1,updated_at=NOW() WHERE user_id=$1 RETURNING preferences,revision',[actor.userId,JSON.stringify(next)])).rows[0]
      await client.query('COMMIT');return view(updated)
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }})
}
