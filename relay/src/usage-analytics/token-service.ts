import type pg from 'pg'
import type {AuthorizedUsageScope,TokenAmounts,UsageRange,Window,CoverageState} from './contracts.js'
import {buckets,granularity,rangeWindow,DAY} from './range.js'
import {readTokenRows,type TokenRow} from './token-repository.js'
export const amountKeys=['input','output','cache_read','cache_create','total','requests'] as const
const components=['input','output','cache_read','cache_create','total'] as const
// Every response reuses the same rows across overview, chart and distributions.
// Cache exact integer parsing without retaining any response/account globally.
const parsed=new WeakMap<TokenRow,{at:number;values:(bigint|null)[];request:bigint|null}>()
function prepare(row:TokenRow){let value=parsed.get(row);if(!value){value={at:Date.parse(row.date),request:row.requests===null?null:BigInt(row.requests),values:components.map(k=>row[k]===null?null:BigInt(row[k]!))};parsed.set(row,value)}return value}
class Accumulator {
 count=0;totals=[0n,0n,0n,0n,0n];known=[true,true,true,true,true];requestKnown=true;allKeys=true;requestTotal=0n;keys=new Set<string>()
 add(row:TokenRow){this.count++;const data=prepare(row);for(let i=0;i<5;i++){const v=data.values[i];if(v===null)this.known[i]=false;else this.totals[i]+=v}
  if(row.requests===null){this.requestKnown=false;this.keys.clear()}else if(this.requestKnown){this.requestTotal+=data.request!;if(!row.request_keys)this.allKeys=false;if(this.allKeys)for(const key of row.request_keys!)this.keys.add(key)}
 }
 result(confirmedZero=false):TokenAmounts {const empty=this.count===0;return {input:empty?(confirmedZero?'0':null):this.known[0]?this.totals[0].toString():null,output:empty?(confirmedZero?'0':null):this.known[1]?this.totals[1].toString():null,cache_read:empty?(confirmedZero?'0':null):this.known[2]?this.totals[2].toString():null,cache_create:empty?(confirmedZero?'0':null):this.known[3]?this.totals[3].toString():null,total:empty?(confirmedZero?'0':null):this.known[4]?this.totals[4].toString():null,requests:empty?(confirmedZero?'0':null):!this.requestKnown?null:this.allKeys?String(this.keys.size):this.requestTotal.toString()}}
}
export function amounts(rows:TokenRow[],confirmedZero=false):TokenAmounts {const total=new Accumulator();for(const row of rows)total.add(row);return total.result(confirmedZero)}
// Strict analysis still propagates missing components. This separate subtotal
// uses only rows where the full split is available, including known zeros.
function tokenComposition(rows:TokenRow[]) {
 let knownRows=0,knownTotal=0n,unknownTotal=0n,input=0n,output=0n,cacheRead=0n,cacheCreate=0n
 for(const row of rows){
  const [i,o,r,c,total]=prepare(row).values
  if(i===null || o===null || r===null || c===null){unknownTotal+=total!;continue}
  input+=i;output+=o;cacheRead+=r;cacheCreate+=c;knownTotal+=total!;knownRows++
 }
 return {input:knownRows?String(input):null,output:knownRows?String(output):null,
  cache_read:knownRows?String(cacheRead):null,cache_create:knownRows?String(cacheCreate):null,
  known_total:rows.length?String(knownTotal):null,unknown_total:rows.length?String(unknownTotal):null}
}
export function rowCoverage(rows:TokenRow[]):CoverageState{return rows.length?'partial':'not_collected'}
export function distribution(rows:TokenRow[],key:'daemon_id'|'agent_type'|'model'){const groups=new Map<string,Accumulator>();for(const row of rows){const id=row[key]||'unknown';let group=groups.get(id);if(!group){group=new Accumulator();groups.set(id,group)}group.add(row)}return [...groups].map(([id,total])=>({id,name:id,...total.result(),coverage:'partial' as CoverageState})).sort((a,b)=>BigInt(a.total??0)>BigInt(b.total??0)?-1:BigInt(a.total??0)<BigInt(b.total??0)?1:a.id.localeCompare(b.id))}
export function series(rows:TokenRow[],range:UsageRange,asOf:Date,w=rangeWindow(range,asOf)){
 let first=Infinity;for(const row of rows)first=Math.min(first,prepare(row).at)
 const display=rows.length?new Date(Math.max(Date.parse(w.from),first)).toISOString():w.from,unit=granularity(range,rows.length?display:null,asOf),periods=buckets(w,unit,display),totals=periods.map(()=>new Accumulator()),edges=periods.map(b=>[Date.parse(b.bucket_start),Date.parse(b.end_exclusive)])
 for(const row of rows){const at=prepare(row).at;let low=0,high=edges.length-1;while(low<=high){const mid=(low+high)>>>1;if(at<edges[mid][0])high=mid-1;else if(at>=edges[mid][1])low=mid+1;else{totals[mid].add(row);break}}}
 return {display_from:display,granularity:unit,series:periods.map((b,i)=>({...b,...totals[i].result(),coverage:totals[i].count?'partial':'not_collected'}))}
}
export function tokenDashboard(rows:TokenRow[],scope:AuthorizedUsageScope,range:UsageRange,asOf:Date){
 const within=(w:Window)=>{const from=Date.parse(w.from),to=Date.parse(w.toExclusive);return rows.filter(r=>{const at=prepare(r).at;return at>=from&&at<to})},selected=within(rangeWindow(range,asOf))
 const heatWindow=rangeWindow('all',asOf);heatWindow.days=90;heatWindow.from=new Date(Date.UTC(asOf.getUTCFullYear(),asOf.getUTCMonth(),asOf.getUTCDate())-89*DAY).toISOString()
 const heatTotals=Array.from({length:90},()=>new Accumulator()),heatFrom=Date.parse(heatWindow.from)
 for(const row of rows){const index=Math.floor((prepare(row).at-heatFrom)/DAY);if(index>=0&&index<90)heatTotals[index].add(row)}
 const heat=heatTotals.map((total,i)=>({date:new Date(heatFrom+i*DAY).toISOString().slice(0,10),...total.result(),coverage:total.count?'partial':'not_collected'})),overview:Record<string,TokenAmounts&{coverage:CoverageState}>={}
 for(const value of ['all','today','7d','30d'] as UsageRange[]){const included=within(rangeWindow(value,asOf));overview[value]={...amounts(included),coverage:rowCoverage(included)}}
 return {hosts:scope.daemons,overview,composition:tokenComposition(selected),analysis:{...amounts(selected),...series(selected,range,asOf),coverage:rowCoverage(selected)},distributions:{host:distribution(selected,'daemon_id'),agent:distribution(selected,'agent_type'),model:distribution(selected,'model')},heatmap:{window_days:90,requested_from:heatWindow.from,to_exclusive:asOf.toISOString(),days:heat,active_days:heat.filter(d=>BigInt(d.total??0)>0n).length,peak:heat.filter(d=>d.total!==null).sort((a,b)=>BigInt(a.total!)>BigInt(b.total!)?-1:1)[0]??null,coverage:rowCoverage(rows)},unattributed_total:amounts(selected.filter(r=>r.attribution_revoked)).total}
}
export async function getPersonalDashboard(db:Pick<pg.Pool,'query'>,scope:AuthorizedUsageScope,range:UsageRange,asOf:Date,history=false){return tokenDashboard(await readTokenRows(db,scope,rangeWindow('all',asOf),{aggregate:true,history}),scope,range,asOf)}
