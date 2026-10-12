/** Internal recall is independent of REST pagination and remains bounded. */
export const INTERNAL_POOL_BUDGET=200
export function recallPoolBudget(requested=INTERNAL_POOL_BUDGET):number{
 if(!Number.isFinite(requested)||requested<1)throw new Error('invalid_recall_pool_budget')
 return Math.min(INTERNAL_POOL_BUDGET,Math.floor(requested))
}

/** Deterministic MMR over already authorized/admitted candidates. Similarity
 * uses bounded text tokens, no model call and no change to scope ownership.
 */
export function diversifyRecall<T>(items:readonly T[],options:{score:(item:T)=>number;text:(item:T)=>string;id:(item:T)=>string;penalty?:number;limit?:number}):T[]{
 const remaining=[...items],selected:T[]=[],penalty=options.penalty??.1
 const tokens=(item:T)=>new Set(options.text(item).toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.slice(0,256)??[])
 const sets=new Map(items.map(item=>[item,tokens(item)]))
 const overlap=(a:T,b:T)=>{
  const x=sets.get(a)!,y=sets.get(b)!,intersection=[...x].filter(token=>y.has(token)).length
  return intersection/Math.max(1,x.size+y.size-intersection)
 }
 const similarity=new Map<T,number>(items.map(item=>[item,0]))
 const limit=Math.min(items.length,Math.max(1,options.limit??50))
 while(remaining.length&&selected.length<limit){
  const score=(item:T)=>options.score(item)-penalty*(similarity.get(item)??0)
  remaining.sort((a,b)=>score(b)-score(a)||options.id(a).localeCompare(options.id(b)))
  const best=remaining.shift()!;selected.push(best)
  for(const other of remaining)similarity.set(other,Math.max(similarity.get(other)??0,overlap(best,other)))
 }
 return [...selected,...remaining]
}
