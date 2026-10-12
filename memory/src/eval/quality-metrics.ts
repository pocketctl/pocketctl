import type {GoldenCase} from './schema.js'
export function wilsonInterval(success:number,total:number):{low:number;high:number}|null{
 if(!Number.isInteger(total)||!Number.isInteger(success)||total<0||success<0||success>total)throw new Error('invalid_evaluation_counts')
 if(!total)return null
 const z=1.959963984540054,p=success/total,d=1+z*z/total,center=(p+z*z/(2*total))/d
 const half=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d
 return{low:Math.max(0,center-half),high:Math.min(1,center+half)}
}
/** Correlated tasks, repositories and repeated source bytes form one cluster. */
export function evaluationClusters(cases:readonly GoldenCase[]):number[][]{
 const parent=cases.map((_,i)=>i),find=(i:number):number=>parent[i]===i?i:parent[i]=find(parent[i])
 const seen=new Map<string,number>()
 cases.forEach((item,i)=>{
  const keys=item.lineage?['task:'+item.lineage.source_task_id,'repo:'+item.lineage.repository_group,'digest:'+item.lineage.source_digest]:['legacy:'+item.id]
  for(const key of keys){const prior=seen.get(key);if(prior!==undefined)parent[find(i)]=find(prior);else seen.set(key,i)}
 })
 const groups=new Map<number,number[]>()
 cases.forEach((_,i)=>{const root=find(i);groups.set(root,[...(groups.get(root)??[]),i])})
 return[...groups.values()]
}
