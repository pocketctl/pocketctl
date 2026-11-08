import {describe,test,expect} from 'vitest'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
/** Incremental, strictly assigned, rollback-only. The preceding full-target
 * suite creates an API-born group with a deliberate unused sequence gap. */
suite('Task8 native original core before first Memory projection',()=>{
 const cases=[
  ['selected same-text content WRITE',true,'content'],['selected reply timestamp change',true,'time'],
  ['request-id support no-op',false,'request'],['native-source-ID support no-op',false,'source'],
  ['actual duplicate INSERT DO NOTHING',false,'dedup'],['late selected reply',true,'reply-before'],
  ['late nonselected reply',false,'reply-after'],['new selected latest status',true,'status-after'],
  ['nonselected older status',false,'status-before'],['nonselected reply becomes selected',true,'move-before'],
  ['selected reply becomes nonselected',true,'move-after'],['call intrinsic context change',true,'call-core'],
  ['call cheap clock touch',false,'call-clock'],
 ] as const
 test.each(cases)('%s consumes exactly its original key before any semantic ref exists',async(_name,retired,operation)=>{
  if(!value)throw Error('explicit_task8_fixture_required')
  const config=JSON.parse(value),url=new URL(config.databaseUrl)
  if(!/^task8_team_semantic_consumer_(red|green|retry1|retry2|retry3)_test$/.test(url.pathname.slice(1))||url.hostname!=='127.0.0.1')throw Error('exact_task8_fixture_required')
  const pool=new pg.Pool({connectionString:url.href,max:1,statement_timeout:5000,lock_timeout:1000}),client=await pool.connect()
  try{
   expect((await client.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]).toEqual(config.expected)
   await client.query('BEGIN')
   const original=(await client.query(`SELECT p.original_business_key,c.event_id,c.call_id,c.team_session_id,c.offer_id,
    (SELECT event_id FROM public.collaboration_events e WHERE e.call_id=c.call_id AND e.kind='agent_message' ORDER BY event_seq LIMIT 1) AS reply_id,
    (SELECT event_seq::text FROM public.collaboration_events e WHERE e.call_id=c.call_id AND e.kind='status' ORDER BY event_seq DESC LIMIT 1) AS boundary
    FROM public.native_team_semantic_publications p JOIN public.collaboration_calls c ON c.call_id=p.call_id
    WHERE p.source_kind='team_collaboration' AND NOT p.retired AND p.publication_xid IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.collaboration_events e WHERE e.team_session_id=c.team_session_id AND e.event_seq=(SELECT o.event_seq-1 FROM public.collaboration_events o WHERE o.call_id=c.call_id AND o.kind='status' ORDER BY o.event_seq DESC LIMIT 1))
     AND NOT EXISTS(SELECT 1 FROM memory.source_events s WHERE s.source_kind='team_semantic' AND s.source_provenance->'native'->>'team_call_id'=c.call_id)
    ORDER BY p.original_business_key LIMIT 1`)).rows[0]
   expect(original).toBeTruthy()
   const event='task8-core-'+randomUUID(),insert=async(kind:string,seq:bigint)=>client.query(`INSERT INTO public.collaboration_events(event_id,team_session_id,event_seq,kind,author_offer_id,call_id,content) VALUES($1,$2,$3::bigint,$4,$5,$6,$7)`,[event,original.team_session_id,String(seq),kind,original.offer_id,original.call_id,kind==='status'?'completed':'Synthetic late core reply'])
   const boundary=BigInt(original.boundary)
   if(operation==='content')await client.query('UPDATE public.collaboration_events SET content=content WHERE event_id=$1',[original.event_id])
   if(operation==='time')await client.query("UPDATE public.collaboration_events SET created_at=created_at+interval '1 microsecond' WHERE event_id=$1",[original.reply_id])
   if(operation==='request')await client.query('UPDATE public.collaboration_events SET request_id=request_id WHERE event_id=$1',[original.event_id])
   if(operation==='source')await client.query('UPDATE public.collaboration_events SET native_source_event_id=native_source_event_id WHERE event_id=$1',[original.reply_id])
   if(operation==='dedup')await client.query(`INSERT INTO public.collaboration_events(event_id,team_session_id,event_seq,kind,author_offer_id,call_id,content)
    SELECT event_id,team_session_id,event_seq,kind,author_offer_id,call_id,'Conflicting replacement is never inserted' FROM public.collaboration_events WHERE event_id=$1 ON CONFLICT DO NOTHING`,[original.reply_id])
   if(operation==='reply-before')await insert('agent_message',boundary-1n)
   if(operation==='reply-after')await insert('agent_message',boundary+1n)
   if(operation==='status-after')await insert('status',boundary+1n)
   if(operation==='status-before')await insert('status',boundary-1n)
   if(operation==='move-before'){await insert('agent_message',boundary+1n);await client.query('UPDATE public.collaboration_events SET event_seq=$2::bigint WHERE event_id=$1',[event,String(boundary-1n)])}
   if(operation==='move-after')await client.query('UPDATE public.collaboration_events SET event_seq=$2::bigint WHERE event_id=$1',[original.reply_id,String(boundary+1n)])
   if(operation==='call-core')await client.query('UPDATE public.collaboration_calls SET context_version=context_version+1 WHERE call_id=$1',[original.call_id])
   if(operation==='call-clock')await client.query("UPDATE public.collaboration_calls SET updated_at=updated_at+interval '1 microsecond' WHERE call_id=$1",[original.call_id])
   expect((await client.query("SELECT retired,publication_xid IS NULL AS scrubbed FROM public.native_team_semantic_publications WHERE source_kind='team_collaboration' AND business_key_hash=sha256(convert_to(jsonb_build_array('team_collaboration'::text,$1::text)::text,'UTF8'))",[original.original_business_key])).rows[0]).toEqual({retired,scrubbed:retired})
  }finally{await client.query('ROLLBACK').catch(()=>undefined);client.release();await pool.end()}
 })
})
