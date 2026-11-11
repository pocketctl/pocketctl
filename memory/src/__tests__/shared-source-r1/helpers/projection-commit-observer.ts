import type pg from 'pg'
/** Test-only observer of real positive physical COMMIT replies. It neither
 * dispatches SQL nor substitutes a post-job snapshot for intermediate pages. */
export function observeProjectionCommits(pool:pg.Pool,onCommit:(event:{installationId:string;rootKey:string;before:any;after:any})=>Promise<void>,errors:unknown[]){
 let active=true,callbacks:Promise<void>=Promise.resolve()
 const originalPoolQuery=pool.query
 const poolQuery=function(...args:any[]){
  const sql=typeof args[0]==='string'?args[0]:args[0]?.text??''
  if(active&&typeof args.at(-1)!=='function'&&/FROM memory_canonical_projection_progress\b/.test(sql))return callbacks.then(()=>(originalPoolQuery as any).apply(pool,args))
  return(originalPoolQuery as any).apply(pool,args)
 }as pg.Pool['query']
 pool.query=poolQuery
 const clients=new Map<pg.PoolClient,{original:pg.PoolClient['query'];wrapped:pg.PoolClient['query']}>()
 const acquire=(client:pg.PoolClient)=>{
  if(clients.has(client))return
  const original=client.query
  let prior:{key:string;value:any}|undefined,pending:{installationId:string;rootKey:string;before:any;after:any}|undefined
  const wrapped=async function(...args:any[]){
   const sql=typeof args[0]==='string'?args[0]:args[0]?.text??'',values=Array.isArray(args[1])?args[1]:args[0]?.values??[]
   const compact=sql.replace(/\s+/g,' ').trim()
   if(compact==='BEGIN'){prior=undefined;pending=undefined}
   let result:any
   try{result=await(original as any).apply(client,args)}catch(error){prior=undefined;pending=undefined;throw error}
   if(!active)return result
   if(compact.startsWith('SELECT source_version,next_cursor,state FROM memory_canonical_projection_progress')&&compact.endsWith('FOR UPDATE NOWAIT'))prior={key:JSON.stringify(values),value:structuredClone(result.rows[0]??null)}
   if(/^INSERT INTO memory_canonical_projection_progress\(/.test(compact)){
    if(!prior||prior.key!==JSON.stringify(values.slice(0,4))||pending)errors.push(Error('test_projection_commit_prior_missing'))
    else pending={installationId:values[0],rootKey:values[2],before:prior.value,after:{source_version:typeof values[4]==='string'?JSON.parse(values[4]):structuredClone(values[4]),next_cursor:values[5],state:values[6]}}
   }
   if(/^ROLLBACK\b/.test(compact)){prior=undefined;pending=undefined}
   if(compact==='COMMIT'){
    const event=pending;prior=undefined;pending=undefined
    if(result.command==='COMMIT'&&event)callbacks=callbacks.then(()=>onCommit(event)).catch(error=>{errors.push(error)})
   }
   return result
  }as pg.PoolClient['query']
  client.query=wrapped;clients.set(client,{original,wrapped})
 }
 pool.on('acquire',acquire)
 return async()=>{await callbacks;active=false;if(pool.query===poolQuery)pool.query=originalPoolQuery;pool.removeListener('acquire',acquire);for(const[client,{original,wrapped}]of clients)if(client.query===wrapped)client.query=original}
}
