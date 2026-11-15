import type {StatisticsMetric,StatisticsRange} from '../../types/platformStatistics'
const DAY=86400000
const parse=(s:string)=>Date.parse(`${s}T00:00:00Z`)
const shift=(s:string,d:number)=>new Date(parse(s)+d*DAY).toISOString().slice(0,10)
export function shanghaiToday(now=new Date()):string{return new Date(now.getTime()+8*3600000).toISOString().slice(0,10)}
export function dateRange(days:1|7|30,now=new Date()):StatisticsRange{const today=shanghaiToday(now);return days===1?{from:today,to:today}:{from:shift(today,-days),to:shift(today,-1)}}
export function validDateRange(r:StatisticsRange,today=shanghaiToday()):boolean{
 const valid=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(parse(s))&&new Date(parse(s)).toISOString().slice(0,10)===s
 return valid(r.from)&&valid(r.to)&&r.from<=r.to&&r.to<=today&&parse(r.to)-parse(r.from)<=89*DAY
}
export function metricValue(m:StatisticsMetric):string{return m.value===null?'—':m.value.toLocaleString()}
export function comparison(current:StatisticsMetric,previous:StatisticsMetric,available:boolean):{key:string;params?:Record<string,string|number>}{
 if(!available||current.status!=='complete'||previous.status!=='complete'||current.value===null||previous.value===null)return {key:'stats.notComparable'}
 if(current.value===previous.value)return {key:'stats.unchanged'}
 if(previous.value===0)return {key:'stats.previousZero'}
 const percent=Math.abs((current.value-previous.value)/previous.value*100).toFixed(1)
 return {key:current.value>previous.value?'stats.increased':'stats.decreased',params:{percent}}
}
export function chartPath(values:(number|null)[],max:number):string{
 let open=false;return values.flatMap((v,i)=>{if(v===null){open=false;return []}const p=`${open?'L':'M'}${42+i*808/Math.max(1,values.length-1)},${220-v/Math.max(1,max)*198}`;open=true;return [p]}).join(' ')
}
