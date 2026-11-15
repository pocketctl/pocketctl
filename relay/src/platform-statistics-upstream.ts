import type {MemoryPeriod,MemoryReader,MemorySnapshot} from './platform-statistics/types.js'
export type {MemorySnapshot as MemoryStatisticsSnapshot} from './platform-statistics/types.js'
const LIMIT=8*1024*1024
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0
const instant=(value:unknown):value is string=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value))
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
function validPeriod(value:unknown):value is MemoryPeriod{
 if(!record(value)||!['memory','automatic','manual','unclassified'].every(key=>count(value[key])))return false
 if(value.memory!==Number(value.automatic)+Number(value.manual)+Number(value.unclassified))return false
 const actor=(row:unknown)=>record(row)&&typeof row.installationId==='string'&&uuid.test(row.installationId)&&count(row.readRequests)&&count(row.writeRequests)&&(row.membershipId===undefined||(typeof row.membershipId==='string'&&uuid.test(row.membershipId)))&&(row.humanActivity===undefined||typeof row.humanActivity==='boolean')
 const day=(row:unknown)=>record(row)&&typeof row.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.date)
 if(!Array.isArray(value.daily)||value.daily.length>91||!value.daily.every(row=>day(row)&&record(row)&&['memory','automatic','manual','unclassified'].every(key=>count(row[key]))))return false
 if(!Array.isArray(value.actors)||value.actors.length>20000||!value.actors.every(actor))return false
 if(!Array.isArray(value.dailyActors)||value.dailyActors.length>20000||!value.dailyActors.every(row=>actor(row)&&day(row)))return false
 return true
}
function validSnapshot(value:unknown):value is MemorySnapshot{
 if(!record(value)||(value.coverageStart!==null&&!instant(value.coverageStart))||!instant(value.dataThrough)||typeof value.actorLimitExceeded!=='boolean')return false
 if(!record(value.periods)||!validPeriod(value.periods.current)||!validPeriod(value.periods.previous))return false
 return Array.isArray(value.gaps)&&value.gaps.length<=20004&&value.gaps.every(gap=>record(gap)&&['memory','usage'].includes(String(gap.metric))&&instant(gap.from)&&instant(gap.to)&&Date.parse(gap.from)<=Date.parse(gap.to))
}
async function boundedJson(response:Response):Promise<unknown>{
 if(Number(response.headers.get('Content-Length'))>LIMIT)throw Error('oversized')
 if(!response.body)throw Error('empty')
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
 try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>LIMIT){await reader.cancel();throw Error('oversized')}chunks.push(next.value)}}finally{reader.releaseLock()}
 const buffer=new Uint8Array(size);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length}
 return JSON.parse(new TextDecoder().decode(buffer))
}
/** Fixed backend-only peer. No client-selected origin, redirects, URL token or cache. */
export function createPlatformStatisticsMemoryReader(env:NodeJS.ProcessEnv=process.env,fetchImpl:typeof fetch=fetch):MemoryReader|undefined{
 if(env.PLATFORM_STATS_ENABLED!=='true')return undefined
 const token=env.PLATFORM_STATS_INTERNAL_TOKEN??''
 if(token.length<32||token.length>4096||/[\r\n]/.test(token))return undefined
 let base:URL
 try{base=new URL(env.PLATFORM_STATS_MEMORY_BASE_URL??'')}catch{return undefined}
 if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||base.pathname!=='/')return undefined
 return async bounds=>{
  try{
   const url=new URL('/internal/platform-statistics',base)
   for(const key of ['from','to','previousFrom','previousTo'] as const)url.searchParams.set(key,bounds[key])
   if(bounds.excludeInstallationIds?.length){if(bounds.excludeInstallationIds.length>1000||!bounds.excludeInstallationIds.every(id=>uuid.test(id)))throw Error('invalid exclusions');url.searchParams.set('excludeInstallationIds',bounds.excludeInstallationIds.join(','))}
   const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)})
   if(response.status!==200)throw Error('upstream')
   const result=await boundedJson(response)
   if(!validSnapshot(result))throw Error('invalid snapshot')
   return result
  }catch{throw new Error('memory_statistics_unavailable')}
 }
}
