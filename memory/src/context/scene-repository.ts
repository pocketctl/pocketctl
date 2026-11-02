import type pg from 'pg'
import {z} from 'zod'
import {requireCurrentScopePermission,TargetBindingError,assertCurrentGrantClock,type ValidatedV2Grant} from '../governance/authorization.js'
import {selectScene,type SceneDomain,type SceneDestination,type SceneSpace} from './scene-resolver.js'
const createSchema=z.object({name:z.string().trim().min(1).max(200),domain:z.enum(['personal_project','work','life','profile']),destinations:z.array(z.enum(['personal','work','shared'])).min(1).max(3)}).strict()
/** Scoped management/read primitive. A scene never creates a grant binding. */
export function createSceneRepository(pool:pg.Pool){
 async function tx<T>(fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
  const c=await pool.connect()
  try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }
 async function authorize(c:pg.PoolClient,grant:ValidatedV2Grant,installationId:string,permission:'read'|'scope_admin'){
  const binding=await requireCurrentScopePermission({client:c,grant,targetInstallationId:installationId,permission})
  // Scene revisions become cache authority, including for personal scopes.
  const owner=(await c.query<{state:string;epoch:string}>('SELECT state,authorization_epoch::text AS epoch FROM memory_owner_scopes WHERE installation_id=$1 FOR SHARE',[installationId])).rows[0]
  if(!owner||owner.state!=='active'||owner.epoch!==binding.authorization_epoch)throw new TargetBindingError('scene authority is stale')
 }
 return {
  async create(input:{grant:ValidatedV2Grant;installationId:string;name:string;domain:SceneDomain;destinations:SceneDestination[]}){
   const value=createSchema.parse({name:input.name,domain:input.domain,destinations:input.destinations})
   return tx(async c=>{
    await authorize(c,input.grant,input.installationId,'scope_admin')
    const row=(await c.query<{space_id:string}>(`INSERT INTO memory_spaces(installation_id,name,domain,destinations) VALUES($1,$2,$3,$4) RETURNING space_id::text`,[input.installationId,value.name,value.domain,[...new Set(value.destinations)]])).rows[0]
    await assertCurrentGrantClock(c,input.grant,[input.installationId])
    return {spaceId:row.space_id}
   })
  },
  async resolve(input:{grant:ValidatedV2Grant;installationId:string;destination:SceneDestination;explicitSpaceId?:string|null;repositoryKey?:string|null}){
   return tx(async c=>{
    await authorize(c,input.grant,input.installationId,'read')
    const rows=await c.query<{space_id:string;domain:SceneDomain;destinations:SceneDestination[];repository_keys:string[]}>(`SELECT s.space_id::text,s.domain,s.destinations,
      ARRAY(SELECT r.repository_key FROM memory_space_bindings b JOIN repositories r USING(installation_id,repository_id)
       WHERE b.installation_id=s.installation_id AND b.space_id=s.space_id ORDER BY r.repository_key) AS repository_keys
      FROM memory_spaces s WHERE s.installation_id=$1 AND s.state='active' ORDER BY s.space_id FOR SHARE OF s`,[input.installationId])
    const spaces:SceneSpace[]=rows.rows.map(r=>({spaceId:r.space_id,domain:r.domain,destinations:r.destinations,repositoryKeys:r.repository_keys}))
    await assertCurrentGrantClock(c,input.grant,[input.installationId])
    return selectScene({...input,spaces})
   })
  },
 }
}
