/** Independent clusters, never repeated model calls, form quality denominators. */
export function wilsonInterval(success:number,total:number){
 if(!Number.isInteger(success)||!Number.isInteger(total)||success<0||total<success)throw new Error('invalid_counts')
 if(!total)return {lower:0,upper:1}
 const z=1.959963984540054,p=success/total,d=1+z*z/total,c=(p+z*z/(2*total))/d,w=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d
 return {lower:c-w,upper:c+w}
}
const gates={precision:{minimum:200,threshold:.98,lower:.95},recall:{minimum:200,threshold:.8},routing:{minimum:200,threshold:.98},coverage:{minimum:200,threshold:.9},updates:{minimum:100,threshold:.95},false_merge:{minimum:200,threshold:1},protected:{minimum:100,threshold:1},retention:{minimum:200,threshold:.98},permissions:{minimum:1,threshold:1},compression:{minimum:1,threshold:1},stale_overwrite:{minimum:1,threshold:1}} as const
export type LifecycleMetric=keyof typeof gates
export interface LifecycleObservation {id:string;cluster:string;metric:LifecycleMetric;success:boolean;run:number}
export function evaluateLifecycleQuality(observations:LifecycleObservation[]){
 const metrics={} as Record<LifecycleMetric,{denominator:number;successes:number;rate:number|null;interval:{lower:number;upper:number};status:'pass'|'fail'|'insufficient'}>
 for(const [name,gate] of Object.entries(gates)){
  const metric=name as LifecycleMetric,rows=observations.filter(r=>r.metric===metric),clusters=new Map<string,boolean>()
  for(const row of rows){if(!row.id||!row.cluster||typeof row.success!=='boolean'||!Number.isInteger(row.run)||row.run<1)throw new Error('invalid_observation');clusters.set(row.cluster,(clusters.get(row.cluster)??true)&&row.success)}
  const total=clusters.size,success=[...clusters.values()].filter(Boolean).length,interval=wilsonInterval(success,total)
  const failedBoundary=gate.threshold===1&&rows.some(r=>!r.success)
  const runDenominators=[...new Set(rows.map(r=>r.run))].map(run=>new Set(rows.filter(r=>r.run===run).map(r=>r.cluster)).size)
  const status=failedBoundary?'fail':total<gate.minimum||runDenominators.length<3||runDenominators.some(n=>n<gate.minimum)?'insufficient':success/total<gate.threshold||('lower'in gate&&interval.lower<gate.lower)?'fail':'pass'
  metrics[metric]={denominator:total,successes:success,rate:total?success/total:null,interval,status}
 }
 const runs=[...new Set(observations.map(r=>r.run))].sort(),states=Object.values(metrics).map(m=>m.status)
 return {status:states.includes('fail')?'fail':states.includes('insufficient')||runs.length<3?'insufficient':'pass',metrics,runs,clustering:'worst_outcome_per_independent_cluster',required_runs:3}
}
