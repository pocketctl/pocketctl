import {EventEmitter} from 'node:events'
import type pg from 'pg'
import {test,expect,vi} from 'vitest'
import {observeProjectionCommits} from './helpers/projection-commit-observer.js'
const prior='SELECT source_version,next_cursor,state FROM memory_canonical_projection_progress WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3 AND context_key=$4 FOR UPDATE NOWAIT'
const insert='INSERT INTO memory_canonical_projection_progress(installation_id,source_kind,root_key,context_key,source_version,next_cursor,state) VALUES($1,$2,$3,$4,$5,$6,$7)'
const args=['inst','relay_event','1:session','context'],version={metadataWave:{phase:'scanning',through:'200',after:'64'}}
function fixture(end='COMMIT',failCommit=false){
 const pool=Object.assign(new EventEmitter(),{query:vi.fn(async()=>({rows:[]}))})as unknown as pg.Pool,errors:unknown[]=[],events:any[]=[]
 const original=vi.fn(async(sql:string)=>{if(sql==='COMMIT'&&failCommit)throw Error('lost acknowledgement');return{rows:sql===prior?[{source_version:{old:true},next_cursor:'old',state:'scanning'}]:[],command:sql==='COMMIT'?end:sql.split(' ')[0]}})
 const client={query:original}as unknown as pg.PoolClient
 const close=observeProjectionCommits(pool,async event=>{events.push(event)},errors);pool.emit('acquire',client)
 const page=async()=>{await client.query('BEGIN');await client.query(prior,args);await client.query(insert,[...args,JSON.stringify(version),'new','scanning'])}
 const flush=()=>pool.query('SELECT state FROM memory_canonical_projection_progress')
 return{pool,client,original,events,errors,close,page,flush}
}
test('each real positive COMMIT reply retains its own locked before/after cursor',async()=>{
 const f=fixture();try{for(let n=0;n<3;n++){await f.page();await f.client.query('COMMIT')}await f.flush();expect(f.events).toHaveLength(3);expect(f.events.every(x=>x.before.next_cursor==='old'&&x.after.next_cursor==='new'&&x.after.source_version.metadataWave.through==='200')).toBe(true);expect(f.errors).toEqual([])}finally{await f.close()}
})
test.each(['ROLLBACK','ROLLBACK TO SAVEPOINT page'])('rollback %s never becomes a committed-page observation',async rollback=>{
 const f=fixture();try{await f.page();await f.client.query(rollback);await f.client.query('COMMIT');await f.flush();expect(f.events).toEqual([])}finally{await f.close()}
})
test('lost COMMIT acknowledgement and server ROLLBACK result never produce positive observations',async()=>{
 for(const[command,lost]of [['COMMIT',true],['ROLLBACK',false]]as const){const f=fixture(command,lost);try{await f.page();if(lost)await expect(f.client.query('COMMIT')).rejects.toThrow('lost acknowledgement');else await f.client.query('COMMIT');await f.flush();expect(f.events).toEqual([])}finally{await f.close()}}
})
test('missing locked before-state is a test error rather than inferred COMMIT proof',async()=>{
 const f=fixture();try{await f.client.query('BEGIN');await f.client.query(insert,[...args,JSON.stringify(version),'new','scanning']);await f.client.query('COMMIT');await f.flush();expect(f.events).toEqual([]);expect(f.errors).toHaveLength(1)}finally{await f.close()}
})
test('closing restores the existing pool and physical client methods',async()=>{
 const f=fixture();await f.close();expect(f.client.query).toBe(f.original);await f.page();await f.client.query('COMMIT');await f.flush();expect(f.events).toEqual([])
})
