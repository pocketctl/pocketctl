import type pg from 'pg'
/** Owner-scoped, bounded, resumable. Dry-run never writes or reads body text. */
export async function backfillUsage(db:Pick<pg.Pool,'query'>,owner:number,options:{limit?:number;dryRun?:boolean;asOf?:Date;after?:string}={}){
 const limit=Math.min(1000,Math.max(1,options.limit??200)),asOf=options.asOf??new Date()
 if(options.dryRun===false&&!(await db.query('SELECT write_enabled FROM usage_analytics_state')).rows[0]?.write_enabled)throw Error('usage_projection_write_disabled')
 const cursor=options.after??(await db.query('SELECT cursor FROM usage_backfill_checkpoints WHERE owner_user_id=$1',[owner])).rows[0]?.cursor??''
 const rows=(await db.query(`SELECT fact_key,source_event_id,usage_date::text AS usage_date FROM token_usage_facts WHERE user_id=$1 AND fact_key>$2 AND usage_date>=($3::timestamptz AT TIME ZONE 'UTC')::date-364 AND usage_date<=($3::timestamptz AT TIME ZONE 'UTC')::date ORDER BY fact_key LIMIT $4`,[owner,cursor,asOf,limit])).rows
 const report={owner,cursor,next_cursor:rows.at(-1)?.fact_key??cursor,candidates:rows.length,legacy_identity_only:rows.filter(r=>r.source_event_id===null).length,dry_run:options.dryRun!==false}
 if(options.dryRun!==false||!rows.length)return report
 await db.query('SELECT usage_project_token_fact(f) FROM token_usage_facts f WHERE user_id=$1 AND fact_key=ANY($2::text[])',[owner,rows.map(r=>r.fact_key)])
 await db.query(`INSERT INTO usage_backfill_checkpoints(owner_user_id,cursor) VALUES($1,$2) ON CONFLICT(owner_user_id) DO UPDATE SET cursor=EXCLUDED.cursor,updated_at=NOW()`,[owner,report.next_cursor])
 return report
}
