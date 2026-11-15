import {it,expect} from 'vitest'
import pg from 'pg'
import {TeamRepository} from '../team/repository.js'
import {readTokenRows} from '../usage-analytics/token-repository.js'
import {initDB} from '../db.js'
const test=process.env.RUN_POSTGRES_INTEGRATION==='1'?it:it.skip
test('transactional binding and member periods close/reopen, reject overlap, preserve observation',async()=>{
 if(!process.env.TEST_DATABASE_URL?.includes('personal_usage_test'))throw Error('isolated_database_required')
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});let owner:number|undefined
 try{await initDB(pool);owner=(await pool.query("INSERT INTO users(email,password_hash) VALUES('history-'||clock_timestamp()||'@example.test','fixture') RETURNING id")).rows[0].id;const team='usage-team-'+owner,daemon='usage-team-daemon-'+owner
 await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES($1,$2)",[daemon,owner]);await pool.query("INSERT INTO collaboration_teams(team_id,name,creator_user_id) VALUES($1,'Fixture',$2)",[team,owner]);await pool.query("INSERT INTO collaboration_team_memberships(membership_id,team_id,user_id) VALUES($1,$2,$3)",['usage-member-'+owner,team,owner]);await pool.query('INSERT INTO collaboration_team_daemon_bindings(daemon_id,team_id,owner_user_id) VALUES($1,$2,$3)',[daemon,team,owner])
 await pool.query('DELETE FROM collaboration_team_daemon_bindings WHERE daemon_id=$1',[daemon]);await pool.query('INSERT INTO collaboration_team_daemon_bindings(daemon_id,team_id,owner_user_id) VALUES($1,$2,$3)',[daemon,team,owner]);const periods=(await pool.query('SELECT * FROM usage_team_binding_periods WHERE daemon_id=$1 ORDER BY from_at',[daemon])).rows;expect(periods).toHaveLength(2);expect(periods[0].to_exclusive).not.toBeNull();expect(periods[1].to_exclusive).toBeNull()
 await expect(pool.query(`INSERT INTO usage_team_binding_periods(team_id,owner_user_id,daemon_id,from_at,to_exclusive,source_revision,evidence) VALUES($1,$2,$3,$4,$5,1,'overlap')`,[team,owner,daemon,periods[0].from_at,new Date(+periods[1].from_at+1000)])).rejects.toMatchObject({code:'23P01'})
 await pool.query("UPDATE collaboration_team_memberships SET state='left' WHERE team_id=$1",[team]);await pool.query("UPDATE collaboration_team_memberships SET state='active' WHERE team_id=$1",[team]);expect((await pool.query('SELECT count(*)::int AS n FROM usage_team_membership_periods WHERE team_id=$1',[team])).rows[0].n).toBe(2)
 await pool.query('DELETE FROM collaboration_team_daemon_bindings WHERE daemon_id=$1',[daemon]);await pool.query('DELETE FROM collaboration_teams WHERE team_id=$1',[team]);await pool.query('DELETE FROM daemons WHERE daemon_id=$1',[daemon]);
 }finally{if(owner)await pool.query('DELETE FROM users WHERE id=$1',[owner]);await pool.end()}
},60000)

