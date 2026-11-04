import type {Conclusion} from './conclusion-validator.js'
import type {CurationAction} from './contracts.js'
export interface RelationTarget {conclusion:Conclusion;protection:string;bodyState:string;storageTier:string;state:string}
export interface RelationDecision {action:CurationAction;reason:string;differences:string[]}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
const conditionKey=(c:Conclusion)=>JSON.stringify(Object.entries(c.conditions).sort(([a],[b])=>a.localeCompare(b)))
/** Exact structured semantics are a conservative comparator. Similar prose or
 * vectors never authorizes identity merging. No provider calls or I/O. */
export function evaluateRelation(next:Conclusion,prior:RelationTarget|null,matchedLogicalIdentity=false):RelationDecision{
 const result=(action:CurationAction,reason:string,differences:string[]=[]):RelationDecision=>({action,reason,differences})
 if(!prior)return result('create','new_logical_identity')
 const old=prior.conclusion
 if(prior.bodyState!=='present'||prior.state!=='active')return result('skip','target_unavailable')
 if(!matchedLogicalIdentity&&(next.predicate!==old.predicate||next.subject.normalize('NFKC').trim().toLowerCase()!==old.subject.normalize('NFKC').trim().toLowerCase()||conditionKey(next)!==conditionKey(old)))return result('create_variant','independent_conditions',['identity'])
 if(!matchedLogicalIdentity&&next.assertion_mode==='planned'&&old.assertion_mode!=='planned')return result('create_variant','plan_not_current_fact',['assertion_mode'])
 if(['pinned','critical','user_corrected'].includes(prior.protection)&&!same(next.value,old.value))return result('defer','protected_target',['value'])
 if(same(next.value,old.value))return result(next.statement===old.statement?'link_evidence':'merge','equivalent_value_independent_evidence')
 const nextAt=next.fact_at?Date.parse(next.fact_at):null,oldAt=old.fact_at?Date.parse(old.fact_at):null
 if(nextAt===null&&oldAt!==null)return result('defer','fact_time_unknown',['fact_at'])
 if(nextAt!==null&&oldAt!==null&&nextAt<oldAt)return result('defer','late_historical_fact',['value','fact_at'])
 if(nextAt!==null&&oldAt!==null&&nextAt===oldAt)return result('defer','same_condition_conflict',['value'])
 if(next.assertion_mode==='planned'&&old.assertion_mode==='planned')return result('replace','updated_plan',['value'])
 if(next.assertion_mode==='user_asserted'||next.assertion_mode==='decided'||next.assertion_mode==='verified')return result('replace','confirmed_change',['value'])
 return result('defer','insufficient_change_evidence',['value'])
}
