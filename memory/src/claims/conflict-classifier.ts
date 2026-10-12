import {claimIdentityV2,normalizedIdentityStatementV2,type ClaimDuplicateInput} from './identity.js'
import {canonicalBundleJSON} from '../governance/revision-bundle.js'
import {tokenSimilarity} from '../retrieval/query-normalizer.js'

export type ClaimRelation='duplicate'|'related'|'potential_conflict'|'unrelated'
export interface ClaimComparison {relation:ClaimRelation;codes:string[];similarity:number}
export interface ClaimRelationship extends ClaimComparison {claimId:string;versionId?:string}
export interface ClaimRelationships {classifierVersion:'claim-conflict-v1';advisoryOnly:true;classification:'new'|'duplicate'|'related'|'potential_conflict';items:ClaimRelationship[]}

/** Compare PostgreSQL microseconds without rounding through JS Date. Dates
 * supplied by existing callers retain their millisecond precision contract. */
function time(value:Date|string|null):bigint|null {
 if(value===null)return null
 const parsed=new Date(value).getTime()
 if(!Number.isFinite(parsed))throw new Error('invalid fact clock')
 const fraction=typeof value==='string'?value.match(/[T ]\d{2}:\d{2}:\d{2}\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/)?.[1]:undefined
 if(fraction&&fraction.length>6)throw new Error('unsupported fact precision')
 return BigInt(parsed)*1000n+BigInt((fraction??'').padEnd(6,'0').slice(3,6)||'0')
}
const result=(relation:ClaimRelation,codes:string[],similarity:number):ClaimComparison=>({relation,codes,similarity})
const text=(value:string)=>value.replace(/\s+/g,' ').trim().toLowerCase()
const antonyms:Array<[RegExp,RegExp,string]>=[
 [/\benable\b/giu,/\bdisable\b/giu,'enable'],[/\benabled\b/giu,/\bdisabled\b/giu,'enabled'],
 [/\btrue\b/giu,/\bfalse\b/giu,'true'],[/\ballow\b/giu,/\bforbid\b/giu,'allow'],[/\balways\b/giu,/\bnever\b/giu,'always'],
 [/开启/gu,/关闭/gu,'开启'],[/启用/gu,/禁用/gu,'启用'],[/允许/gu,/禁止/gu,'允许'],
]
/** Narrow polarity patterns produce only a review hint. Lexical overlap alone
 * is a topic relation, never entailment, contradiction proof or authority. */
export function classifyClaimStatements(left:string,right:string):ClaimComparison {
 const similarity=tokenSimilarity(left,right),a=text(left),b=text(right)
 for(const [positive,negative,replacement] of antonyms){
  if(a.replace(negative,replacement)===b.replace(negative,replacement)&&a!==b
    &&a.replace(positive,'')!==b.replace(positive,''))return result('potential_conflict',['opposing_polarity'],similarity)
 }
 const numbers=/\b\d+(?:\.\d+)?\b/gu
 if(a!==b&&a.replace(numbers,'#')===b.replace(numbers,'#'))return result('potential_conflict',['different_explicit_values'],similarity)
 const negation=/\b(?:not|never)\s+/giu
 if(a!==b&&a.replace(negation,'')===b.replace(negation,''))return result('potential_conflict',['opposing_negation'],similarity)
 return similarity>=0.25?result('related',['lexical_topic_only'],similarity):result('unrelated',[],similarity)
}
export function classifyClaimConflict(left:ClaimDuplicateInput,right:ClaimDuplicateInput):ClaimComparison {
 const similarity=tokenSimilarity(left.statement,right.statement)
 try{if(left.status!=='verified'||right.status!=='verified'||claimIdentityV2(left).topicKey!==claimIdentityV2(right).topicKey)return result('unrelated',['applicability_not_comparable'],similarity)}
 catch{return result('unrelated',['applicability_not_comparable'],similarity)}
 let a:bigint|null,b:bigint|null,c:bigint|null,d:bigint|null
 try{a=time(left.validFrom);b=time(left.validUntil);c=time(right.validFrom);d=time(right.validUntil)
  if((a!==null&&b!==null&&a>=b)||(c!==null&&d!==null&&c>=d))throw new Error('inverted fact window')}
 catch{return result('potential_conflict',['fact_window_requires_review'],similarity)}
 const sameApplicability=canonicalBundleJSON([left.repositoryId??null,left.snapshotId,left.branch])===canonicalBundleJSON([right.repositoryId??null,right.snapshotId,right.branch])
 if(!sameApplicability)return result('related',['different_applicability_metadata'],similarity)
 const sameText=normalizedIdentityStatementV2(left.statement)===normalizedIdentityStatementV2(right.statement)
 const sameConditions=canonicalBundleJSON(left.structuredContent)===canonicalBundleJSON(right.structuredContent)
 if(sameText&&sameConditions&&a===c&&b===d)return result('duplicate',['exact_duplicate'],similarity)
 if((b!==null&&c!==null&&b<=c)||(d!==null&&a!==null&&d<=a))return result('related',['disjoint_fact_windows'],similarity)
 if(!sameConditions)return result('related',['different_explicit_conditions'],similarity)
 if(sameText)return result('related',['different_fact_windows'],similarity)
 return classifyClaimStatements(left.statement,right.statement)
}
export function compareClaimRelationships(a:ClaimRelationship,b:ClaimRelationship):number {
 const priority:Record<ClaimRelation,number>={duplicate:0,potential_conflict:1,related:2,unrelated:3}
 return priority[a.relation]-priority[b.relation]||a.claimId.localeCompare(b.claimId)
}
export function summarizeClaimRelationships(items:ClaimRelationship[]):ClaimRelationships {
 const visible=items.filter(i=>i.relation!=='unrelated').sort(compareClaimRelationships)
 const classification=visible.some(i=>i.relation==='duplicate')?'duplicate':visible.some(i=>i.relation==='potential_conflict')?'potential_conflict':visible.length?'related':'new'
 // Suggestions are bounded metadata with references, never copied target bodies.
 return{classifierVersion:'claim-conflict-v1',advisoryOnly:true,classification,items:visible.slice(0,8)}
}
