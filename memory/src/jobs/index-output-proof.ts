import {createHash} from 'node:crypto'
import {buildSearchDocument,type LexicalClaimInput} from '../retrieval/lexical.js'

// An old ready vector can survive a provider or consent change. Resolve an
// isolated paid job only against the exact successful call and current ledger
// document. Historical rows lacking an immutable call identity stay unproven.
export function currentIndexOutput(row:LexicalClaimInput & {document:string;status:string;provider:string|null;model:string|null;dimensions:number|null;fingerprint:string|null},
  mode:string|undefined,consent:string|undefined,requested:unknown){
  if(row.document!==buildSearchDocument(row))return undefined
  if(mode==='off'&&row.status==='disabled'&&requested===undefined)return {lexical:true as const}
  if(row.status!=='ready'||!['shadow','enabled'].includes(mode??'')||!row.provider||!row.model||!row.dimensions||
    !row.fingerprint||row.fingerprint!==consent||row.fingerprint!==requested)return undefined
  return {call:createHash('sha256').update(JSON.stringify([row.provider,row.model,row.dimensions,row.fingerprint,row.document])).digest()}
}
