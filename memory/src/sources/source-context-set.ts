import type pg from 'pg'
import {canonicalJsonString,type SourceScope,type SourceRoot,type SourceVersion} from '@pocketctl/session-source'
import {JobDeferredError,JobTerminalError} from '../jobs/types.js'
import {createObservedSourceReader} from './observed-reader.js'
import {sameDerivedSourceVersion} from './derived-version.js'
export interface SourceContext {cursorKey:string;scope:SourceScope;version:SourceVersion;mode:'shared-shadow'|'shared-active';state:string}
export interface SourceContextSet {scanId:string;controlRevision:string;workRevision:string;contexts:SourceContext[]}
type ContextPurpose='current-content'|'personal-projection'
const notReady=()=>new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
/** A seal covers every principal for the installation. Fetch metadata in
 * bounded pages; compare the complete count and seal again after enumeration. */
export async function loadSourceContextSet(pool:Pick<pg.Pool,'query'>,installationId:string,root:SourceRoot,expectedScan?:string,purpose:ContextPurpose='current-content'):Promise<SourceContextSet>{
 const projection=purpose==='personal-projection'&&root.kind==='relay_event'
 const metadata=async()=>(await pool.query('SELECT shared.current_memory_source_distribution($1,$2,$3) AS seal',[root.kind,root.key,installationId])).rows[0].seal
 const seal=await metadata()
 if(seal&&expectedScan!==undefined&&seal.scanId!==expectedScan)throw new JobTerminalError('source_context_set_changed')
 if(!seal||!/^\d+$/.test(seal.targetCount)||BigInt(seal.targetCount)<1n||BigInt(seal.targetCount)>512n)throw notReady()
 if(seal.contentPending===true&&!projection)throw notReady()
 const contexts:SourceContext[]=[];let cursor=''
 for(let n=0;n<5;n++){
  let result:pg.QueryResult
  try{result=await pool.query('SELECT * FROM shared.read_memory_source_context_set($1,$2,$3,$4,$5,128)',[root.kind,root.key,seal.scanId,installationId,cursor])}
  catch(error){
   const failure=error as {code?:unknown;message?:unknown}|null
   // The earlier seal can legitimately become unready before this page. No
   // contexts from this incomplete enumeration may authorize output.
   if(projection&&failure?.code==='P0001'&&failure.message==='source_context_set_not_ready')throw notReady()
   throw error
  }
  const rows=result.rows
  for(const row of rows){
   if(typeof row.cursor_key!=='string'||Buffer.compare(Buffer.from(row.cursor_key),Buffer.from(cursor))<=0||row.source_scope?.installationId!==installationId)throw notReady()
   cursor=row.cursor_key
   contexts.push({cursorKey:cursor,scope:row.source_scope,version:row.source_version,mode:row.target_mode,state:row.state})
  }
  if(rows.length<128)break
 }
 const finalSeal=await metadata()
 // A writer may change only pending content during scope enumeration. Never
 // adopt another scan/control revision or claim that its newest content is ready.
 const scopeSeal=(value:typeof seal)=>value&&projection?{...value,contentPending:undefined}:value
 if(BigInt(contexts.length)!==BigInt(seal.targetCount)||canonicalJsonString(scopeSeal(finalSeal))!==canonicalJsonString(scopeSeal(seal)))throw notReady()
 return {scanId:seal.scanId,controlRevision:seal.controlRevision,workRevision:seal.workRevision,contexts}
}
/** A metadata seal is not an authorization grant. Every retained context
 * crosses the same current authority reader before source/body work. */
export async function checkSourceContextSet(pool:pg.Pool,root:SourceRoot,set:SourceContextSet,purpose:ContextPurpose='current-content'):Promise<SourceContext[]>{
 const reader=createObservedSourceReader(pool),currentContexts:SourceContext[]=[]
 for(const context of set.contexts){
  // These sealed negative targets are retained for invalidation only. They
  // never grant positive admission and must not strand other principals.
  if(context.state==='revoked'||context.state==='deleted')continue
  if(context.state!=='current')throw notReady()
  // Inspect current body authority without resolving a body. Retained-output
  // authority has a different lifecycle and cannot grant this admission.
  const current=await reader.checkCurrent(context.scope,root)
  const projection=purpose==='personal-projection'&&root.kind==='relay_event'
  if(current.state!=='current'||(projection?current.version.authorization!==context.version.authorization:!sameDerivedSourceVersion(current.version,context.version)))throw notReady()
  // This exception admits only scope metadata, never an old body/vector. The
  // projector independently prepares current heads/bodies and exact commit
  // fences. Do not retarget the sealed observations to a newer content vector.
  currentContexts.push(projection?context:{...context,version:current.version})
 }
 if(!currentContexts.length)throw notReady()
 return currentContexts
}
export function requireSourceContext(set:SourceContextSet,scope:SourceScope,cursor?:string):void{
 if(!set.contexts.some(c=>c.state==='current'&&(cursor===undefined||c.cursorKey===cursor)&&canonicalJsonString(c.scope)===canonicalJsonString(scope)))throw notReady()
}
