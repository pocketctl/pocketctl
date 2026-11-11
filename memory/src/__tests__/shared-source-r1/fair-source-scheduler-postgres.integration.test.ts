import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {performance} from 'node:perf_hooks'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
const url=process.env.TASK24_DATABASE_URL,suite=url?describe:describe.skip,pause=(ms:number)=>new Promise(r=>setTimeout(r,ms))
suite('bounded fair scheduler uses real committed exact-token frontiers',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!);await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')},60000)
 afterAll(async()=>{await f?.close()})
 test('four same-installation roots keep old pending seals and all new committed revision delays below five seconds',async()=>{
  const base=await f.source(),inst=(await f.install(base,'retained_history')).inst.installation_id,sources=[]
  for(let n=0;n<4;n++){const source={...base,session:base.session+'-'+n};await f.publisher.query("INSERT INTO public.sessions(session_id,daemon_id,user_id,agent_type,source,status) VALUES($1,$2,$3,'codex','terminal','running')",[source.session,base.daemon,base.owner]);sources.push(source);await f.event(source);await f.event(source,true)}
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[inst])
  const roots=sources.map(s=>f.root(s)),observed:{root:string;revision:string;at:number}[]=[],originals=new Map<any,any>(),errors:unknown[]=[]
  const instrument=(client:any)=>{
   if(originals.has(client))return
   const original=client.query;originals.set(client,original);let explicit=false,pending:{root:string;revision:string}[]=[]
   client.query=function(...args:any[]){
    const sql=typeof args[0]==='string'?args[0]:args[0]?.text??'',values=Array.isArray(args[1])?args[1]:args[0]?.values??[]
    const done=(error:any,result:any)=>{
     if(error){pending=[];return}
     if(sql==='BEGIN'){explicit=true;pending=[];return}
     if(sql==='ROLLBACK'){explicit=false;pending=[];return}
     if(sql==='COMMIT'){if(result.command==='COMMIT')observed.push(...pending.map(x=>({...x,at:performance.now()})));explicit=false;pending=[];return}
     let rows:{root:string;revision:string}[]=[]
     if(sql.includes('shared.claim_memory_source_work('))rows=(result.rows??[]).map((r:any)=>({root:r.root_key,revision:String(r.claimed_revision)}))
     if(sql.includes('shared.step_memory_source_distribution(')&&result.rows[0]?.result?.waiting===true)rows=[{root:values[1],revision:result.rows[0].result.claimedRevision}]
     if(explicit)pending.push(...rows);else observed.push(...rows.map(x=>({...x,at:performance.now()})))
    }
    const last=args.length-1,callback=typeof args[last]==='function'?args[last]:null
    if(callback){args[last]=(e:any,r:any)=>{done(e,r);callback(e,r)};return original.apply(client,args)}
    const result=original.apply(client,args);return result?.then?result.then((r:any)=>{done(null,r);return r},(e:any)=>{done(e,null);throw e}):result
   }
  }
  f.runtime.on('acquire',instrument)
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'task24-fair-native',signal:new AbortController().signal,onError:e=>errors.push(e)}),commits:{root:string;revision:string;at:number}[]=[]
  try{
   scheduler.start();const setupDeadline=performance.now()+10000
   while(Number((await f.pool.query('SELECT count(*)::int AS n FROM shared.memory_source_distributions WHERE root_key=ANY($1::text[]) AND dispatch_complete',[roots])).rows[0].n)!==4){if(performance.now()>setupDeadline)throw Error('fair_initial_dispatch_timeout');await pause(20)}
   const seal=async()=>(await f.pool.query('SELECT to_jsonb(d) AS row,d.xmin::text FROM shared.memory_source_distributions d WHERE root_key=ANY($1::text[]) ORDER BY root_key',[roots])).rows
   const oldSeals=await seal()
   // Initial enumeration ACK legitimately clears its lease/attempt before the
   // first new dirty claim. Establish all four actual live waiting tokens first;
   // only then freeze attempt/processed/token preservation for measured writes.
   for(const source of sources)await f.event(source)
   const primingDeadline=performance.now()+5000
   while(Number((await f.pool.query('SELECT count(*)::int AS n FROM shared.memory_source_work WHERE root_key=ANY($1::text[]) AND lease_owner=$2 AND claimed_revision=revision AND lease_until>clock_timestamp()',[roots,'task24-fair-native'])).rows[0].n)!==4){if(performance.now()>primingDeadline)throw Error('fair_waiting_priming_timeout');await pause(20)}
   const oldWork=(await f.pool.query('SELECT root_key,attempt,processed_revision::text,lease_token::text FROM shared.memory_source_work WHERE root_key=ANY($1::text[]) ORDER BY root_key',[roots])).rows
   // No JobWorker runs: every exact old projection job remains genuinely pending.
   for(let round=0;round<8;round++){
    const began=performance.now()
    for(const source of sources){await f.event(source,round%2===1);const root=f.root(source),revision=(await f.pool.query('SELECT revision::text FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0].revision;commits.push({root,revision,at:performance.now()})}
    await pause(Math.max(0,1000-(performance.now()-began)))
   }
   const deadline=performance.now()+5000
   while(commits.some(c=>!observed.some(o=>o.root===c.root&&o.at>=c.at&&BigInt(o.revision)>=BigInt(c.revision)))){if(performance.now()>deadline)throw Error('fair_native_frontier_timeout');await pause(20)}
   const delays=commits.map(c=>observed.find(o=>o.root===c.root&&o.at>=c.at&&BigInt(o.revision)>=BigInt(c.revision))!.at-c.at).sort((a,b)=>a-b)
   expect(delays).toHaveLength(32);expect(delays.at(-1)).toBeLessThanOrEqual(5000);expect(await seal()).toEqual(oldSeals)
   expect((await f.pool.query('SELECT root_key,attempt,processed_revision::text,lease_token::text FROM shared.memory_source_work WHERE root_key=ANY($1::text[]) ORDER BY root_key',[roots])).rows).toEqual(oldWork)
   expect((await f.pool.query("SELECT count(*)::int AS n FROM memory.memory_jobs WHERE job_type='project_shared_source' AND state='pending' AND payload->'root'->>'key'=ANY($1::text[])",[roots])).rows[0].n).toBe(4)
   expect(errors).toEqual([]);console.log(JSON.stringify({task24:'four-root-native-committed-claim',samples:delays.length,p95Ms:delays[Math.ceil(delays.length*.95)-1],maxMs:delays.at(-1),immutableSeals:true,pendingProjectionJobs:4}))
  }finally{await scheduler.stop();f.runtime.off('acquire',instrument);for(const [client,query]of originals)client.query=query}
 },25000)
})
