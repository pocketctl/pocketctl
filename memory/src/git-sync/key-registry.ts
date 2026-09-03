import { createPublicKey,type KeyObject } from 'node:crypto'
import type pg from 'pg'
import type { AttestationKeyRegistry } from './attestation.js'
import { gitQueueTransaction } from './inbox-service.js'

type Signer=ReturnType<AttestationKeyRegistry['signingKey']>
type KeyState='active'|'retired'|'revoked'
export interface DatabaseAttestationRegistry {
  kind:'database'
  registerSigner():Promise<void>
  transactionView(client:pg.PoolClient):Promise<AttestationKeyRegistry>
  transition(keyId:string,state:'retired'|'revoked'):Promise<void>
}
export type GitAttestationRegistry=AttestationKeyRegistry|DatabaseAttestationRegistry
/** ALL users acquire this gate before lifecycle, membership, source, connection,
 * snapshot and key-row locks. Revocation takes exclusive first. Task8 invalidation
 * may then take connection locks. No registry transaction spans provider I/O. */
export async function lockGitKeyRegistry(client:pg.PoolClient,exclusive=false) {
  await client.query(`SELECT ${exclusive?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared'}(hashtextextended('memory:git:attestation-keys',0))`)
}
export function canonicalEd25519PublicKey(der:Uint8Array):KeyObject {
  try {const key=createPublicKey({key:Buffer.from(der),format:'der',type:'spki'})
    if(key.asymmetricKeyType!=='ed25519'||der.byteLength!==44||!Buffer.from(der).equals(key.export({format:'der',type:'spki'})))throw new Error()
    return key
  }catch{throw new Error('git_attestation_key_invalid')}
}
export function createDatabaseAttestationRegistry(deps:{pool:pg.Pool;signer?:Signer}):DatabaseAttestationRegistry {
  const signer=deps.signer
  if(signer&&(!/^[A-Za-z0-9._:-]{1,128}$/.test(signer.keyId)||signer.privateKey.type!=='private'||signer.privateKey.asymmetricKeyType!=='ed25519'))throw new Error('git_attestation_key_invalid')
  return {kind:'database',
    async registerSigner(){
      if(!signer)return
      const der=createPublicKey(signer.privateKey).export({format:'der',type:'spki'});canonicalEd25519PublicKey(der)
      await gitQueueTransaction(deps.pool,async client=>{await lockGitKeyRegistry(client,true)
        await client.query(`INSERT INTO memory_git_attestation_keys(key_id,public_key_spki,state) VALUES($1,$2,'active') ON CONFLICT DO NOTHING`,[signer.keyId,der])
        const row=(await client.query('SELECT public_key_spki,state FROM memory_git_attestation_keys WHERE key_id=$1',[signer.keyId])).rows[0]
        if(row.state!=='active'||!der.equals(row.public_key_spki))throw new Error('git_attestation_key_invalid')})
    },
    async transactionView(client){
      await lockGitKeyRegistry(client)
      const rows=(await client.query<{key_id:string;public_key_spki:Buffer;state:KeyState}>('SELECT key_id,public_key_spki,state FROM memory_git_attestation_keys ORDER BY key_id LIMIT 4097')).rows
      if(rows.length>4096)throw new Error('git_attestation_key_limit')
      const keys=new Map(rows.map(row=>[row.key_id,{publicKey:canonicalEd25519PublicKey(row.public_key_spki),state:row.state}]))
      return {signingKey:()=>{if(!signer)throw new Error('git_attestation_key_invalid');return signer},verificationKey:id=>keys.get(id)??null}
    },
    async transition(keyId,state){
      if(!['retired','revoked'].includes(state))throw new Error('git_attestation_key_invalid')
      await gitQueueTransaction(deps.pool,async client=>{await lockGitKeyRegistry(client,true)
        const result=await client.query('UPDATE memory_git_attestation_keys SET state=$2 WHERE key_id=$1 RETURNING key_id',[keyId,state])
        if(!result.rowCount)throw new Error('git_attestation_key_invalid')
        if(state==='revoked')await client.query(`SELECT pg_notify('memory_git_cancel',connection_id::text) FROM memory_git_snapshot_keys WHERE key_id=$1 GROUP BY connection_id`,[keyId])})
    }}
}
export function isDatabaseRegistry(keys:GitAttestationRegistry):keys is DatabaseAttestationRegistry{return 'kind' in keys&&keys.kind==='database'}
export async function assertSnapshotKey(client:pg.PoolClient,bundle:{installationId:string;connectionId:string;exportId:string;attestation:Uint8Array}) {
  const keyId=(JSON.parse(Buffer.from(bundle.attestation).toString()) as {descriptor:{keyId:string}}).descriptor.keyId
  const row=await client.query(`SELECT 1 FROM memory_git_snapshot_keys WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3 AND key_id=$4`,[bundle.installationId,bundle.connectionId,bundle.exportId,keyId])
  if(!row.rowCount)throw new Error('git_export_unbound')
}
