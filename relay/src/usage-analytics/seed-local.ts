import pg from 'pg'
import {writeFile} from 'node:fs/promises'
import {initDB} from '../db.js'
import {signRefreshToken,signAccessToken} from '../auth.js'
import {EventMaterializer} from '../materialization/event-materializer.js'
const url=process.env.DATABASE_URL
if(!url?.includes('personal_usage_test'))throw Error('isolated_database_required')
const pool=new pg.Pool({connectionString:url,max:3})
try {
 await initDB(pool)
 let owner=(await pool.query("SELECT id FROM users WHERE email='personal-usage@example.test'")).rows[0]?.id
 if(!owner)owner=(await pool.query("INSERT INTO users(email,password_hash,display_name,plan) VALUES('personal-usage@example.test','fixture','Personal Usage QA','pro') RETURNING id")).rows[0].id
 await pool.query(`INSERT INTO daemons(daemon_id,user_id,hostname,status) VALUES('usage-fixture-mac',$1,'Fixture Mac','offline'),('usage-fixture-linux',$1,'Fixture Linux','offline') ON CONFLICT(daemon_id) DO NOTHING`,[owner])
 await pool.query(`INSERT INTO sessions(session_id,user_id,daemon_id,agent_type,model,title) VALUES('usage-fixture-session',$1,'usage-fixture-mac','claude-code','fixture-model','Personal usage synthetic fixture') ON CONFLICT(session_id) DO NOTHING`,[owner])
 const materializer=new EventMaterializer({pool,writeTokenUsageFacts:true})
 const now=new Date();let sent=0
 for(let day of [0,1,6,13,29,89,179,180,364,365]){
  const at=new Date(+now-day*86400000);at.setUTCHours(10,0,0,0)
  const id='usage-fixture-day-'+at.toISOString().slice(0,10)
  await materializer.materialize({inboxId:0,userId:owner,daemonId:'usage-fixture-mac',sessionId:'usage-fixture-session',eventType:'agent_text',receivedAt:now,context:{agentType:'claude-code'},payload:{event_id:day===0?id+'-revision2':id,session_id:'usage-fixture-session',text:'Synthetic usage fixture',agent:'claude-code',usage:{input_tokens:day===0?970:1000,output_tokens:200,cache_read_tokens:400,cache_create_tokens:50},usage_meta:{version:1,provider:'fixture',source_usage_id:id,revision:day===0?2:1,request_id:id,mode:'cumulative',occurred_at:at.toISOString(),model:day%2?'fixture-model-b':'fixture-model-a',agent_type:'claude-code',input_semantics:'includes_cache'}}});sent++
 }
 const childAt=new Date(now);childAt.setUTCHours(10,0,0,0)
 await materializer.materialize({inboxId:0,userId:owner,daemonId:'usage-fixture-mac',sessionId:'usage-fixture-session',eventType:'agent_text',receivedAt:now,context:{agentType:'claude-code'},payload:{event_id:'usage-child-'+childAt.toISOString().slice(0,10),session_id:'usage-fixture-session',is_subagent:true,agent_id:'fixture-child-agent',text:'Synthetic child usage',usage:{input_tokens:30,output_tokens:0,cache_read_tokens:0,cache_create_tokens:0},usage_meta:{version:1,provider:'fixture',source_usage_id:'child-'+childAt.toISOString().slice(0,10),revision:1,request_id:'usage-fixture-day-'+childAt.toISOString().slice(0,10),mode:'cumulative',occurred_at:childAt.toISOString(),model:'fixture-model-a',agent_type:'claude-code',input_semantics:'excludes_cache'}}})
 for(let i=0;i<10;i++)for(const phase of ['tool_call','tool_result']){
  await materializer.materialize({inboxId:0,userId:owner,daemonId:'usage-fixture-mac',sessionId:'usage-fixture-session',eventType:phase,receivedAt:now,context:{agentType:'claude-code'},payload:{event_id:'usage-call-'+i+'-'+phase,session_id:'usage-fixture-session',call_id:'call-'+i,tool:i<3?'mcp__fixture__read':'Read',call_meta:{version:1,invocation_id:'call-'+i,revision:phase==='tool_result'?1:0,tool_kind:i<3?'mcp':'builtin',tool_name:i===2?'mcp__fixture__read_with_a_very_long_name_for_layout_and_keyboard_acceptance_'+ 'long_'.repeat(24):i<3?'mcp__fixture__read':'Read',mcp_server:i<3?'fixture':undefined,occurred_at:now.toISOString(),outcome:phase==='tool_result'?(i===9?'failure':'success'):'unknown',evidence_kind:i===0?'native_skill_execution':'native_tool_lifecycle',skill_key:i===0?'fixture-skill':undefined,skill_name:i===0?'Fixture Skill':undefined}}})
 }
 const refresh=await signRefreshToken(owner,'personal-usage-fixture'),access=await signAccessToken(owner,'personal-usage@example.test',undefined,'personal-usage-fixture')
 await writeFile('../docs/reports/personal-usage-implementation/local-fixture-auth.json',JSON.stringify({owner,email:'personal-usage@example.test',refresh_token:refresh,access_token:access,relay:'http://127.0.0.1:18891',web:'http://127.0.0.1:18892',sent},null,2),{mode:0o600})
 console.log(JSON.stringify({owner,sent,fixture:'local-fixture-auth.json'}))
} finally {await pool.end()}
