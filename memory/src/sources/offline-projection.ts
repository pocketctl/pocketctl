import type {SourceVersion} from '@pocketctl/session-source'

export interface FrozenProjectionBatch {
 mode:'active'|'shadow'
 upper:string
 native:string
 firstRevision?:string
 lo?:string|null
 hi?:string|null
 late?:string[]
}
export interface OfflineSeal {
 scanId:string
 controlRevision:string
 batch:FrozenProjectionBatch
 version:SourceVersion
}
interface Interval {lo:bigint;hi:bigint}
export interface OfflineBasis {
 scanId:string
 controlRevision:string
 version:SourceVersion
 input:string
 native:string
 strategy:'baseline'|'incremental'|'shadow'
 segment:number
 after?:string
 covered:boolean
 // Counts refer to full enumeration in shadow mode, before the legacy write.
 scanned:number
 outside:number
}
type Progress = {state?:string;source_version?:any;offline_basis?:OfflineBasis|null}
const inside=(range:Interval,id:bigint)=>range.lo<=id&&id<=range.hi

/** A late ID is its own seek. Merge overlapping or adjacent intervals in
 * numeric order, so it cannot duplicate a turn or rewind the current page. */
function intervals(batch:FrozenProjectionBatch):Interval[]{
 const list=(batch.late??[]).map(key=>({lo:BigInt(key),hi:BigInt(key)}))
 if(batch.lo!=null&&batch.hi!=null)list.push({lo:BigInt(batch.lo),hi:BigInt(batch.hi)})
 list.sort((a,b)=>a.lo<b.lo?-1:a.lo>b.lo?1:0)
 const result:Interval[]=[]
 for(const i of list){
  const last=result.at(-1)
  if(last&&i.lo<=last.hi+1n){if(i.hi>last.hi)last.hi=i.hi}
  else result.push(i)
 }
 return result
}
export function planOfflinePage(seal:OfflineSeal,progress:Progress|undefined){
 const {batch,version}=seal,prior=progress?.offline_basis
 const candidates=intervals(batch)
 const matches=prior?.controlRevision===seal.controlRevision&&prior.native===batch.native
  &&prior.version.authorization===version.authorization&&prior.version.storage===version.storage
 const resume=matches&&prior.scanId===seal.scanId&&!prior.covered&&(progress?.source_version?.offlineScan===seal.scanId
  ||batch.mode==='shadow'&&progress?.source_version?.metadataWave?.phase==='scanning'
   &&progress.source_version.metadataWave.after===prior.after)
 const complete=matches&&prior.covered&&(progress?.state==='ready'&&progress.source_version?.content===prior.version.content
   &&progress.source_version.authorization===prior.version.authorization&&progress.source_version.storage===prior.version.storage
  ||progress?.state==='scanning'&&progress.source_version?.offlineCovered===prior.scanId)
 const contiguous=complete&&batch.firstRevision!==undefined&&BigInt(prior.version.content)>=BigInt(batch.firstRevision)-1n
  &&BigInt(prior.version.content)<BigInt(version.content)&&candidates.length>0
 const strategy=resume?prior.strategy:contiguous?(batch.mode==='shadow'?'shadow':'incremental'):'baseline'
 const ranges=strategy==='incremental'?candidates:[{lo:1n,hi:BigInt(batch.upper)}]
 const segment=resume?prior.segment:0,range=ranges[segment]
 if(!range)throw Error('offline_projection_segment_invalid')
 const basis:OfflineBasis={scanId:seal.scanId,controlRevision:seal.controlRevision,version,native:batch.native,
  input:resume||contiguous?prior.input:'',strategy,segment,covered:false,scanned:resume?prior.scanned:0,outside:resume?prior.outside:0}
 const after=resume&&prior.after?prior.after:(range.lo-1n).toString()
 return {basis,request:{after,through:range.hi.toString(),boundRange:true},last:segment===ranges.length-1,
  contains:(key:string)=>candidates.some(i=>inside(i,BigInt(key)))}
}
