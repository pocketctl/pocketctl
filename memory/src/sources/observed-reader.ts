import {protectSourceExecutionBodies} from './source-execution.js'
import type pg from 'pg'
import {createPostgresSharedSourceReader,SourceUnavailableError,type ArchiveReadStorage,type ArchiveLimits} from '@pocketctl/session-source'
import {sourcePoolContext} from './pool-context.js'
const observed=new Set(['listHeads','getHeads','resolveBodies','checkCurrent','checkAuthority'])
/** Instrument the Memory adapter only; the shared package stays independent. */
export function createObservedSourceReader(db:pg.Pool,archive?:{storage:ArchiveReadStorage;limits:ArchiveLimits}){
 const reader=createPostgresSharedSourceReader(db,archive),observer=sourcePoolContext(db).readerObserver
 return new Proxy(reader,{get(target,key){
  const value=Reflect.get(target,key,target)
  if(typeof value!=='function')return value
  const call=value.bind(target)
  if(typeof key!=='string'||!observed.has(key))return call
  return async(...args:any[])=>{
   try{
    // Historical cold headers may themselves require archive hydration.
    if(key==='listHeads'||key==='getHeads')await protectSourceExecutionBodies(db,args[0],args[1],async()=>{
     const current=await target.checkCurrent(args[0],args[1])
     if(current.state!=='current')throw new SourceUnavailableError(current.state)
     return current.version
    })
    if(key==='resolveBodies')await protectSourceExecutionBodies(db,args[0],args[1],args[3])
    const result=await call(...args)
    if(result?.state&&result.state!=='current')observer?.(key,args[1]?.kind??'other',result.state)
    return result
   }catch(error){observer?.(key,args[1]?.kind??'other',error instanceof SourceUnavailableError?error.code:'other');throw error}
  }
 }})
}
