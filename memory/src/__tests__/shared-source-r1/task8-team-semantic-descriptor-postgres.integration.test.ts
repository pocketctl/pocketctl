import {describe,test,expect} from 'vitest'
import pg from 'pg'
import {randomUUID,randomBytes} from 'node:crypto'
import {TEAM_SEMANTIC_MIGRATION} from '../../sources/team-semantic-migration.js'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
const base={normalization:'team-semantic-v1',businessDigest:'a'.repeat(64),originalSupportDigest:'b'.repeat(64)}
const cases:[string,string,unknown,boolean][]=[
 ['normalization JSON null','team_semantic',{...base,normalization:null},false],
 ['missing normalization','team_semantic',{businessDigest:base.businessDigest,originalSupportDigest:base.originalSupportDigest},false],
 ['extra key','team_semantic',{...base,content:'1'},false],['future normalization','team_semantic',{...base,normalization:'team-semantic-v2'},false],
 ['nonstring normalization','team_semantic',{...base,normalization:1},false],['oversize normalization','team_semantic',{...base,normalization:'x'.repeat(1024)},false],
 ['null business digest','team_semantic',{...base,businessDigest:null},false],['noncanonical digest','team_semantic',{...base,businessDigest:'A'.repeat(64)},false],
 ['exact semantic descriptor','team_semantic',base,true],['raw decimals','relay_event',{content:'0',authorization:'1',storage:'9223372036854775807'},true],
 ['raw bigint overflow','relay_event',{content:'9223372036854775808',authorization:'1',storage:'1'},false],
 ['raw cannot use semantic descriptor','relay_event',base,false],['semantic cannot use raw decimal clocks','team_semantic',{content:'1',authorization:'1',storage:'1'},false],
]
suite('Task8 database semantic descriptor has a separate exact whitelist',()=>{
 test.each(cases)('%s',async(_name,kind,version,valid)=>{
  if(!value)throw Error('explicit_task8_fixture_required')
  const config=JSON.parse(value),u=new URL(config.databaseUrl)
  if(!/^task8_team_semantic_consumer_(retry1|retry2|retry3)_test$/.test(u.pathname.slice(1))||u.hostname!=='127.0.0.1')throw Error('exact_task8_fixture_required')
  const pool=new pg.Pool({connectionString:u.href,max:1,statement_timeout:5000,lock_timeout:1000}),client=await pool.connect()
  try{
   expect((await client.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]).toEqual(config.expected)
   await client.query('BEGIN')
   if(process.env.TASK8_DESCRIPTOR_RED_RANGE_PREVIEW==='1'){
    // Existing retry1 has the first descriptor CHECK but still the unrelated
    // raw-only range CHECK. Preview ONLY its already-approved replacement in
    // this rollback window, so NULL cannot be hidden by that other refusal.
    expect(config.expected.database).toBe('task8_team_semantic_consumer_retry1_test')
    for(const sql of TEAM_SEMANTIC_MIGRATION.statements.filter(s=>s.startsWith('ALTER TABLE source_events')&&s.includes('CONSTRAINT source_events_verified_version_range')))await client.query(sql.replaceAll('ALTER TABLE source_events','ALTER TABLE memory.source_events'))
   }
   const installation=(await client.query('SELECT installation_id FROM memory.memory_installations ORDER BY installation_id LIMIT 1')).rows[0].installation_id
   const id=randomUUID(),key=randomBytes(32).toString('hex'),hash=randomBytes(32)
   const insert=client.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,classification,payload,payload_hash,
    source_provenance,source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
    VALUES($1,$2,'canonical',$3,$3,NULL,'user_goal',clock_timestamp(),'{}',NULL,$4,$5::jsonb,$6,$7,$3,$8::jsonb,$4,'canonical-json-sha256-v1','verified',$9)`,
    [id,installation,'task8-descriptor-'+id,hash,JSON.stringify({source_kind:'team_semantic',source_version:1}),kind,key,JSON.stringify(version),kind==='team_semantic'?'team-semantic-v1':'canonical-ref-v1'])
   if(valid)expect((await insert).rowCount).toBe(1)
   else await expect(insert).rejects.toMatchObject({code:'23514'})
  }finally{await client.query('ROLLBACK').catch(()=>undefined);client.release();await pool.end()}
 })
})
