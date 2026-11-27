import pg from 'pg'
import {failureRetentionSettings,previewFailureRetention} from './dead-letters.js'

async function main() {
  const [scope,at,id,...extra]=process.argv.slice(2)
  if(scope==='--help') {
    console.log('Usage: failure:preview INSTALLATION_UUID|global ["CURSOR_TIMESTAMP" CURSOR_UUID]. Reads one bounded page from MEMORY_DATABASE_URL.')
    return
  }
  const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
  if(!scope || (scope!=='global'&&!uuid.test(scope)) || Boolean(at)!==Boolean(id)
    || (at&&(!Number.isFinite(Date.parse(at))||!uuid.test(id))) || extra.length) {
    throw Error('expected_scope_and_optional_cursor')
  }
  if(!process.env.MEMORY_DATABASE_URL) throw Error('missing_database')
  const settings=failureRetentionSettings()
  const pool=new pg.Pool({connectionString:process.env.MEMORY_DATABASE_URL,max:1,connectionTimeoutMillis:5000,
    options:'-c search_path=pg_catalog,memory,shared -c default_transaction_read_only=on -c statement_timeout=5000'})
  try {
    const page=await previewFailureRetention(pool,scope==='global'?null:scope,settings,at?{at,id}:undefined)
    const counts:Record<string,number>={}
    for(const row of page) counts[row.reason]=(counts[row.reason]??0)+1
    console.log(JSON.stringify({scope,counts,failures:page.map(({failureId,jobId,reason})=>({failureId,jobId,reason})),
      next_cursor:page.length===settings.batchSize?page.at(-1)?.nextCursor:null},null,2))
  }finally{await pool.end()}
}
main().catch(()=>{console.error('Failure retention preview requires a scope (installation UUID or global) and an optional cursor timestamp and UUID. Verify the Memory database connection and schema.');process.exitCode=1})
