/** Controlled semantic vocabulary. Aliases cannot change cardinality or make
 * two unrelated attributes equivalent. Unknown predicates are deferred. */
export const PREDICATES = Object.freeze({
 'service.timeout':{cardinality:'single',kind:'fact'},
 'service.deployment':{cardinality:'single',kind:'fact'},
 'travel.transport':{cardinality:'single',kind:'preference'},
 'user.preference':{cardinality:'set',kind:'preference'},
 'project.constraint':{cardinality:'set',kind:'constraint'},
 'project.decision':{cardinality:'set',kind:'decision'},
 'project.method':{cardinality:'set',kind:'method'},
 'project.membership':{cardinality:'set',kind:'fact'},
 'incident.occurred':{cardinality:'event',kind:'event'},
} as const)
/** Controlled dimensions for new transport conclusions. Legacy stored keys are
 * not aliases: they remain separate identities until explicitly migrated. */
export const PREDICATE_CONDITION_KEYS:Readonly<Partial<Record<keyof typeof PREDICATES,readonly string[]>>> = Object.freeze({
 'travel.transport':Object.freeze(['context']),
})
const ALIASES:Record<string,keyof typeof PREDICATES>={'request.timeout':'service.timeout','transport.preference':'travel.transport'}
export function resolvePredicate(id:string){const key=ALIASES[id]??id;return Object.hasOwn(PREDICATES,key)?{id:key,...PREDICATES[key as keyof typeof PREDICATES]}:null}

/** Conservative support cues for the controlled vocabulary. This is a
 * necessary grounding check, not a semantic entailment score. Unknown language
 * or an unrelated attribute defers rather than borrowing a matching number. */
export function predicateEvidenceSupported(id:string,text:string):boolean {
 const predicate=resolvePredicate(id);if(!predicate)return false
 const value=text.normalize('NFKC').toLowerCase()
 const rules:Record<keyof typeof PREDICATES,RegExp>={
  'service.timeout':/\btime(?:out|[- ]out)\b|超时/,
  'service.deployment':/\bdeploy(?:ed|ment|ments|ing)?\b|部署|上线|发布/,
  'travel.transport':/\b(?:train|trains|rail|plane|planes|flight|flights|bus|buses|car|cars|bicycle|cycling|walk|walking|transport)\b|火车|高铁|飞机|航班|公交|巴士|地铁|开车|骑行|步行|交通/,
  'user.preference':/\bprefer(?:ence|ences|red|s)?\b|偏好|喜欢/,
  'project.constraint':/\b(?:constraint|constraints|must|required|prohibited|requirement|requirements)\b|约束|必须|禁止|要求/,
  'project.decision':/\b(?:decided|decision|decisions|agreed|chosen|choose)\b|决定|决策|确定采用/,
  'project.method':/\b(?:method|procedure|steps|workflow|how to)\b|流程|方法|步骤/,
  'project.membership':/\b(?:member|members|membership|team)\b|成员|隶属|属于/,
  'incident.occurred':/\b(?:incident|outage|occurred|happened)\b|故障|事件|发生/,
 }
 return rules[predicate.id as keyof typeof PREDICATES].test(value)
}