test('real multi-offer repository paths close only last binding; internal multiowner windows exclude unbound host and prebinding time',async()=>{
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});let owner:number|undefined,other:number|undefined,team:string|undefined
 try{await initDB(pool);const users=(await pool.query("INSERT INTO users(email,password_hash,team_enabled,plan) VALUES('offers-a-'||clock_timestamp()||'@example.test','fixture',true,'pro'),('offers-b-'||clock_timestamp()||'@example.test','fixture',true,'pro') RETURNING id")).rows;owner=users[0].id;other=users[1].id
 const d1='offers-d1-'+owner,d2='offers-d2-'+owner,d3='offers-d3-'+other;await pool.query(`INSERT INTO daemons(daemon_id,user_id,agents,status) VALUES($1,$2,'["codex","claude-code"]','offline'),($3,$2,'["codex"]','offline'),($4,$5,'["codex"]','offline')`,[d1,owner,d2,d3,other]);const repo=new TeamRepository(pool),created=await repo.createTeam({actorUserId:owner!,name:'Usage readiness',requestId:'create'});team=created.team.id
 const rev=async()=>Number((await pool.query('SELECT revision FROM collaboration_teams WHERE team_id=$1',[team])).rows[0].revision)
 const a=await repo.addAgentOffer({teamId:team!,actorUserId:owner!,daemonId:d1,provider:'codex',runtimeProfileId:null,expectedRevision:await rev(),requestId:'offer-codex'})
 const b=await repo.addAgentOffer({teamId:team!,actorUserId:owner!,daemonId:d1,provider:'claude-code',runtimeProfileId:null,expectedRevision:await rev(),requestId:'offer-claude'})
 await repo.revokeAgentOffer({offerId:a.id,actorUserId:owner!,expectedRevision:a.revision,requestId:'remove-one'});expect((await pool.query('SELECT count(*)::int AS n FROM usage_team_binding_periods WHERE daemon_id=$1 AND to_exclusive IS NULL',[d1])).rows[0].n).toBe(1)
 await repo.revokeAgentOffer({offerId:b.id,actorUserId:owner!,expectedRevision:b.revision,requestId:'remove-last'});expect((await pool.query('SELECT count(*)::int AS n FROM usage_team_binding_periods WHERE daemon_id=$1 AND to_exclusive IS NULL',[d1])).rows[0].n).toBe(0)
 await repo.addAgentOffer({teamId:team!,actorUserId:owner!,daemonId:d1,provider:'codex',runtimeProfileId:null,expectedRevision:await rev(),requestId:'rejoin'})
 expect((await pool.query('SELECT count(*)::int AS n FROM usage_team_binding_periods WHERE daemon_id=$1',[d1])).rows[0].n).toBe(2)
 for(const [o,d,id,at,total] of [[owner,d1,'before','2026-11-14T11:00:00Z',10],[owner,d1,'after','2026-11-14T13:00:00Z',20],[owner,d2,'unbound','2026-11-14T13:00:00Z',900],[other,d3,'member-b','2026-11-14T13:00:00Z',30]])await pool.query(`INSERT INTO usage_token_projection(owner_user_id,daemon_id,source_session,logical_usage_id,source_fact_key,agent_type,model,occurred_at,received_at,time_basis,input,output,cache_read,cache_create,total,quality) VALUES($1,$2,$3,$3,$3,'codex','fixture',$4,$4,'source',$5,0,0,0,$5,'normalized')`,[o,d,id,at,total])
 const scope={kind:'team' as const,actorUserId:owner!,authorizationRevision:'fixture-only',daemons:[],windows:[{ownerUserId:owner!,daemonId:d1,from:'2026-11-14T12:00:00Z',toExclusive:'2026-11-15T00:00:00Z'},{ownerUserId:other!,daemonId:d3,from:'2026-11-14T00:00:00Z',toExclusive:'2026-11-15T00:00:00Z'}]};const rows=await readTokenRows(pool,scope,{from:'2026-11-14T00:00:00Z',toExclusive:'2026-11-15T00:00:00Z',days:1});expect(rows.reduce((n,r)=>n+BigInt(r.total),0n)).toBe(50n)
 await repo.dissolveTeam({teamId:team!,actorUserId:owner!,expectedRevision:await rev(),requestId:'dissolve'});expect((await pool.query('SELECT count(*)::int AS n FROM usage_team_membership_periods WHERE team_id=$1 AND to_exclusive IS NULL',[team])).rows[0].n).toBe(0)
 }finally{if(team)await pool.query('DELETE FROM collaboration_teams WHERE team_id=$1',[team]);if(owner)await pool.query('DELETE FROM daemons WHERE user_id=ANY($1::int[])',[[owner,other]]);if(owner)await pool.query('DELETE FROM users WHERE id=ANY($1::int[])',[[owner,other]]);await pool.end()}
},60000)
