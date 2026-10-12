export function planAssistedWikiDiff(current:readonly {key:string;markdown:string;authority:'generated'|'manual'|'locked'}[],generated:readonly {key:string;markdown:string}[]){
 const before=new Map(current.map(s=>[s.key,s]))
 const results=generated.map(s=>{
  const old=before.get(s.key),protectedSection=old?.authority==='manual'||old?.authority==='locked'
  return {key:s.key,previous:old?.markdown??'',next:protectedSection?old!.markdown:s.markdown,action:protectedSection?'preserve':'review_diff',authority:old?.authority??'generated'}
 })
 for(const old of current)if(!generated.some(g=>g.key===old.key)&&old.authority!=='generated')results.push({key:old.key,previous:old.markdown,next:old.markdown,action:'preserve',authority:old.authority})
 return results
}
export function assistanceState(input:{eligible:boolean;productGateOpen:boolean}):{state:'draft'|'eligible'|'product_gate_closed';toolAuthorization:false}{
 return {state:input.eligible?(input.productGateOpen?'eligible':'product_gate_closed'):'draft',toolAuthorization:false}
}
export function rankAssistedCandidates<T extends {independentSuccesses:number;evidenceQuality:number;id:string}>(items:readonly T[]):T[]{
 return [...items].sort((a,b)=>b.independentSuccesses-a.independentSuccesses||b.evidenceQuality-a.evidenceQuality||a.id.localeCompare(b.id))
}
