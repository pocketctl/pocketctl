import {createHash} from 'node:crypto'
import type {ScopeKind} from './types.js'
import {canonicalBundleJSON} from '../governance/revision-bundle.js'
import {confirmedCanonicalRepositoryKey} from '../governance/applicability.js'
export interface ClaimIdentityV2Input {
 claimType:string;scopeKind:ScopeKind;scopeKey:string;canonicalRepositoryKey:string|null
 snapshotId:string|null;branch:string|null;statement:string;status:'verified'|'legacy_unknown'|'requires_review'
}
export class ClaimIdentityUnavailableError extends Error {
 readonly code='identity_requires_review'
 constructor(){super('confirmed claim identity required')}
}
/** Conservative exact normalization: preserve identifier case, punctuation and quoted whitespace. */
export function normalizedIdentityStatementV2(statement:string):string {
 return statement.replace(/\r\n?/g,'\n').trim()
}
export function claimIdentityV2(input:ClaimIdentityV2Input):{key:string;topicKey:string;generation:2}{
 if(input.status!=='verified'||!input.claimType.trim()||!input.statement.trim()
  ||!['installation','repository','snapshot','branch','task'].includes(input.scopeKind)
  ||(['repository','snapshot','branch'].includes(input.scopeKind)&&!confirmedCanonicalRepositoryKey(input.canonicalRepositoryKey))
  ||(input.scopeKind==='snapshot'&&!input.snapshotId)||(input.scopeKind==='branch'&&!input.branch)
  ||(input.scopeKind==='task'&&!input.scopeKey))throw new ClaimIdentityUnavailableError()
 const qualifiers=[2,input.claimType,input.scopeKind,input.scopeKind==='installation'?null:input.canonicalRepositoryKey,
  input.scopeKey,input.scopeKind==='snapshot'?input.snapshotId:null,input.scopeKind==='branch'?input.branch:null]
 const hash=(value:unknown)=>createHash('sha256').update(canonicalBundleJSON(value)).digest('hex')
 return{generation:2,topicKey:hash(qualifiers),key:hash([...qualifiers,normalizedIdentityStatementV2(input.statement)])}
}
export interface ClaimDuplicateInput extends ClaimIdentityV2Input {
 repositoryId?:string|null
 structuredContent:Record<string,unknown>;validFrom:Date|string|null;validUntil:Date|string|null
}
export function claimDuplicateDigestV2(input:ClaimDuplicateInput):string {
 const time=(value:Date|string|null)=>value===null?null:new Date(value).toISOString()
 return createHash('sha256').update(canonicalBundleJSON({identity:claimIdentityV2(input).key,
  structuredContent:input.structuredContent,applicability:{scopeKind:input.scopeKind,scopeKey:input.scopeKey,
   canonicalRepositoryKey:input.canonicalRepositoryKey,repositoryId:input.repositoryId??null,snapshotId:input.snapshotId,branch:input.branch,status:input.status},
  validFrom:time(input.validFrom),validUntil:time(input.validUntil)})).digest('hex')
}
export function identityTombstoneDomainV2(key:string):string {
 if(!/^[a-f0-9]{64}$/.test(key))throw new Error('invalid v2 identity key')
 return 'memory-claim-identity:v2:'+key
}
