import type pg from 'pg'
type Db=Pick<pg.PoolClient,'query'>
/** Opt-in technical transport contract; it never changes model consent. */
export interface SessionTransportConsumerPolicy {version:1;revision:string;bodyRequired:boolean;scope:'legacy'|'retired-personal'}
export async function assertSessionTransportConsumerPolicy(db:Db):Promise<void>{
 await db.query('SELECT shared.assert_session_transport_consumer_policy()')
}
/** Caller owns the publication transaction. SQL holds the original current
 * consumer epoch through COMMIT; native control writers fail NOWAIT. */
export async function readSessionTransportConsumerPolicy(db:Db,ownerUserId:number):Promise<SessionTransportConsumerPolicy>{
 const policy=(await db.query('SELECT shared.session_transport_consumer_policy($1::bigint) AS policy',[ownerUserId])).rows[0]?.policy
 if(!policy||policy.version!==1||typeof policy.revision!=='string'||!/^[1-9][0-9]*$/.test(policy.revision)
  ||typeof policy.bodyRequired!=='boolean'||!['legacy','retired-personal'].includes(policy.scope))throw Error('invalid_session_transport_consumer_policy')
 return policy
}
export async function recordSessionTransportBodyOmission(db:Db,ownerUserId:number):Promise<void>{
 await db.query('SELECT shared.record_session_transport_body_gap($1::bigint)',[ownerUserId])
}
