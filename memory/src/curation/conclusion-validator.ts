import {z} from 'zod'
import {resolvePredicate,predicateEvidenceSupported,PREDICATE_CONDITION_KEYS} from '../claims/predicate-registry.js'
export interface ConclusionEvidence {id:string;text:string;role:'user'|'assistant'|'tool'|'summary'|'system';verified?:boolean}
export const conclusionSchema=z.object({
 kind:z.enum(['fact','preference','constraint','decision','method','event']),
 assertion_mode:z.enum(['user_asserted','decided','planned','observed','verified']),
 subject:z.string().trim().min(1).max(200),predicate:z.string().max(120),
 value:z.union([z.string().min(1).max(2000),z.number().finite(),z.boolean()]),
 conditions:z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),z.string().min(1).max(200)).refine(x=>Object.keys(x).length<=16).describe('For travel.transport, the only allowed condition key is context. Copy explicit applicability qualifiers literally under context and cite conditions.context. Do not choose purpose or scope instead. Never infer a qualifier from a scene name. Other predicates retain their existing condition contract.'),
 fact_at:z.iso.datetime().nullable(),valid_until:z.iso.datetime().nullable(),
 statement:z.string().trim().min(1).max(4000).describe('Copy one complete supporting statement verbatim from source.text within the task spans, preserving wording, case and punctuation. Preserve first-person I/my/我 here; the normalized self label belongs only in subject. Never rewrite I prefer as self prefers.'),confirmed:z.boolean(),
 evidence:z.object({subject:z.array(z.string().max(256)).min(1).max(16),predicate:z.array(z.string().max(256)).min(1).max(16),value:z.array(z.string().max(256)).min(1).max(16)}).catchall(z.array(z.string().max(256)).min(1).max(16)),
}).strict()
export type Conclusion=z.infer<typeof conclusionSchema>
function containsLiteral(text:string,value:string):boolean {
 const haystack=text.normalize('NFKC').toLowerCase(),needle=value.normalize('NFKC').toLowerCase()
 for(let start=0;;){const at=haystack.indexOf(needle,start);if(at<0)return false
  const left=haystack[at-1]??'',right=haystack[at+needle.length]??'',numeric=/^[+-]?\d+(?:\.\d+)?$/.test(needle)
  const decimalNeighbor=numeric&&((left==='.'&&/\d/.test(haystack[at-2]??''))||(right==='.'&&/\d/.test(haystack[at+needle.length+1]??'')))
  if(!decimalNeighbor&&(!/[a-z0-9]/.test(needle[0])||!/[a-z0-9_+-]/.test(left))&&(!/[a-z0-9]/.test(needle.at(-1)!)||!/[a-z0-9_+-]/.test(right)))return true
  start=at+1
 }
}

export function validateConclusion(raw:unknown,evidence:readonly ConclusionEvidence[],now=new Date()):{ok:true;conclusion:Conclusion}|{ok:false;reason:string}{
 const parsed=conclusionSchema.safeParse(raw)
 if(!parsed.success)return{ok:false,reason:'conclusion_invalid'}
 const c=parsed.data,predicate=resolvePredicate(c.predicate)
 if(!predicate||predicate.kind!==c.kind)return{ok:false,reason:'predicate_unresolved'}
 const allowedConditionKeys=PREDICATE_CONDITION_KEYS[predicate.id as keyof typeof PREDICATE_CONDITION_KEYS]
 if(allowedConditionKeys&&Object.keys(c.conditions).some(key=>!allowedConditionKeys.includes(key)))return{ok:false,reason:'condition_key_unsupported'}
 if(!c.confirmed)return{ok:false,reason:'not_confirmed'}
 if(c.fact_at&&new Date(c.fact_at)>now&&c.assertion_mode!=='planned')return{ok:false,reason:'future_not_observed'}
 if(c.valid_until&&c.fact_at&&new Date(c.valid_until)<=new Date(c.fact_at))return{ok:false,reason:'invalid_fact_interval'}
 const fields=['subject','predicate','value',...Object.keys(c.conditions).map(key=>`conditions.${key}`),...(c.fact_at?['fact_at']:[]),...(c.valid_until?['valid_until']:[])]
 for(const field of fields){
  const refs=c.evidence[field]
  if(!refs?.length||refs.some(id=>!evidence.some(e=>e.id===id)))return{ok:false,reason:'evidence_unavailable'}
 }
 for(const refs of Object.values(c.evidence))if(refs.some(id=>!evidence.some(e=>e.id===id)))return{ok:false,reason:'evidence_unavailable'}
 const authoritative=(source:ConclusionEvidence)=>['user_asserted','decided','planned'].includes(c.assertion_mode)?source.role==='user':c.assertion_mode==='verified'?source.role==='tool'&&source.verified===true:source.role==='tool'
 if(!c.evidence.predicate.some(id=>{const source=evidence.find(e=>e.id===id)!;return authoritative(source)&&predicateEvidenceSupported(c.predicate,source.text)}))return{ok:false,reason:'predicate_unsupported'}
 const cited=evidence.filter(e=>Object.values(c.evidence).flat().includes(e.id))
 if(c.assertion_mode==='verified'&&!cited.some(e=>e.role==='tool'&&e.verified))return{ok:false,reason:'verification_unavailable'}
 if(['user_asserted','decided','planned'].includes(c.assertion_mode)&&!cited.some(e=>e.role==='user'))return{ok:false,reason:'user_authority_unavailable'}
 if(c.assertion_mode==='observed'&&!cited.some(e=>e.role==='tool'))return{ok:false,reason:'observation_unavailable'}
 const supports=(field:string,value:string)=>c.evidence[field].some(id=>{const source=evidence.find(e=>e.id===id)!;return authoritative(source)&&containsLiteral(source.text,value)})
 if(c.subject==='self'&&!c.evidence.subject.some(id=>{const source=evidence.find(e=>e.id===id)!;return authoritative(source)&&(/\b(?:i|my|me|mine)\b/i.test(source.text)||/我(?!们)/.test(source.text))}))return{ok:false,reason:'subject_unsupported'}
 for(const field of ['fact_at','valid_until'] as const)if(c[field]&&!supports(field,c[field]))return{ok:false,reason:'time_unsupported'}
 if(!supports('value',String(c.value)))return{ok:false,reason:'value_unsupported'}
 if(c.subject!=='self'&&!supports('subject',c.subject))return{ok:false,reason:'subject_unsupported'}
 for(const [key,value]of Object.entries(c.conditions))if(!supports(`conditions.${key}`,value))return{ok:false,reason:'condition_unsupported'}
 // Keep a literal allowed-source conclusion until semantic paraphrase quality
 // has independent acceptance evidence; the statement cannot smuggle extra facts.
 if(!cited.some(e=>authoritative(e)&&e.text.includes(c.statement)))return{ok:false,reason:'statement_unsupported'}
 return{ok:true,conclusion:{...c,predicate:predicate.id}}
}
