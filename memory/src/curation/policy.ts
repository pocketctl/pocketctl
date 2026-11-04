import type pg from 'pg'
import type {CurationMode} from './contracts.js'
export interface CurationPolicy {mode:CurationMode;revision:number;authorizationEpoch:string;version:string}
/** The installation is the owner boundary. Personal automation never inherits
 * a team publication capability, even when the same user owns both scopes. */
export async function readCurationPolicy(client:Pick<pg.PoolClient,'query'>,installationId:string,globalMode:CurationMode):Promise<CurationPolicy|null>{
 if(globalMode==='off')return null
 const row=(await client.query(`SELECT p.mode,p.revision,p.policy_version,s.authorization_epoch::text
 FROM memory_curation_policies p JOIN memory_owner_scopes s USING(installation_id)
 WHERE p.installation_id=$1 AND s.owner_scope_kind='personal' AND s.state='active' FOR SHARE OF p,s`,[installationId])).rows[0]
 if(!row||row.mode==='off')return null
 return {mode:globalMode==='shadow'?'shadow':row.mode,revision:Number(row.revision),authorizationEpoch:row.authorization_epoch,version:row.policy_version}
}
/** Used inside both legacy reservation/commit transactions. The policy row is
 * locked so migration cannot transfer processing ownership midway through a write. */
export async function assertLegacySourceOwner(client:Pick<pg.PoolClient,'query'>,installationId:string,globalMode:CurationMode='off'):Promise<void>{
 if(globalMode!=='enabled')return
 const row=(await client.query('SELECT mode FROM memory_curation_policies WHERE installation_id=$1 FOR SHARE',[installationId])).rows[0]
 if(row?.mode==='enabled')throw new Error('source_owned_by_lifecycle')
}
